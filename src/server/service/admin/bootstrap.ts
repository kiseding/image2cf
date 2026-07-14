import { account, user } from "@/server/db/schemas";
import { eq } from "drizzle-orm";
import { scryptSync } from "node:crypto";
import { nanoid } from "nanoid";
import type { DrizzleDb } from "@/server/db";

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
 * Create the first admin user from env if no users exist.
 * ADMIN_EMAIL + ADMIN_PASSWORD (+ optional ADMIN_NAME)
 */
export async function bootstrapAdmin(db: DrizzleDb, env: Record<string, any>) {
	const email = env.ADMIN_EMAIL as string | undefined;
	const password = env.ADMIN_PASSWORD as string | undefined;
	if (!email || !password) return;

	try {
		const existing = await db.query.user.findFirst({
			where: eq(user.email, email),
		});
		if (existing) return;

		const anyUser = await db.query.user.findFirst();
		// Only auto-create when database has no users, or always ensure this admin email exists
		if (anyUser) return;

		const userId = nanoid();
		const now = new Date();
		const passwordHash = await hashPassword(password);
		const name = (env.ADMIN_NAME as string) || "Admin";

		await db.insert(user).values({
			id: userId,
			name,
			email,
			emailVerified: true,
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

		console.log(`[image2cf] Bootstrapped admin user: ${email}`);
	} catch (e) {
		console.error("[image2cf] Failed to bootstrap admin:", e);
	}
}
