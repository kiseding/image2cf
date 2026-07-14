import {
	guessImageModelMeta,
	isLikelyImageModel,
	normalizeRelayBaseURL,
} from "@/server/ai/provider/relay-presets";
import { userRelays } from "@/server/db/schemas";
import { ServiceException } from "@/server/lib/exception";
import { and, desc, eq } from "drizzle-orm";
import z from "zod/v4";
import { type RequestContext, getContext } from "../context";

const RelayModelSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	ability: z.enum(["t2i", "i2i"]).default("i2i"),
	maxInputImages: z.number().int().min(1).max(10).default(1),
	supportedAspectRatios: z.array(z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"])).optional(),
});

export type RelayModel = z.infer<typeof RelayModelSchema>;

export const CreateRelaySchema = z.object({
	name: z.string().min(1).max(64),
	type: z.enum(["openai", "google"]).default("openai"),
	baseURL: z.string().url(),
	apiKey: z.string().min(1),
	models: z.array(RelayModelSchema).min(1),
	enabled: z.boolean().default(true),
});
export type CreateRelay = z.infer<typeof CreateRelaySchema>;

export const UpdateRelaySchema = z.object({
	id: z.string(),
	name: z.string().min(1).max(64).optional(),
	type: z.enum(["openai", "google"]).optional(),
	baseURL: z.string().url().optional(),
	apiKey: z.string().min(1).optional(),
	models: z.array(RelayModelSchema).min(1).optional(),
	enabled: z.boolean().optional(),
});
export type UpdateRelay = z.infer<typeof UpdateRelaySchema>;

export const DeleteRelaySchema = z.object({
	id: z.string(),
});
export type DeleteRelay = z.infer<typeof DeleteRelaySchema>;

export const GetRelayByIdSchema = z.object({
	id: z.string(),
});
export type GetRelayById = z.infer<typeof GetRelayByIdSchema>;

/** Probe a relay without saving — list models / connectivity */
export const ProbeRelaySchema = z.object({
	type: z.enum(["openai", "google"]).default("openai"),
	baseURL: z.string().url(),
	apiKey: z.string().min(1),
});
export type ProbeRelay = z.infer<typeof ProbeRelaySchema>;

const listRelays = async (ctx: RequestContext) => {
	const { db } = getContext();
	const rows = await db.query.userRelays.findMany({
		where: eq(userRelays.userId, ctx.userId),
		orderBy: [desc(userRelays.createdAt)],
	});
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		type: r.type,
		baseURL: r.baseURL,
		// mask api key for list view
		apiKey: r.apiKey ? `${r.apiKey.slice(0, 4)}****${r.apiKey.slice(-4)}` : "",
		hasApiKey: !!r.apiKey,
		models: (r.models as RelayModel[]) || [],
		enabled: r.enabled,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
	}));
};

