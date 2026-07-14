import {
	COMMON_IMAGE_MODELS,
	guessImageModelMeta,
	isLikelyImageModel,
	normalizeRelayBaseURL,
	type RelayProtocol,
} from "@/server/ai/provider/relay-presets";
import { userRelays } from "@/server/db/schemas";
import { ServiceException } from "@/server/lib/exception";
import { and, desc, eq } from "drizzle-orm";
import z from "zod/v4";
import { type RequestContext, getContext } from "../context";

const RelayModelSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	// optional legacy field — routing no longer depends on it
	ability: z.enum(["t2i", "i2i"]).optional(),
	maxInputImages: z.number().int().min(1).max(16).default(4),
	supportedAspectRatios: z.array(z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"])).optional(),
});

export type RelayModel = z.infer<typeof RelayModelSchema>;

const EndpointsSchema = z.object({
	/** 文生图 */
	t2i: z.string().min(1).default("/images/generations"),
	/** 图生图（有引用/上传图时） */
	i2i: z.string().min(1).default("/images/edits"),
	/** 编辑图片（局部编辑等同 edits；可配不同 path） */
	edit: z.string().min(1).default("/images/edits"),
});

export const CreateRelaySchema = z.object({
	name: z.string().min(1).max(64),
	type: z.enum(["openai", "google"]).default("openai"),
	baseURL: z.string().url(),
	apiKey: z.string().min(1),
	models: z.array(RelayModelSchema).min(1),
	/** OpenAI: endpoints(推荐) | auto | images | responses */
	apiMode: z.enum(["auto", "images", "responses", "endpoints"]).default("endpoints"),
	endpoints: EndpointsSchema.optional(),
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
	apiMode: z.enum(["auto", "images", "responses", "endpoints"]).optional(),
	endpoints: EndpointsSchema.optional(),
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
		apiMode: (r as any).apiMode || "endpoints",
		endpoints: (r as any).endpoints || null,
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
		apiMode: (row as any).apiMode || "endpoints",
		endpoints: (row as any).endpoints || {
			t2i: "/images/generations",
			i2i: "/images/edits",
			edit: "/images/edits",
		},
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
			apiMode: req.type === "openai" ? req.apiMode || "endpoints" : "auto",
			endpoints:
				req.endpoints ||
				(req.type === "openai"
					? { t2i: "/images/generations", i2i: "/images/edits", edit: "/images/edits" }
					: null),
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
			...(req.apiMode !== undefined ? { apiMode: req.apiMode } : {}),
			...(req.endpoints !== undefined ? { endpoints: req.endpoints } : {}),
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
				totalFromApi: 0,
				suggestedModels: COMMON_IMAGE_MODELS.openai,
			};
		}
		const rawList: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
		const allMapped: RelayModel[] = rawList
			.map((m) => {
				const id = String(m.id || m.name || "").trim();
				if (!id) return null;
				const name = String(m.name || m.id || id);
				const meta = guessImageModelMeta(id, name);
				return { id, name, ...meta } as RelayModel;
			})
			.filter(Boolean) as RelayModel[];
		// NEVER dump chat LLMs into the image product — only keep image-like models
		const models = allMapped.filter((m) => isLikelyImageModel(m.id, m.name));

		return {
			ok: true as const,
			status: resp.status,
			message: models.length
				? `OK · found ${models.length} image model(s) (of ${allMapped.length} total)`
				: `OK · connected, but /models has ${allMapped.length} entries and none look like image models. Use “常用生图模型” or paste Model IDs from docs.`,
			baseURL,
			models,
			totalFromApi: allMapped.length,
			suggestedModels: COMMON_IMAGE_MODELS.openai,
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
			const allMapped: RelayModel[] = rawList
				.map((m) => {
					const full = String(m.name || m.id || "");
					const id = full.replace(/^models\//, "").trim();
					if (!id) return null;
					const name = id;
					const meta = guessImageModelMeta(id, name);
					return { id, name, ...meta } as RelayModel;
				})
				.filter(Boolean) as RelayModel[];
			const models = allMapped.filter((m) => isLikelyImageModel(m.id, m.name));
			return {
				ok: true as const,
				status: resp.status,
				message: models.length
					? `OK · found ${models.length} image model(s) (of ${allMapped.length} total)`
					: `OK · connected, but no image models in list (${allMapped.length} total). Use common image models or paste IDs.`,
				baseURL: root,
				models,
				totalFromApi: allMapped.length,
				suggestedModels: COMMON_IMAGE_MODELS.google,
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
		totalFromApi: 0,
		suggestedModels: COMMON_IMAGE_MODELS.google,
	};
};

/** Return built-in common image model IDs for a protocol (not tied to a vendor station) */
const getCommonImageModels = async (req: { type: RelayProtocol }, _ctx: RequestContext) => {
	return COMMON_IMAGE_MODELS[req.type] || [];
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
			// ability always i2i so UI allows reference images; actual route is by has-images
			ability: "i2i" as const,
			maxInputImages: m.maxInputImages || 4,
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
			_relay: {
				id: r.id,
				type: r.type,
				baseURL: r.baseURL,
				apiKey: r.apiKey,
				apiMode: (r as any).apiMode || "endpoints",
				endpoints: (r as any).endpoints || null,
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
		apiMode: ((row as any).apiMode || "endpoints") as "auto" | "images" | "responses" | "endpoints",
		endpoints: (row as any).endpoints || {
			t2i: "/images/generations",
			i2i: "/images/edits",
			edit: "/images/edits",
		},
	};
};

class RelayService {
	listRelays = listRelays;
	getRelayById = getRelayById;
	createRelay = createRelay;
	updateRelay = updateRelay;
	deleteRelay = deleteRelay;
	probeRelay = probeRelay;
	getCommonImageModels = getCommonImageModels;
	getEnabledRelaysAsProviders = getEnabledRelaysAsProviders;
	resolveRelayForGeneration = resolveRelayForGeneration;
}

export const relayService = new RelayService();
