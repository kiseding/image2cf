import type { DrizzleDb } from "@/server/db";
import { account, user } from "@/server/db/schemas";
import { usernameToEmail } from "@/server/lib/auth";
import { hashPassword } from "@/server/lib/password";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

const ADMIN_USERNAME = "admin";

// Once per Worker isolate / Node process
let bootstrapped = false;

/**
 * Ensure default admin exists.
 * Username is always "admin". Password comes from ADMIN_PASSWORD.
 * Password is always synced from ADMIN_PASSWORD so login never drifts.
 */
export async function bootstrapAdmin(db: DrizzleDb, env: Record<string, any>) {
	if (bootstrapped) return;
	const password = env.ADMIN_PASSWORD as string | undefined;
	if (!password) {
		console.log("[image2cf] Skip admin bootstrap: ADMIN_PASSWORD not set");
		return;
	}

	const username = ADMIN_USERNAME;
	const name = (env.ADMIN_NAME as string) || "Admin";
	const email = usernameToEmail(username);

	try {
		let admin = await db.query.user.findFirst({
			where: eq(user.username, username),
		});

		// Legacy users without username field
		if (!admin) {
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
						banned: false,
						updatedAt: new Date(),
					})
					.where(eq(user.id, byEmail.id));
				admin = { ...byEmail, username, role: "admin" } as any;
				console.log("[image2cf] Backfilled username for admin");
			}
		}

		if (!admin) {
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

			console.log(`[image2cf] Created admin user "${username}"`);
			bootstrapped = true;
			return;
		}

		// Ensure role / not banned / username set
		await db
			.update(user)
			.set({
				username,
				role: "admin",
				banned: false,
				emailVerified: true,
				updatedAt: new Date(),
			})
			.where(eq(user.id, admin.id));

		// Always sync password from env so ADMIN_PASSWORD is the source of truth
		await resetCredentialPassword(db, admin.id, password);
		console.log(`[image2cf] Admin ready: username="${username}" (password synced from ADMIN_PASSWORD)`);
		bootstrapped = true;
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
			.set({
				password: passwordHash,
				providerId: "credential",
				updatedAt: now,
			})
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
