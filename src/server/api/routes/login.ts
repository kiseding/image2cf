import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { nanoid } from "nanoid";
import z from "zod/v4";
import { normalizeUsername, usernameToEmail } from "@/server/lib/auth";
import { hashPassword, verifyPassword } from "@/server/lib/password";
import { readWorkerEnv } from "@/server/lib/worker-env";
import { rateLimit } from "@/server/lib/rate-limit";
import { type Env, error } from "../util";

/**
 * Username + password login.
 * Path is /api/login (NOT under /api/auth/* which is owned by better-auth).
 */
const app = new Hono<Env>().basePath("/login").post(
	"/",
	zValidator(
		"json",
		z.object({
			username: z.string().min(1).max(64),
			password: z.string().min(1).max(128),
		}),
	),
	async (c) => {
		const { username, password } = c.req.valid("json");
		const uname = normalizeUsername(username);
		const d1 = c.env.DB;
		const auth = c.var.auth;
		const workerEnv = readWorkerEnv(c.env as any);
		const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
		const rl = rateLimit(`login:${ip}:${uname}`, 20, 60_000);
		if (!rl.ok) {
			return c.json(error("error", "Too many login attempts, try later"), 429);
		}

		if (!d1) {
			return c.json(error("error", "Database unavailable"), 500);
		}

		try {
			let user = await findUser(d1, uname);

			if (!user && uname === "admin" && workerEnv.ADMIN_PASSWORD && password === workerEnv.ADMIN_PASSWORD) {
				user = await ensureAdmin(d1, password, workerEnv.ADMIN_NAME || "Admin");
			}

			if (!user) {
				console.error("[image2cf] login user not found:", uname);
				return c.json(error("unauthorized", "Invalid username or password"), 401);
			}

			if (Number(user.banned) === 1) {
				return c.json(error("forbidden", "User is banned"), 403);
			}

			const account = await d1
				.prepare(
					`SELECT id, password FROM account WHERE user_id = ? AND provider_id = 'credential' LIMIT 1`,
				)
				.bind(user.id)
				.first<{ id: string; password: string | null }>();

			let valid = account?.password ? await verifyPassword(account.password, password) : false;

			// Emergency recovery: only when credential hash is missing (not a permanent dual password)
			const isAdmin = user.role === "admin" || uname === "admin";
			if (
				!valid &&
				isAdmin &&
				!account?.password &&
				workerEnv.ADMIN_PASSWORD &&
				password === workerEnv.ADMIN_PASSWORD
			) {
				await setCredentialPassword(d1, user.id, account?.id, password);
				await d1
					.prepare(
						`UPDATE user SET username = 'admin', email = ?, email_verified = 1, role = 'admin', banned = 0, updated_at = ? WHERE id = ?`,
					)
					.bind(usernameToEmail("admin"), Date.now(), user.id)
					.run();
				user = {
					...user,
					username: "admin",
					email: usernameToEmail("admin"),
					role: "admin",
				};
				valid = true;
				console.log("[image2cf] admin credential repaired from ADMIN_PASSWORD (empty hash)");
			}

			if (!valid) {
				console.error("[image2cf] login bad password for", user.id);
				return c.json(error("unauthorized", "Invalid username or password"), 401);
			}

			if (!user.username) {
				await d1.prepare(`UPDATE user SET username = ? WHERE id = ?`).bind(uname, user.id).run();
			}

			const session = await createDbSession(
				d1,
				user.id,
				c.req.header("user-agent"),
				c.req.header("cf-connecting-ip"),
			);
			const cookie = await buildSignedSessionCookie(auth, session.token);

			return new Response(
				JSON.stringify({
					code: "ok",
					data: {
						user: {
							id: user.id,
							name: user.name,
							username: user.username || uname,
							role: user.role || "user",
						},
					},
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
						"Set-Cookie": cookie,
					},
				},
			);
		} catch (e) {
			console.error("[image2cf] login error:", e);
			return c.json(error("error", "Login failed"), 500);
		}
	},
);

async function findUser(d1: D1Database, uname: string) {
	return d1
		.prepare(
			`SELECT id, name, email, username, role, banned
       FROM user
       WHERE lower(coalesce(username, '')) = ?
          OR (role = 'admin' AND ? = 'admin')
       LIMIT 1`,
		)
		.bind(uname, uname)
		.first<{
			id: string;
			name: string;
			email: string;
			username: string | null;
			role: string | null;
			banned: number | null;
		}>();
}

async function ensureAdmin(d1: D1Database, password: string, name: string) {
	const userId = nanoid();
	const email = usernameToEmail("admin");
	const hash = await hashPassword(password);
	const now = Date.now();
	await d1
		.prepare(
			`INSERT INTO user (id, name, email, email_verified, image, username, display_username, role, banned, created_at, updated_at)
       VALUES (?, ?, ?, 1, NULL, 'admin', ?, 'admin', 0, ?, ?)`,
		)
		.bind(userId, name, email, name, now, now)
		.run();
	await d1
		.prepare(
			`INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
		)
		.bind(nanoid(), userId, userId, hash, now, now)
		.run();
	return {
		id: userId,
		name,
		email,
		username: "admin",
		role: "admin",
		banned: 0,
	};
}

async function setCredentialPassword(
	d1: D1Database,
	userId: string,
	accountId: string | undefined,
	password: string,
) {
	const hash = await hashPassword(password);
	const now = Date.now();
	if (accountId) {
		await d1.prepare(`UPDATE account SET password = ?, updated_at = ? WHERE id = ?`).bind(hash, now, accountId).run();
	} else {
		await d1
			.prepare(
				`INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
         VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
			)
			.bind(nanoid(), userId, userId, hash, now, now)
			.run();
	}
}

async function createDbSession(d1: D1Database, userId: string, userAgent?: string | null, ip?: string | null) {
	const id = nanoid();
	const token = nanoid(32);
	const now = Date.now();
	const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
	await d1
		.prepare(
			`INSERT INTO session (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, expiresAt, token, now, now, ip || null, userAgent || null, userId)
		.run();
	return { id, token, expiresAt };
}

/**
 * better-call signed cookie format:
 * encodeURIComponent(`${token}.${btoa(hmacSha256)}`)
 * signature must be standard base64, length 44, ends with '='
 */
async function buildSignedSessionCookie(auth: any, token: string) {
	const ctx = await auth.$context;
	const secret = ctx.secret as string;
	const cookieName =
		(ctx.authCookies?.sessionToken?.name as string) || "__Secure-better-auth.session_token";
	const signature = await hmacSignBase64(secret, token);
	const signedValue = encodeURIComponent(`${token}.${signature}`);
	const maxAge = 60 * 60 * 24 * 7;
	return `${cookieName}=${signedValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function hmacSignBase64(secret: string, data: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
	const bytes = new Uint8Array(sig);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	// standard base64 WITH padding
	return btoa(binary);
}

export default app;
