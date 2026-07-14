import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import z from "zod/v4";
import { normalizeUsername } from "@/server/lib/auth";
import { verifyPassword } from "@/server/lib/password";
import { type Env, ok, error } from "../util";

/**
 * Username + password login only (no email in client request/response).
 */
const app = new Hono<Env>().basePath("/auth").post(
	"/username-login",
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

		if (!d1) {
			return c.json(error("error", "Database unavailable"), 500);
		}

		try {
			const user = await d1
				.prepare(
					`SELECT id, name, email, username, role, banned
           FROM user
           WHERE lower(coalesce(username, '')) = ? OR lower(name) = ?
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

			if (!user) {
				console.error("[image2cf] login: user not found", uname);
				return c.json(error("unauthorized", "Invalid username or password"), 401);
			}

			if (user.banned) {
				return c.json(error("forbidden", "User is banned"), 403);
			}

			const account = await d1
				.prepare(
					`SELECT id, password FROM account
           WHERE user_id = ? AND provider_id = 'credential'
           LIMIT 1`,
				)
				.bind(user.id)
				.first<{ id: string; password: string | null }>();

			if (!account?.password) {
				console.error("[image2cf] login: no credential", user.id);
				return c.json(error("unauthorized", "Invalid username or password"), 401);
			}

			const valid = await verifyPassword(account.password, password);
			if (!valid) {
				console.error("[image2cf] login: bad password", user.id);
				return c.json(error("unauthorized", "Invalid username or password"), 401);
			}

			if (!user.username) {
				await d1.prepare(`UPDATE user SET username = ? WHERE id = ?`).bind(uname, user.id).run();
			}

			// Create better-auth session (internal; client never sees email)
			const signInResult = await auth.api.signInEmail({
				body: {
					email: user.email,
					password,
					rememberMe: true,
				},
				headers: c.req.raw.headers,
				asResponse: true,
			});

			const bodyText = await signInResult.text();
			let payload: any = {};
			try {
				payload = JSON.parse(bodyText);
			} catch {
				payload = {};
			}

			if (!signInResult.ok) {
				console.error("[image2cf] signInEmail failed", signInResult.status, bodyText);
				// Manual session fallback
				const manual = await createManualSession(auth, user, uname);
				if (manual) return manual;
				return c.json(error("unauthorized", "Invalid username or password"), 401);
			}

			const outBody = {
				code: "ok" as const,
				data: {
					user: {
						id: user.id,
						name: user.name,
						username: user.username || uname,
						role: user.role || "user",
					},
					session: payload?.token ? { token: payload.token } : true,
				},
			};

			const headers = new Headers({ "Content-Type": "application/json" });
			const setCookies =
				typeof signInResult.headers.getSetCookie === "function"
					? signInResult.headers.getSetCookie()
					: [];
			if (setCookies.length) {
				for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
			} else {
				const single = signInResult.headers.get("set-cookie");
				if (single) headers.append("Set-Cookie", single);
			}

			return new Response(JSON.stringify(outBody), { status: 200, headers });
		} catch (e) {
			console.error("[image2cf] username-login error:", e);
			return c.json(error("error", "Login failed"), 500);
		}
	},
);

async function createManualSession(
	auth: any,
	user: { id: string; name: string; username: string | null; role: string | null },
	uname: string,
) {
	try {
		const ctx = await auth.$context;
		const session = await ctx.internalAdapter.createSession(user.id, false);
		if (!session?.token) return null;

		const cookieName = ctx.authCookies?.sessionToken?.name || "better-auth.session_token";
		const secure = true;
		const cookie = `${cookieName}=${encodeURIComponent(session.token)}; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`;

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
					session: { token: session.token },
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
		console.error("[image2cf] manual session failed:", e);
		return null;
	}
}

export default app;
