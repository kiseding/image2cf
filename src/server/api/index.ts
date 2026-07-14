import { createFactory } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { Resend } from "resend";
import { createDb } from "../db";
import { type AuthConfig, createAuth } from "../lib/auth";
import { ServiceException } from "../lib/exception";
import { readWorkerEnv } from "../lib/worker-env";
import { bootstrapAdmin } from "../service/admin/bootstrap";
import { initContext } from "../service/context";
import adminRouter from "./routes/admin";
import aiRouter from "./routes/ai";
import chatsRouter from "./routes/chat";
import fileRouter from "./routes/file";
import loginRouter from "./routes/login";
import relayRouter from "./routes/relay";
import debugRouter from "./routes/debug";
import setupRouter from "./routes/setup";
import userRouter from "./routes/settings";
import type { ApiResult, Env } from "./util";

let adminBootstrapDone = false;

const factory = createFactory<Env>({
	initApp: async (app) => {
		app.use(async (c, next) => {
			const db = await createDb(c.env.DB);
			// Direct property access — do not spread c.env (secrets are non-enumerable)
			const e = readWorkerEnv(c.env as any);
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
				cookieDomain: e.COOKIE_DOMAIN || undefined,
				disableSignUp: true,
			};

			c.set("db", db);
			c.set(
				"auth",
				createAuth(db, {
					...authConfig,
					// Reuse ADMIN_PASSWORD as signing secret fallback so cookies are stable
					// Prefer dedicated BETTER_AUTH_SECRET when provided
					secret: (c.env as any).BETTER_AUTH_SECRET || e.ADMIN_PASSWORD || undefined,
				}),
			);
			// Make FILE_STORAGE visible to storage resolver (Workers have no process.env by default)
			if (e.FILE_STORAGE) {
				(process.env as any).FILE_STORAGE = e.FILE_STORAGE;
			} else if (e.R2) {
				(process.env as any).FILE_STORAGE = "r2";
			}

			initContext({
				db,
				AI: c.env.AI,
				R2: e.R2 || (c.env as any).R2,
				resend: authConfig.email.verification
					? {
							instance: new Resend(authConfig.email.resend.apiKey),
							from: authConfig.email.resend.from,
						}
					: undefined,
				providerCloudflareBuiltin: e.PROVIDER_CLOUDFLARE_BUILTIN === "true" || false,
				debug: e.DEBUG === "true",
				fileStorage: e.FILE_STORAGE || (e.R2 ? "r2" : "base64"),
			});

			if (!adminBootstrapDone) {
				await bootstrapAdmin(db, {
					ADMIN_PASSWORD: e.ADMIN_PASSWORD,
					ADMIN_NAME: e.ADMIN_NAME,
					DB: c.env.DB,
				});
				adminBootstrapDone = true;
			}
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
	.route("/", setupRouter)
	.route("/", loginRouter)
	.route("/", chatsRouter)
	.route("/", userRouter)
	.route("/", aiRouter)
	.route("/", fileRouter)
	.route("/", adminRouter)
	.route("/", relayRouter)
	.route("/", debugRouter);

export type AppType = typeof route;
export default app;
