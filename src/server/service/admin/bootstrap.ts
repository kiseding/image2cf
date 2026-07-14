import type { DrizzleDb } from "@/server/db";
import { account, user } from "@/server/db/schemas";
import { usernameToEmail } from "@/server/lib/auth";
import { hashPassword } from "@/server/lib/password";
import { eq, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

const ADMIN_USERNAME = "admin";

let bootstrapped = false;

/**
 * Ensure default admin exists.
 * Username is always "admin". Password from ADMIN_PASSWORD.
 * Login uses synthetic email admin@local.image2cf under the hood.
 */
export async function bootstrapAdmin(db: DrizzleDb, env: Record<string, any>) {
	if (bootstrapped) return;

	const password = pickPassword(env);
	if (!password) {
		console.log("[image2cf] Skip admin bootstrap: ADMIN_PASSWORD not set on env");
		return;
	}

	const username = ADMIN_USERNAME;
	const name = String(env.ADMIN_NAME || "Admin");
	const email = usernameToEmail(username);

	try {
		// Find existing admin by username OR synthetic email OR role=admin
		let admin =
			(await db.query.user.findFirst({ where: eq(user.username, username) })) ||
			(await db.query.user.findFirst({ where: eq(user.email, email) })) ||
			(await db.query.user.findFirst({ where: eq(user.role, "admin") }));

		const passwordHash = await hashPassword(password);
		const now = new Date();

		if (!admin) {
			const userId = nanoid();
			await db.insert(user).values({
				id: userId,
				name,
				email,
				emailVerified: true,
				username,
				displayUsername: name,
				role: "admin",
				banned: false,
				createdAt: now,
				updatedAt: now,
			});
			await db.insert(account).values({
				id: nanoid(),
				accountId: userId,
				providerId: "credential",
				userId,
				password: passwordHash,
				createdAt: now,
				updatedAt: now,
			});
			console.log(`[image2cf] Created admin user="${username}" email="${email}"`);
			bootstrapped = true;
			return;
		}

		// Repair fields for existing admin
		await db
			.update(user)
			.set({
				username,
				displayUsername: name,
				email,
				emailVerified: true,
				role: "admin",
				banned: false,
				updatedAt: now,
			})
			.where(eq(user.id, admin.id));

		await upsertCredential(db, admin.id, passwordHash, now);
		console.log(
			`[image2cf] Admin ready user="${username}" email="${email}" id=${admin.id} (password synced)`,
		);
		bootstrapped = true;
	} catch (e) {
		console.error("[image2cf] Failed to bootstrap admin:", e);
		// Try raw SQL fallback for D1 edge cases
		try {
			await rawSqlBootstrap(db, password, name, email, username);
			bootstrapped = true;
			console.log("[image2cf] Admin bootstrap via raw SQL succeeded");
		} catch (e2) {
			console.error("[image2cf] Raw SQL bootstrap also failed:", e2);
		}
	}
}

function pickPassword(env: Record<string, any>): string | undefined {
	const v = env.ADMIN_PASSWORD ?? env.admin_password;
	if (v === undefined || v === null) return undefined;
	const s = String(v).trim();
	return s || undefined;
}

async function upsertCredential(db: DrizzleDb, userId: string, passwordHash: string, now: Date) {
	const existing = await db.query.account.findFirst({
		where: eq(account.userId, userId),
	});
	if (existing) {
		await db
			.update(account)
			.set({ password: passwordHash, providerId: "credential", updatedAt: now })
			.where(eq(account.id, existing.id));
	} else {
		await db.insert(account).values({
			id: nanoid(),
			accountId: userId,
			providerId: "credential",
			userId,
			password: passwordHash,
			createdAt: now,
			updatedAt: now,
		});
	}
}

async function rawSqlBootstrap(
	db: DrizzleDb,
	password: string,
	name: string,
	email: string,
	username: string,
) {
	const passwordHash = await hashPassword(password);
	const userId = nanoid();
	const accountId = nanoid();
	const now = Date.now();

	// D1 / sqlite: insert or ignore then update
	await db.run(
		sql`INSERT OR IGNORE INTO user (id, name, email, email_verified, image, username, display_username, role, banned, created_at, updated_at)
		VALUES (${userId}, ${name}, ${email}, 1, null, ${username}, ${name}, 'admin', 0, ${now}, ${now})`,
	);
	await db.run(
		sql`UPDATE user SET username=${username}, email=${email}, email_verified=1, role='admin', banned=0, updated_at=${now}
		WHERE email=${email} OR username=${username}`,
	);

	const rows = await db.all<{ id: string }>(
		sql`SELECT id FROM user WHERE username=${username} OR email=${email} LIMIT 1`,
	);
	const uid = rows?.[0]?.id || userId;

	await db.run(
		sql`DELETE FROM account WHERE user_id=${uid} AND provider_id='credential'`,
	);
	await db.run(
		sql`INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
		VALUES (${accountId}, ${uid}, 'credential', ${uid}, ${passwordHash}, ${now}, ${now})`,
	);
}
