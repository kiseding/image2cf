import { env } from "hono/adapter";
import { createFactory } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { Resend } from "resend";
import { createDb } from "../db";
import { type AuthConfig, createAuth } from "../lib/auth";
import { ServiceException } from "../lib/exception";
import { bootstrapAdmin } from "../service/admin/bootstrap";
import { initContext } from "../service/context";
import adminRouter from "./routes/admin";
import aiRouter from "./routes/ai";
import chatsRouter from "./routes/chat";
import fileRouter from "./routes/file";
import relayRouter from "./routes/relay";
import userRouter from "./routes/settings";
import type { ApiResult, Env } from "./util";

const factory = createFactory<Env>({
	initApp: async (app) => {
		app.use(async (c, next) => {
			const db = await createDb(c.env.DB);
			// env(c) are both compatible with Cloudflare Workers(wrangler.toml) and Node.js(.env)
			const e = env(c);
			const authConfig: AuthConfig = {
				email: {
					verification: e.AUTH_EMAIL_VERIFICATION_ENABLED === "true",
					resend: {
						apiKey: e.AUTH_EMAIL_RESEND_API_KEY || "",
						from: e.AUTH_EMAIL_RESEND_FROM || "",
					},
				},
				social: {
					google: {
						enabled: e.AUTH_SOCIAL_GOOGLE_ENABLED === "true",
						clientId: e.AUTH_SOCIAL_GOOGLE_CLIENT_ID || "",
						clientSecret: e.AUTH_SOCIAL_GOOGLE_CLIENT_SECRET || "",
					},
					github: {
						enabled: e.AUTH_SOCIAL_GITHUB_ENABLED === "true",
						clientId: e.AUTH_SOCIAL_GITHUB_CLIENT_ID || "",
						clientSecret: e.AUTH_SOCIAL_GITHUB_CLIENT_SECRET || "",
					},
				},
				cookieDomain: e.COOKIE_DOMAIN ? String(e.COOKIE_DOMAIN) : undefined,
				disableSignUp: true,
			};

			c.set("db", db);
			c.set("auth", createAuth(db, authConfig));
			initContext({
				db,
				AI: c.env.AI,
				resend: authConfig.email.verification
					? {
							instance: new Resend(authConfig.email.resend.apiKey),
							from: authConfig.email.resend.from,
						}
					: undefined,
				providerCloudflareBuiltin: c.env.PROVIDER_CLOUDFLARE_BUILTIN === "true" || false,
			});

			// Always try bootstrap/repair admin (idempotent). Force password reset when ADMIN_FORCE_RESET=true.
			await bootstrapAdmin(db, e as any);
			await next();
		});
	},
});

const app = factory.createApp();

app.use(logger());

app.use("*", async (c, next) => {
	const session = await c.var.auth.api.getSession({
		headers: c.req.raw.headers,
	});

	if (!session) {
		c.set("user", null);
		c.set("session", null);
		return await next();
	}

	c.set("user", session.user as any);
	c.set("session", session.session as any);
	return await next();
});

app.on(["POST", "GET"], ["/api/auth/*"], (c) => c.var.auth.handler(c.req.raw));

app.onError((err, c) => {
	if (err instanceof HTTPException) {
		return c.json<ApiResult<unknown>>(
			{
				code: (() => {
					switch (err.status) {
						case 401:
							return "unauthorized";
						case 403:
							return "forbidden";
						case 404:
							return "not_found";
						default:
							return "error";
					}
				})(),
				message: err.message,
			},
			err.status,
		);
	}

	if (err instanceof ServiceException) {
		return c.json<ApiResult<unknown>>(
			{
				code: err.code,
				message: err.message,
			},
			200,
		);
	}

	console.error("Unhandled error:", err);
	return c.json<ApiResult<unknown>>({
		code: "error",
		message: "Internal Server Error",
	});
});

const route = app
	.basePath("/api")
	.route("/", chatsRouter)
	.route("/", userRouter)
	.route("/", aiRouter)
	.route("/", fileRouter)
	.route("/", adminRouter)
	.route("/", relayRouter);

export type AppType = typeof route;
export default app;
