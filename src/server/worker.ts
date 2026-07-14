import app from "./api";
import { createDb } from "./db";
import { readWorkerEnv } from "./lib/worker-env";
import { purgeExpiredR2Objects, resolveRetentionDays } from "./service/file/retention";

export type WorkerEnv = {
	DB: D1Database;
	AI?: Ai;
	R2?: R2Bucket;
	R2_RETENTION_DAYS?: string;
	FILE_STORAGE?: string;
	DEBUG?: string;
	[key: string]: unknown;
};

const worker = {
	async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
		return app.fetch(request, env, ctx);
	},

	/**
	 * Daily cleanup: delete R2 object bytes older than R2_RETENTION_DAYS (default 30).
	 * D1 file rows and /api/files/preview/:id links are kept permanently.
	 */
	async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
		const e = readWorkerEnv(env as any);
		const R2 = e.R2 || env.R2;
		if (!R2) {
			console.log("[retention] no R2 binding, skip");
			return;
		}
		const retentionDays = resolveRetentionDays({
			R2_RETENTION_DAYS: e.raw?.R2_RETENTION_DAYS || env.R2_RETENTION_DAYS,
		});

		ctx.waitUntil(
			(async () => {
				try {
					const db = env.DB ? await createDb(env.DB) : undefined;
					const result = await purgeExpiredR2Objects({
						R2,
						db,
						retentionDays,
						maxScan: 2000,
					});
					console.log("[retention] purge done", result);
				} catch (err) {
					console.error("[retention] purge failed", err);
				}
			})(),
		);
	},
};

export default worker;
