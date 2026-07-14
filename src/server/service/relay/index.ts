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
			baseURL: req.baseURL,
			apiKey: req.apiKey,
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

	await db
		.update(userRelays)
		.set({
			...(req.name !== undefined ? { name: req.name } : {}),
			...(req.type !== undefined ? { type: req.type } : {}),
			...(req.baseURL !== undefined ? { baseURL: req.baseURL } : {}),
			...(req.apiKey !== undefined ? { apiKey: req.apiKey } : {}),
			...(req.models !== undefined ? { models: req.models } : {}),
			...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
			updatedAt: new Date().toISOString(),
		})
		.where(eq(userRelays.id, req.id));

	return true;
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
	getEnabledRelaysAsProviders = getEnabledRelaysAsProviders;
	resolveRelayForGeneration = resolveRelayForGeneration;
}

export const relayService = new RelayService();
