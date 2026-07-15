import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { DrizzleDb } from "../db";
import { user as userTable } from "../db/schemas";
import type { createAuth } from "../lib/auth";
import type { Code } from "../lib/exception";

type Auth = ReturnType<typeof createAuth>;

export type AuthUser = {
	id: string;
	name: string;
	email: string;
	emailVerified: boolean;
	image?: string | null;
	createdAt: Date;
	updatedAt: Date;
	role?: string;
	banned?: boolean;
};

export type AuthSession = {
	id: string;
	userId: string;
	token: string;
	expiresAt: Date;
	createdAt: Date;
	updatedAt: Date;
	ipAddress?: string | null;
	userAgent?: string | null;
};

export type Env = {
	Bindings: {
		DB: D1Database;
		AI: Ai;
		R2?: R2Bucket;
		GENERATION_QUEUE?: Queue;
		EMAIL: string;
		RESEND_APIKEY: string;
		PROVIDER_CLOUDFLARE_BUILTIN?: "true" | "false";
		// Admin bootstrap (set as Worker Secret in Dashboard)
		ADMIN_PASSWORD?: string;
		ADMIN_NAME?: string;
		BETTER_AUTH_SECRET?: string;
		CREDENTIALS_SECRET?: string;
		AUTH_EMAIL_VERIFICATION_ENABLED?: "true" | "false";
		AUTH_EMAIL_RESEND_API_KEY?: string;
		AUTH_EMAIL_RESEND_FROM?: string;
		AUTH_SOCIAL_GOOGLE_ENABLED?: "true" | "false";
		AUTH_SOCIAL_GOOGLE_CLIENT_ID?: string;
		AUTH_SOCIAL_GOOGLE_CLIENT_SECRET?: string;
		AUTH_SOCIAL_GITHUB_ENABLED?: "true" | "false";
		AUTH_SOCIAL_GITHUB_CLIENT_ID?: string;
		AUTH_SOCIAL_GITHUB_CLIENT_SECRET?: string;
		COOKIE_DOMAIN?: string;
		MODE?: string;
		FILE_STORAGE?: "base64" | "disk" | "r2";
		/** Days to keep R2 object bytes (default 30). DB links are permanent. */
		R2_RETENTION_DAYS?: string;
		/** Set to "true" to enable /api/debug/* */
		DEBUG?: "true" | "false" | string;
	};
	Variables: {
		db: DrizzleDb;
		auth: Auth;
		user: AuthUser | null;
		session: AuthSession | null;
	};
};

export const authMiddleware = createMiddleware<Env>(async (c, next) => {
	const user = c.var.user;

	if (!user) {
		throw new HTTPException(401, { message: "Authentication required" });
	}

	const currentUser = await c.var.db.query.user.findFirst({
		where: eq(userTable.id, user.id),
	});
	if (!currentUser) {
		throw new HTTPException(401, { message: "Authentication required" });
	}
	if (currentUser.banned) {
		throw new HTTPException(403, { message: "User is banned" });
	}
	c.set("user", currentUser as AuthUser);

	await next();
});

export interface ApiResult<T> {
	code: Code;
	data?: T;
	message?: string;
}

export function ok<T>(data?: T): ApiResult<T> {
	return { code: "ok", data };
}

export function error<T>(code: Code, message: string): ApiResult<T> {
	return { code, message };
}
