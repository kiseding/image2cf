import { account, user } from "@/server/db/schemas";
import { readWorkerEnv } from "@/server/lib/worker-env";
import { and, eq, or } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type Env, ok } from "../util";

async function assertSetupAccess(c: Context<Env>) {
	const firstUser = await c.var.db.query.user.findFirst();
	if (!firstUser) return { firstSetup: true };

	if (!c.var.user) {
		throw new HTTPException(401, { message: "Authentication required" });
	}
	const currentUser = await c.var.db.query.user.findFirst({
		where: eq(user.id, c.var.user.id),
	});
	if (!currentUser || currentUser.role !== "admin" || currentUser.banned) {
		throw new HTTPException(403, { message: "Admin access required" });
	}
	return { firstSetup: false };
}

const app = new Hono<Env>()
	.basePath("/setup")
	.get("/status", async (c) => {
		const access = await assertSetupAccess(c);
		const e = readWorkerEnv(c.env as any);
		const userCount = (await c.var.db.query.user.findMany()).length;
		const admin = await c.var.db.query.user.findFirst({
			where: or(eq(user.username, "admin"), eq(user.role, "admin")),
		});
		const credential = admin
			? await c.var.db.query.account.findFirst({
					where: and(eq(account.userId, admin.id), eq(account.providerId, "credential")),
				})
			: null;

		return c.json(
			ok({
				firstSetup: access.firstSetup,
				hasAdminPasswordEnv: !!e.ADMIN_PASSWORD,
				userCount,
				admin: admin
					? {
							username: admin.username || "admin",
							role: admin.role,
							hasPassword: !!credential?.password,
						}
					: null,
			}),
		);
	})
	.post("/bootstrap", async (c) => {
		await assertSetupAccess(c);
		const e = readWorkerEnv(c.env as any);
		const { bootstrapAdmin } = await import("@/server/service/admin/bootstrap");
		await bootstrapAdmin(c.var.db, {
			ADMIN_PASSWORD: e.ADMIN_PASSWORD,
			ADMIN_NAME: e.ADMIN_NAME,
			DB: c.env.DB,
		});
		const admin = await c.var.db.query.user.findFirst({
			where: or(eq(user.username, "admin"), eq(user.role, "admin")),
		});
		return c.json(ok({ initialized: !!admin }));
	});

export default app;
