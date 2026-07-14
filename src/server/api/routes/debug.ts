import { extractImagesFromAny } from "@/server/lib/image-parse";
import { readWorkerEnv } from "@/server/lib/worker-env";
import { getContext } from "@/server/service/context";
import { purgeExpiredR2Objects, resolveRetentionDays } from "@/server/service/file/retention";
import { getActiveStorageMode } from "@/server/service/file/storage";
import { eq, desc } from "drizzle-orm";
import { Hono } from "hono";
import { messageGenerations, files, userRelays } from "@/server/db/schemas";
import { type Env, ok } from "../util";

function debugEnabled(c: { env: any }): boolean {
	const e = readWorkerEnv(c.env);
	return e.DEBUG === "true";
}

function mask(s: string | null | undefined, keep = 4) {
	if (!s) return null;
	if (s.length <= keep * 2) return "***";
	return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

const app = new Hono<Env>()
	.basePath("/debug")
	.use(async (c, next) => {
		if (!debugEnabled(c)) {
			return c.json({ code: "forbidden", message: "Debug disabled. Set DEBUG=true env var." }, 403);
		}
		return next();
	})
	.get("/", async (c) => {
		const e = readWorkerEnv(c.env as any);
		const ctx = getContext();
		const retentionDays = resolveRetentionDays({ R2_RETENTION_DAYS: e.R2_RETENTION_DAYS });
		return c.json(
			ok({
				debug: true,
				time: new Date().toISOString(),
				mode: e.MODE || null,
				fileStorageEnv: e.FILE_STORAGE || null,
				fileStorageActive: getActiveStorageMode(),
				r2RetentionDays: retentionDays,
				r2Policy: "Links (D1 file id / preview URL) are permanent; object bytes purged after retention.",
				bindings: {
					DB: !!e.DB || !!c.env.DB,
					AI: !!e.AI || !!c.env.AI,
					R2: !!ctx.R2 || !!(c.env as any).R2,
				},
				flags: {
					PROVIDER_CLOUDFLARE_BUILTIN: e.PROVIDER_CLOUDFLARE_BUILTIN || null,
					hasAdminPassword: !!e.ADMIN_PASSWORD,
				},
				user: c.var.user
					? { id: c.var.user.id, name: c.var.user.name, role: c.var.user.role }
					: null,
			}),
		);
	})
	.get("/generations", async (c) => {
		const { db } = getContext();
		const limit = Math.min(Number(c.req.query("limit") || 20), 50);
		const rows = await db.query.messageGenerations.findMany({
			orderBy: [desc(messageGenerations.createdAt)],
			limit,
		});
		return c.json(
			ok(
				rows.map((g) => ({
					id: g.id,
					status: g.status,
					errorReason: g.errorReason,
					provider: g.provider,
					model: g.model,
					prompt: (g.prompt || "").slice(0, 120),
					fileIds: g.fileIds,
					parameters: g.parameters,
					generationTime: g.generationTime,
					createdAt: g.createdAt,
					updatedAt: g.updatedAt,
				})),
			),
		);
	})
	.get("/generations/:id", async (c) => {
		const { db } = getContext();
		const id = c.req.param("id");
		const g = await db.query.messageGenerations.findFirst({
			where: eq(messageGenerations.id, id),
		});
		if (!g) return c.json({ code: "not_found", message: "Generation not found" }, 404);

		const fileRows =
			Array.isArray(g.fileIds) && g.fileIds.length
				? await Promise.all(
						(g.fileIds as string[]).map(async (fid) => {
							const f = await db.query.files.findFirst({ where: eq(files.id, fid) });
							if (!f) return { id: fid, missing: true };
							return {
								id: f.id,
								storage: f.storage,
								urlPreview:
									f.url.startsWith("data:")
										? `data:…(${Math.round(f.url.length / 1024)}KB)`
										: f.url.startsWith("r2://")
											? f.url
											: f.url.slice(0, 120),
								urlLength: f.url.length,
								createdAt: f.createdAt,
							};
						}),
					)
				: [];

		return c.json(
			ok({
				generation: {
					id: g.id,
					status: g.status,
					errorReason: g.errorReason,
					provider: g.provider,
					model: g.model,
					prompt: g.prompt,
					fileIds: g.fileIds,
					parameters: g.parameters,
					generationTime: g.generationTime,
					createdAt: g.createdAt,
					updatedAt: g.updatedAt,
				},
				files: fileRows,
			}),
		);
	})
	.get("/relays", async (c) => {
		const { db } = getContext();
		const rows = await db.query.userRelays.findMany({
			orderBy: [desc(userRelays.createdAt)],
			limit: 50,
		});
		return c.json(
			ok(
				rows.map((r) => ({
					id: r.id,
					userId: r.userId,
					name: r.name,
					type: r.type,
					baseURL: r.baseURL,
					apiKey: mask(r.apiKey),
					apiMode: r.apiMode,
					endpoints: r.endpoints,
					enabled: r.enabled,
					models: r.models,
				})),
			),
		);
	})
	.post("/parse-images", async (c) => {
		// Feed a sample API JSON body; returns how many images we extract
		let body: any;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ code: "error", message: "Invalid JSON body" }, 400);
		}
		const images = await extractImagesFromAny(body, { preferUrl: true });
		return c.json(
			ok({
				count: images.length,
				samples: images.map((img) =>
					img.startsWith("data:")
						? { kind: "data-uri", length: img.length, mime: img.slice(5, img.indexOf(";")) }
						: { kind: "url", value: img.slice(0, 200) },
				),
			}),
		);
	})
	.get("/r2/list", async (c) => {
		const { R2 } = getContext();
		if (!R2) return c.json(ok({ configured: false, objects: [] }));
		const prefix = c.req.query("prefix") || "users/";
		const listed = await R2.list({ prefix, limit: 30 });
		const retentionDays = resolveRetentionDays({
			R2_RETENTION_DAYS: readWorkerEnv(c.env as any).R2_RETENTION_DAYS,
		});
		const cutoff = Date.now() - retentionDays * 86400000;
		return c.json(
			ok({
				configured: true,
				retentionDays,
				truncated: listed.truncated,
				objects: listed.objects.map((o) => {
					const uploaded = o.uploaded?.getTime?.() ?? 0;
					return {
						key: o.key,
						size: o.size,
						uploaded: o.uploaded,
						storedAt: o.customMetadata?.storedAt || null,
						expired: uploaded > 0 && uploaded < cutoff,
						httpMetadata: o.httpMetadata,
					};
				}),
			}),
		);
	})
	/** Manually run retention purge (same as daily cron) */
	.post("/r2/purge", async (c) => {
		const { R2, db } = getContext();
		if (!R2) return c.json({ code: "error", message: "R2 not configured" }, 400);
		const e = readWorkerEnv(c.env as any);
		const retentionDays = resolveRetentionDays({ R2_RETENTION_DAYS: e.R2_RETENTION_DAYS });
		const result = await purgeExpiredR2Objects({ R2, db, retentionDays, maxScan: 2000 });
		return c.json(ok(result));
	});

export default app;
