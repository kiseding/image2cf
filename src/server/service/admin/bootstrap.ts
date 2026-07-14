import type { DrizzleDb } from "@/server/db";
import { account, user } from "@/server/db/schemas";
import { usernameToEmail } from "@/server/lib/auth";
import { eq } from "drizzle-orm";
import { scryptSync } from "node:crypto";
import { nanoid } from "nanoid";

async function hashPassword(password: string) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const saltHex = Array.from(salt)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const key = scryptSync(password.normalize("NFKC"), saltHex, 64, {
		N: 16384,
		r: 16,
		p: 1,
		maxmem: 128 * 16384 * 16 * 2,
	});
	const keyHex = Array.from(key)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `${saltHex}:${keyHex}`;
}

/**
 * Create the first admin when user table is empty.
 * Prefer ADMIN_USERNAME; ADMIN_EMAIL is accepted as username for compatibility.
 */
export async function bootstrapAdmin(db: DrizzleDb, env: Record<string, any>) {
	const rawUsername = (env.ADMIN_USERNAME || env.ADMIN_EMAIL) as string | undefined;
	const password = env.ADMIN_PASSWORD as string | undefined;
	if (!rawUsername || !password) return;

	// Allow legacy email-like value: take local part as username
	const username = String(rawUsername).includes("@")
		? String(rawUsername).split("@")[0]!.toLowerCase()
		: String(rawUsername).toLowerCase();

	try {
		const existing = await db.query.user.findFirst({
			where: eq(user.username, username),
		});
		if (existing) return;

		const anyUser = await db.query.user.findFirst();
		if (anyUser) return;

		const userId = nanoid();
		const now = new Date();
		const passwordHash = await hashPassword(password);
		const name = (env.ADMIN_NAME as string) || username;

		await db.insert(user).values({
			id: userId,
			name,
			email: usernameToEmail(username),
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
