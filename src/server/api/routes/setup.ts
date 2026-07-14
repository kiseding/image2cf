import { Hono } from "hono";
import { usernameToEmail } from "@/server/lib/auth";
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
		let bindingKeys: string[] = [];

		try {
			// Enumerated keys (secrets may not appear here — that's normal)
			bindingKeys = Object.keys(c.env || {});
		} catch {
			bindingKeys = [];
		}

		try {
			if (d1) {
				const cnt = await d1.prepare(`SELECT COUNT(*) as c FROM user`).first<{ c: number }>();
				userCount = Number(cnt?.c || 0);
				admin = await d1
					.prepare(
						`SELECT id, email, username, role,
              (SELECT COUNT(*) FROM account a WHERE a.user_id = user.id AND a.provider_id = 'credential' AND a.password IS NOT NULL) as has_password
             FROM user
             WHERE email = ? OR username = 'admin' OR role = 'admin'
             LIMIT 1`,
					)
					.bind(usernameToEmail("admin"))
					.first();
			}
		} catch (err: any) {
			error = err?.message || String(err);
		}

		return c.json(
			ok({
				hasAdminPasswordEnv: hasPassword,
				// true if direct access works even when not enumerable
				adminPasswordReadable: hasPassword,
				userCount,
				admin: admin
					? {
							id: admin.id,
							email: admin.email,
							username: admin.username,
							role: admin.role,
							hasPassword: Number(admin.has_password) > 0,
						}
					: null,
				loginHint: {
					username: "admin",
					passwordSource: "Worker Secret ADMIN_PASSWORD",
				},
				bindingKeysSample: bindingKeys.slice(0, 20),
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
