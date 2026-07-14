import { Hono } from "hono";
import { env } from "hono/adapter";
import { bootstrapAdmin } from "@/server/service/admin/bootstrap";
import { usernameToEmail } from "@/server/lib/auth";
import { type Env, ok } from "../util";

/**
 * Public diagnostics for first-time setup (no secrets returned).
 */
const app = new Hono<Env>().basePath("/setup").get("/status", async (c) => {
	const e = { ...(env(c) as any), ...(c.env as any) };
	const d1 = c.env.DB;
	const hasPassword = !!(e.ADMIN_PASSWORD && String(e.ADMIN_PASSWORD).trim());
	let userCount = 0;
	let admin: any = null;
	let error: string | null = null;

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
				note: "UI username maps to email admin@local.image2cf",
			},
			error,
		}),
	);
});

// Force re-run bootstrap (useful after setting ADMIN_PASSWORD)
app.post("/bootstrap", async (c) => {
	const e = { ...(env(c) as any), ...(c.env as any) };
	const { bootstrapAdmin: boot, resetBootstrapFlag } = await import("@/server/service/admin/bootstrap");
	resetBootstrapFlag();
	await boot(c.var.db, e);
	return c.json(ok({ ok: true }));
});

export default app;