const getRelayById = async (req: GetRelayById, ctx: RequestContext) => {
	const { db } = getContext();
	const row = await db.query.userRelays.findFirst({
		where: and(eq(userRelays.id, req.id), eq(userRelays.userId, ctx.userId)),
	});
	if (!row) {
		throw new ServiceException("not_found", "Relay not found");
	}
	return {
		id: row.id,
		name: row.name,
		type: row.type,
		baseURL: row.baseURL,
		apiKey: row.apiKey,
		models: (row.models as RelayModel[]) || [],
		enabled: row.enabled,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
};

const createRelay = async (req: CreateRelay, ctx: RequestContext) => {
	const { db } = getContext();
	const [row] = await db
		.insert(userRelays)
		.values({
			userId: ctx.userId,
			name: req.name,
			type: req.type,
			baseURL: normalizeRelayBaseURL(req.type, req.baseURL),
			apiKey: req.apiKey.trim(),
			models: req.models,
			enabled: req.enabled,
		})
		.returning();
	return { id: row!.id };
};

const updateRelay = async (req: UpdateRelay, ctx: RequestContext) => {
	const { db } = getContext();
	const existing = await db.query.userRelays.findFirst({
		where: and(eq(userRelays.id, req.id), eq(userRelays.userId, ctx.userId)),
	});
	if (!existing) {
		throw new ServiceException("not_found", "Relay not found");
	}

	const nextType = (req.type ?? existing.type) as "openai" | "google";
	await db
		.update(userRelays)
		.set({
			...(req.name !== undefined ? { name: req.name } : {}),
			...(req.type !== undefined ? { type: req.type } : {}),
			...(req.baseURL !== undefined ? { baseURL: normalizeRelayBaseURL(nextType, req.baseURL) } : {}),
			...(req.apiKey !== undefined ? { apiKey: req.apiKey.trim() } : {}),
			...(req.models !== undefined ? { models: req.models } : {}),
			...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
			updatedAt: new Date().toISOString(),
		})
		.where(eq(userRelays.id, req.id));

	return true;
};

/**
 * Test connectivity and optionally pull model list from the relay.
 * Generic: works for any OpenAI-compatible /models or Google list endpoint.
 */
const probeRelay = async (req: ProbeRelay, _ctx: RequestContext) => {
	const type = req.type;
	const baseURL = normalizeRelayBaseURL(type, req.baseURL);
	const apiKey = req.apiKey.trim();

	if (type === "openai") {
		const url = `${baseURL.replace(/\/+$/, "")}/models`;
		const resp = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
		});
		const text = await resp.text();
		let json: any = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* ignore */
		}
		if (!resp.ok) {
			return {
				ok: false as const,
				status: resp.status,
				message: json?.error?.message || json?.message || text.slice(0, 200) || `HTTP ${resp.status}`,
				baseURL,
				models: [] as RelayModel[],
			};
		}
		const rawList: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
		const models: RelayModel[] = rawList
			.map((m) => {
				const id = String(m.id || m.name || "").trim();
				if (!id) return null;
				const name = String(m.id || m.name || id);
				// Image product: only keep image-generation models when auto-fetching
				if (!isLikelyImageModel(id, name)) return null;
				const meta = guessImageModelMeta(id, name);
				return { id, name, ...meta } as RelayModel;
			})
			.filter(Boolean) as RelayModel[];

		return {
			ok: true as const,
			status: resp.status,
			message: models.length
				? `OK · ${models.length} image models`
				: "OK · connected (no image models auto-detected; add Model IDs manually)",
			baseURL,
			models,
		};
	}

	// Google-compatible: try listing models
	const root = baseURL.replace(/\/+$/, "");
	const candidates = [
		`${root}/v1beta/models`,
		`${root}/v1/models`,
	];
	let lastErr = "unreachable";
	for (const url of candidates) {
		try {
			const resp = await fetch(url, {
				method: "GET",
				headers: {
					"x-goog-api-key": apiKey,
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
			});
			const text = await resp.text();
			let json: any = null;
			try {
				json = JSON.parse(text);
			} catch {
				/* ignore */
			}
			if (!resp.ok) {
				lastErr = json?.error?.message || json?.message || `HTTP ${resp.status}`;
				continue;
			}
			const rawList: any[] = Array.isArray(json?.models) ? json.models : [];
			const models: RelayModel[] = rawList
				.map((m) => {
					const full = String(m.name || m.id || "");
					const id = full.replace(/^models\//, "").trim();
					if (!id) return null;
					const name = id;
					if (!isLikelyImageModel(id, name)) return null;
					const meta = guessImageModelMeta(id, name);
					return { id, name, ...meta } as RelayModel;
				})
				.filter(Boolean) as RelayModel[];
			return {
				ok: true as const,
				status: resp.status,
				message: models.length
					? `OK · ${models.length} image models`
					: "OK · connected (no image models auto-detected; add Model IDs manually)",
				baseURL: root,
				models,
			};
		} catch (e: any) {
			lastErr = e?.message || String(e);
		}
	}
	return {
		ok: false as const,
		status: 0,
		message: lastErr,
		baseURL: root,
		models: [] as RelayModel[],
	};
};

const deleteRelay = async (req: DeleteRelay, ctx: RequestContext) => {
	const { db } = getContext();
	const existing = await db.query.userRelays.findFirst({
		where: and(eq(userRelays.id, req.id), eq(userRelays.userId, ctx.userId)),
	});
	if (!existing) {
		throw new ServiceException("not_found", "Relay not found");
	}
	await db.delete(userRelays).where(eq(userRelays.id, req.id));
	return true;
};

/** Build virtual providers from user relays for model selector */
const getEnabledRelaysAsProviders = async (ctx: RequestContext) => {
	const { db } = getContext();
	const rows = await db.query.userRelays.findMany({
		where: and(eq(userRelays.userId, ctx.userId), eq(userRelays.enabled, true)),
		orderBy: [desc(userRelays.createdAt)],
	});

	return rows.map((r) => {
		const models = ((r.models as RelayModel[]) || []).map((m) => ({
			id: m.id,
			name: m.name,
			ability: m.ability || "i2i",
			maxInputImages: m.maxInputImages || 1,
			enabledByDefault: true,
			enabled: true,
			supportedAspectRatios: m.supportedAspectRatios,
		}));
		return {
			id: `relay:${r.id}`,
			name: r.name,
			type: r.type,
			enabled: true,
			models,
			// settings used internally for generation
			_relay: {
				id: r.id,
				type: r.type,
				baseURL: r.baseURL,
				apiKey: r.apiKey,
			},
		};
	});
};

/** Resolve relay config for generation by virtual provider id `relay:<id>` */
const resolveRelayForGeneration = async (providerId: string, ctx: RequestContext) => {
	if (!providerId.startsWith("relay:")) {
		return null;
	}
	const relayId = providerId.slice("relay:".length);
	const { db } = getContext();
	const row = await db.query.userRelays.findFirst({
		where: and(eq(userRelays.id, relayId), eq(userRelays.userId, ctx.userId), eq(userRelays.enabled, true)),
	});
	if (!row) {
		throw new ServiceException("not_found", "Relay station not found or disabled");
	}
	return {
		id: row.id,
		name: row.name,
		type: row.type as "openai" | "google",
		baseURL: row.baseURL,
		apiKey: row.apiKey,
		models: (row.models as RelayModel[]) || [],
	};
};

class RelayService {
	listRelays = listRelays;
	getRelayById = getRelayById;
	createRelay = createRelay;
	updateRelay = updateRelay;
	deleteRelay = deleteRelay;
	probeRelay = probeRelay;
	getEnabledRelaysAsProviders = getEnabledRelaysAsProviders;
	resolveRelayForGeneration = resolveRelayForGeneration;
}

export const relayService = new RelayService();
