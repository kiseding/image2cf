import app from "./api";
import { createDb } from "./db";
import { readWorkerEnv } from "./lib/worker-env";
import { cleanupRateLimits } from "./lib/distributed-rate-limit";
import { processClaimedGeneration, recoverStaleGenerations } from "./service/chat";
import { initContext, type GenerationQueueMessage } from "./service/context";
import { purgeExpiredR2Objects, resolveRetentionDays } from "./service/file/retention";

export type WorkerEnv = {
	DB: D1Database;
	AI?: Ai;
	R2?: R2Bucket;
	GENERATION_QUEUE?: Queue<GenerationQueueMessage>;
	R2_RETENTION_DAYS?: string;
	FILE_STORAGE?: string;
	DEBUG?: string;
	[key: string]: unknown;
};

const worker = {
	async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
		return app.fetch(request, env, ctx);
	},

	async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(
			(async () => {
				try {
					const db = await createDb(env.DB);
					const recovered = await recoverStaleGenerations(db);
					console.log("[generation] stale recovery done", { recovered: recovered.length });
					await cleanupRateLimits(env.DB);

					if (controller.cron === "0 3 * * *") {
						const e = readWorkerEnv(env as any);
						const R2 = e.R2 || env.R2;
						if (!R2) return;
						const result = await purgeExpiredR2Objects({
							R2,
							db,
							retentionDays: resolveRetentionDays({
								R2_RETENTION_DAYS: e.raw?.R2_RETENTION_DAYS || env.R2_RETENTION_DAYS,
							}),
						});
						console.log("[retention] purge done", result);
					}
				} catch (err) {
					console.error("[cron] lifecycle maintenance failed", err);
				}
			})(),
		);
	},

	async queue(batch: MessageBatch<GenerationQueueMessage>, env: WorkerEnv): Promise<void> {
		const db = await createDb(env.DB);
		const e = readWorkerEnv(env as any);
		initContext({
			db,
			AI: env.AI,
			R2: env.R2,
			providerCloudflareBuiltin: e.PROVIDER_CLOUDFLARE_BUILTIN === "true",
			fileStorage: e.FILE_STORAGE || (env.R2 ? "r2" : "base64"),
			credentialsSecret: e.CREDENTIALS_SECRET || e.BETTER_AUTH_SECRET || e.ADMIN_PASSWORD,
			generationQueue: env.GENERATION_QUEUE,
		});
		for (const message of batch.messages) {
			try {
				await processClaimedGeneration(message.body, { userId: message.body.userId, blockGenerate: true });
				message.ack();
			} catch (error) {
				console.error("[generation] queue consumer failed", { id: message.id, error });
				message.retry({ delaySeconds: 30 });
			}
		}
	},
};

export default worker;
