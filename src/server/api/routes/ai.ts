import {
	GetAiModelsByProviderIdSchema,
	GetAiProviderByIdSchema,
	UpdateAiModelSchema,
	UpdateAiProviderSchema,
	aiService,
} from "@/server/service/ai";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { type Env, authMiddleware, ok } from "../util";

const app = new Hono<Env>()
	.basePath("/ai")
	.use(authMiddleware)
	.post("/getAiProviders", async (c) => {
		const user = c.var.user!;

		return c.json(ok(await aiService.getAiProviders({ userId: user.id })));
	})
	.post("/getAiProviderById", zValidator("json", GetAiProviderByIdSchema), async (c) => {
		const user = c.var.user!;
		const req = c.req.valid("json");

		return c.json(ok(await aiService.getAiProviderById(req, { userId: user.id })));
	})
	.post("/getEnabledAiProvidersWithModels", async (c) => {
		const user = c.var.user!;

		return c.json(ok(await aiService.getEnabledAiProvidersWithModels({ userId: user.id })));
	})
	.post("/updateAiProvider", zValidator("json", UpdateAiProviderSchema), async (c) => {
		const user = c.var.user!;
		const req = c.req.valid("json");

		return c.json(ok(await aiService.updateAiProvider(req, { userId: user.id })));
	})
	.post("/getAiModelsByProviderId", zValidator("json", GetAiModelsByProviderIdSchema), async (c) => {
		const user = c.var.user!;
		const req = c.req.valid("json");

		return c.json(ok(await aiService.getAiModelsByProviderId(req, { userId: user.id })));
	})
	.post("/updateAiModel", zValidator("json", UpdateAiModelSchema), async (c) => {
		const user = c.var.user!;
		const req = c.req.valid("json");

		return c.json(ok(await aiService.updateAiModel(req, { userId: user.id })));
	});

export default app;
