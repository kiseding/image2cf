import {
	CreateRelaySchema,
	DeleteRelaySchema,
	GetRelayByIdSchema,
	UpdateRelaySchema,
	relayService,
} from "@/server/service/relay";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { type Env, authMiddleware, ok } from "../util";

const app = new Hono<Env>()
	.basePath("/relay")
	.use(authMiddleware)
	.post("/listRelays", async (c) => {
		const user = c.var.user!;
		return c.json(ok(await relayService.listRelays({ userId: user.id })));
	})
	.post("/getRelayById", zValidator("json", GetRelayByIdSchema), async (c) => {
		const user = c.var.user!;
		const req = c.req.valid("json");
		return c.json(ok(await relayService.getRelayById(req, { userId: user.id })));
	})
	.post("/createRelay", zValidator("json", CreateRelaySchema), async (c) => {
		const user = c.var.user!;
		const req = c.req.valid("json");
		return c.json(ok(await relayService.createRelay(req, { userId: user.id })));
	})
	.post("/updateRelay", zValidator("json", UpdateRelaySchema), async (c) => {
		const user = c.var.user!;
		const req = c.req.valid("json");
		return c.json(ok(await relayService.updateRelay(req, { userId: user.id })));
	})
	.post("/deleteRelay", zValidator("json", DeleteRelaySchema), async (c) => {
		const user = c.var.user!;
		const req = c.req.valid("json");
		return c.json(ok(await relayService.deleteRelay(req, { userId: user.id })));
	})
	.post("/getEnabledRelaysAsProviders", async (c) => {
		const user = c.var.user!;
		return c.json(ok(await relayService.getEnabledRelaysAsProviders({ userId: user.id })));
	});

export default app;
