import { Hono } from "hono";
import { readWorkerEnv } from "@/server/lib/worker-env";
import { type Env, ok } from "../util";

/**
 * Public diagnostics for first-time setup (no secrets returned).
 */
const app = new Hono<Env>()
	.basePath("/setup")
	.get("/status", async (c) => {
		const e = readWorkerEnv(c.env as any);
		const d1 = c.env.DB;
		const hasPassword = !!e.ADMIN_PASSWORD;
		let userCount = 0;
		let admin: any = null;
		let error: string | null = null;

		try {
			if (d1) {
				const cnt = await d1.prepare(`SELECT COUNT(*) as c FROM user`).first<{ c: number }>();
				userCount = Number(cnt?.c || 0);
				admin = await d1
					.prepare(
						`SELECT id, username, role,
              (SELECT COUNT(*) FROM account a WHERE a.user_id = user.id AND a.provider_id = 'credential' AND a.password IS NOT NULL) as has_password
             FROM user
             WHERE username = 'admin' OR role = 'admin'
             LIMIT 1`,
					)
					.first();
			}
		} catch (err: any) {
			error = err?.message || String(err);
		}

		return c.json(
			ok({
				hasAdminPasswordEnv: hasPassword,
				userCount,
				admin: admin
					? {
							id: admin.id,
							username: admin.username || "admin",
							role: admin.role,
							hasPassword: Number(admin.has_password) > 0,
						}
					: null,
				loginHint: {
					username: "admin",
					passwordSource: "GitHub Secret ADMIN_PASSWORD",
				},
				error,
			}),
		);
	})
	.post("/bootstrap", async (c) => {
		const e = readWorkerEnv(c.env as any);
		const { bootstrapAdmin: boot, resetBootstrapFlag } = await import(
			"@/server/service/admin/bootstrap"
		);
		resetBootstrapFlag();
		await boot(c.var.db, {
			ADMIN_PASSWORD: e.ADMIN_PASSWORD,
			ADMIN_NAME: e.ADMIN_NAME,
			DB: c.env.DB,
		});
		return c.json(
			ok({
				ok: true,
				hasAdminPasswordEnv: !!e.ADMIN_PASSWORD,
			}),
		);
	});

export default app;
