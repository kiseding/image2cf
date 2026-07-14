import {
	CreateUserSchema,
	DeleteUserSchema,
	UpdateUserSchema,
	adminService,
} from "@/server/service/admin";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { type Env, authMiddleware, ok } from "../util";

const app = new Hono<Env>()
	.basePath("/admin")
	.use(authMiddleware)
	.post("/getMe", async (c) => {
		const user = c.var.user!;
		return c.json(ok(await adminService.getMe({ userId: user.id })));
	})
	.post("/listUsers", async (c) => {
		const user = c.var.user!;
		return c.json(ok(await adminService.listUsers({ userId: user.id })));
	})
	.post("/createUser", zValidator("json", CreateUserSchema), async (c) => {
		const user = c.var.user!;
		const req = c.req.valid("json");
		return c.json(ok(await adminService.createUser(req, { userId: user.id })));
	})
	.post("/updateUser", zValidator("json", UpdateUserSchema), async (c) => {
		const user = c.var.user!;
		const req = c.req.valid("json");
		return c.json(ok(await adminService.updateUser(req, { userId: user.id })));
	})
	.post("/deleteUser", zValidator("json", DeleteUserSchema), async (c) => {
		const user = c.var.user!;
		const req = c.req.valid("json");
		return c.json(ok(await adminService.deleteUser(req, { userId: user.id })));
	});

export default app;
