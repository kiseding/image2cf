import {
	CreateRelaySchema,
	DeleteRelaySchema,
	GetRelayByIdSchema,
	ProbeRelaySchema,
	UpdateRelaySchema,
	relayService,
} from "@/server/service/relay";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import z from "zod/v4";
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
	.post("/probeRelay", zValidator("json", ProbeRelaySchema), async (c) => {
		const user = c.var.user!;
		const req = c.req.valid("json");
		return c.json(ok(await relayService.probeRelay(req, { userId: user.id })));
	})
	.post(
		"/getCommonImageModels",
		zValidator(
			"json",
			z.object({
				type: z.enum(["openai", "google"]).default("openai"),
			}),
		),
		async (c) => {
			const user = c.var.user!;
			const req = c.req.valid("json");
			return c.json(ok(await relayService.getCommonImageModels(req, { userId: user.id })));
		},
	)
	.post("/getEnabledRelaysAsProviders", async (c) => {
		const user = c.var.user!;
		return c.json(ok(await relayService.getEnabledRelaysAsProviders({ userId: user.id })));
	});

export default app;
