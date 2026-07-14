import type { DrizzleDb } from "@/server/db";
import { usernameToEmail } from "@/server/lib/auth";
import { hashPassword } from "@/server/lib/password";
import { nanoid } from "nanoid";

const ADMIN_USERNAME = "admin";
let done = false;

export function resetBootstrapFlag() {
	done = false;
}

function pickPassword(env: Record<string, any>): string | undefined {
	const v = env.ADMIN_PASSWORD ?? env.admin_password;
	if (v === undefined || v === null) return undefined;
	const s = String(v).trim();
	return s.length ? s : undefined;
}

function getD1(env: Record<string, any>): D1Database | null {
	const db = env.DB;
	if (db && typeof db.prepare === "function") return db as D1Database;
	return null;
}

/**
 * Create/repair default admin via D1 SQL (most reliable on Workers).
 * Login username: admin  →  email: admin@local.image2cf
 */
export async function bootstrapAdmin(_drizzle: DrizzleDb, env: Record<string, any>) {
	if (done) return;

	const password = pickPassword(env);
	const d1 = getD1(env);

	console.log(
		`[image2cf] bootstrap start hasPassword=${!!password} hasD1=${!!d1} adminKeys=${Object.keys(env)
			.filter((k) => /admin/i.test(k))
			.join(",") || "(none)"}`,
	);

	if (!password) {
		console.log("[image2cf] ADMIN_PASSWORD missing — set Worker Secret ADMIN_PASSWORD");
		return;
	}
	if (!d1) {
		// Node / non-D1 fallback via drizzle
		try {
			await drizzleBootstrap(_drizzle, password);
			done = true;
		} catch (e) {
			console.error("[image2cf] drizzle bootstrap failed:", e);
		}
		return;
	}

	try {
		await ensureColumns(d1);
		const email = usernameToEmail(ADMIN_USERNAME);
		const name = String(env.ADMIN_NAME || "Admin");
		const passwordHash = await hashPassword(password);
		const now = Date.now();

		const existing = await d1
			.prepare(
				`SELECT id FROM user WHERE email = ? OR username = ? OR role = 'admin' LIMIT 1`,
			)
			.bind(email, ADMIN_USERNAME)
			.first<{ id: string }>();

		let userId = existing?.id;
		if (!userId) {
			userId = nanoid();
			await d1
				.prepare(
					`INSERT INTO user (id, name, email, email_verified, image, username, display_username, role, banned, created_at, updated_at)
           VALUES (?, ?, ?, 1, NULL, ?, ?, 'admin', 0, ?, ?)`,
				)
				.bind(userId, name, email, ADMIN_USERNAME, name, now, now)
				.run();
			console.log(`[image2cf] inserted admin user id=${userId}`);
		} else {
			await d1
				.prepare(
					`UPDATE user SET name = ?, email = ?, email_verified = 1, username = ?, display_username = ?, role = 'admin', banned = 0, updated_at = ?
           WHERE id = ?`,
				)
				.bind(name, email, ADMIN_USERNAME, name, now, userId)
				.run();
			console.log(`[image2cf] updated admin user id=${userId}`);
		}

		// credential account
		const acc = await d1
			.prepare(`SELECT id FROM account WHERE user_id = ? AND provider_id = 'credential' LIMIT 1`)
			.bind(userId)
			.first<{ id: string }>();

		if (acc?.id) {
			await d1
				.prepare(`UPDATE account SET password = ?, updated_at = ? WHERE id = ?`)
				.bind(passwordHash, now, acc.id)
				.run();
		} else {
			await d1
				.prepare(
					`INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
           VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
				)
				.bind(nanoid(), userId, userId, passwordHash, now, now)
				.run();
		}

		// verify
		const check = await d1
			.prepare(
				`SELECT u.id, u.email, u.username, a.password IS NOT NULL AS has_pw
         FROM user u LEFT JOIN account a ON a.user_id = u.id AND a.provider_id = 'credential'
         WHERE u.email = ? LIMIT 1`,
			)
			.bind(email)
			.first();

		console.log(`[image2cf] admin verify:`, JSON.stringify(check));
		done = true;
	} catch (e) {
		console.error("[image2cf] D1 bootstrap failed:", e);
	}
}

async function ensureColumns(d1: D1Database) {
	const alters = [
		`ALTER TABLE user ADD COLUMN role text DEFAULT 'user'`,
		`ALTER TABLE user ADD COLUMN banned integer DEFAULT 0`,
		`ALTER TABLE user ADD COLUMN username text`,
		`ALTER TABLE user ADD COLUMN display_username text`,
	];
	for (const sql of alters) {
		try {
			await d1.prepare(sql).run();
		} catch {
			// column already exists
		}
	}
}

async function drizzleBootstrap(db: DrizzleDb, password: string) {
	const { account, user } = await import("@/server/db/schemas");
	const { eq } = await import("drizzle-orm");
	const email = usernameToEmail(ADMIN_USERNAME);
	const passwordHash = await hashPassword(password);
	const now = new Date();

	let admin = await db.query.user.findFirst({ where: eq(user.email, email) });
	if (!admin) {
		const id = nanoid();
		await db.insert(user).values({
			id,
			name: "Admin",
			email,
			emailVerified: true,
			username: ADMIN_USERNAME,
			displayUsername: "Admin",
			role: "admin",
			banned: false,
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(account).values({
			id: nanoid(),
			accountId: id,
			providerId: "credential",
			userId: id,
			password: passwordHash,
			createdAt: now,
			updatedAt: now,
		});
		console.log("[image2cf] drizzle created admin");
		return;
	}
	await db
		.update(user)
		.set({
			username: ADMIN_USERNAME,
			email,
			role: "admin",
			banned: false,
			emailVerified: true,
			updatedAt: now,
		})
		.where(eq(user.id, admin.id));
	const acc = await db.query.account.findFirst({ where: eq(account.userId, admin.id) });
	if (acc) {
		await db.update(account).set({ password: passwordHash, updatedAt: now }).where(eq(account.id, acc.id));
	} else {
		await db.insert(account).values({
			id: nanoid(),
			accountId: admin.id,
			providerId: "credential",
			userId: admin.id,
			password: passwordHash,
			createdAt: now,
			updatedAt: now,
		});
	}
	console.log("[image2cf] drizzle repaired admin");
}
