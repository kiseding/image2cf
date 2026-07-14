import type { DrizzleDb } from "@/server/db";
import { account, user } from "@/server/db/schemas";
import { hashPassword, normalizeUsername, usernameToEmail } from "@/server/lib/auth";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

/**
 * Ensure bootstrap admin exists and can log in with username.
 *
 * Sources (first non-empty):
 * - ADMIN_USERNAME
 * - ADMIN_EMAIL (legacy; local-part used as username)
 *
 * Behaviors:
 * 1. Empty DB → create admin
 * 2. User exists with username → refresh password if ADMIN_PASSWORD set and ADMIN_FORCE_RESET=true
 * 3. User exists by synthetic email / old email without username → backfill username + password
 */
export async function bootstrapAdmin(db: DrizzleDb, env: Record<string, any>) {
	const rawUsername = (env.ADMIN_USERNAME || env.ADMIN_EMAIL) as string | undefined;
	const password = env.ADMIN_PASSWORD as string | undefined;
	if (!rawUsername || !password) {
		console.log("[image2cf] Skip admin bootstrap: ADMIN_USERNAME/ADMIN_PASSWORD not set");
		return;
	}

	const username = String(rawUsername).includes("@")
		? normalizeUsername(String(rawUsername).split("@")[0]!)
		: normalizeUsername(String(rawUsername));

	if (username.length < 2) {
		console.error("[image2cf] ADMIN_USERNAME too short");
		return;
	}

	const name = (env.ADMIN_NAME as string) || username;
	const email = usernameToEmail(username);
	const forceReset = String(env.ADMIN_FORCE_RESET || "").toLowerCase() === "true";

	try {
		const byUsername = await db.query.user.findFirst({
			where: eq(user.username, username),
		});

		if (byUsername) {
			if (forceReset) {
				await resetCredentialPassword(db, byUsername.id, password);
				console.log(`[image2cf] Reset password for admin: ${username}`);
			} else {
				console.log(`[image2cf] Admin already exists: ${username}`);
			}
			// ensure role admin
			if (byUsername.role !== "admin") {
				await db.update(user).set({ role: "admin", updatedAt: new Date() }).where(eq(user.id, byUsername.id));
			}
			return;
		}

		// Legacy: user created before username field, match synthetic/local email
		const byEmail = await db.query.user.findFirst({
			where: eq(user.email, email),
		});
		if (byEmail) {
			await db
				.update(user)
				.set({
					username,
					displayUsername: name,
					name: byEmail.name || name,
					role: "admin",
					emailVerified: true,
					updatedAt: new Date(),
				})
				.where(eq(user.id, byEmail.id));
			await resetCredentialPassword(db, byEmail.id, password);
			console.log(`[image2cf] Backfilled username for existing user: ${username}`);
			return;
		}

		// Only create when no users, OR always create this admin if missing
		// (allow creating admin even if other users exist — needed after broken boots)
		const userId = nanoid();
		const now = new Date();
		const passwordHash = await hashPassword(password);

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

		console.log(`[image2cf] Bootstrapped admin user: ${username}`);
	} catch (e) {
		console.error("[image2cf] Failed to bootstrap admin:", e);
	}
}

async function resetCredentialPassword(db: DrizzleDb, userId: string, password: string) {
	const passwordHash = await hashPassword(password);
	const now = new Date();
	const existingAccount = await db.query.account.findFirst({
		where: eq(account.userId, userId),
	});
	if (existingAccount) {
		await db
			.update(account)
			.set({ password: passwordHash, providerId: "credential", updatedAt: now })
			.where(eq(account.id, existingAccount.id));
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
