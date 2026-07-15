import {
	account,
	aiModels,
	aiProviders,
	chats,
	files,
	messageAttachments,
	messageGenerations,
	messages,
	session,
	settings,
	user,
	userRelays,
	verification,
} from "@/server/db/schemas";
import { normalizeUsername, usernameToEmail } from "@/server/lib/auth";
import { hashPassword } from "@/server/lib/password";
import { ServiceException } from "@/server/lib/exception";
import { eq, inArray, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import z from "zod/v4";
import { type RequestContext, getContext } from "../context";

const UsernameSchema = z
	.string()
	.min(2)
	.max(32)
	.regex(/^[a-zA-Z0-9_.-]+$/, "Invalid username");

async function runAtomic(db: ReturnType<typeof getContext>["db"], statements: unknown[]) {
	if (!statements.length) return;
	// D1 and libSQL implement Drizzle batch as one implicit transaction.
	await (db as any).batch(statements as any);
}

async function deleteUserR2Objects(userId: string, trackedKeys: string[]) {
	const { R2 } = getContext();
	if (!R2) {
		if (trackedKeys.length) {
			throw new ServiceException("error", "R2 is unavailable; user data was not deleted");
		}
		return;
	}

	try {
		const keys = new Set(trackedKeys);
		let cursor: string | undefined;
		do {
			const listed = await R2.list({
				prefix: `users/${userId}/`,
				limit: 1000,
				...(cursor ? { cursor } : {}),
			});
			for (const object of listed.objects) keys.add(object.key);
			cursor = listed.truncated && "cursor" in listed ? listed.cursor : undefined;
		} while (cursor);

		const allKeys = [...keys];
		for (let offset = 0; offset < allKeys.length; offset += 1000) {
			await R2.delete(allKeys.slice(offset, offset + 1000));
		}
	} catch (error) {
		console.error("[admin] R2 user cleanup failed; D1 records retained", { userId, error });
		throw new ServiceException("error", "Object storage cleanup failed; user data was not deleted");
	}
}

async function assertAdmin(ctx: RequestContext) {
	const { db } = getContext();
	const current = await db.query.user.findFirst({
		where: eq(user.id, ctx.userId),
	});
	if (!current || current.role !== "admin") {
		throw new ServiceException("forbidden", "Admin access required");
	}
	return current;
}

const listUsers = async (ctx: RequestContext) => {
	await assertAdmin(ctx);
	const { db } = getContext();
	const users = await db.query.user.findMany({
		orderBy: (u, { desc }) => [desc(u.createdAt)],
	});
	return users.map((u) => ({
		id: u.id,
		name: u.name,
		username: u.username || u.name,
		role: u.role,
		banned: u.banned,
		createdAt: u.createdAt,
		updatedAt: u.updatedAt,
	}));
};

export const CreateUserSchema = z.object({
	username: UsernameSchema,
	password: z.string().min(6).max(128),
	role: z.enum(["admin", "user"]).default("user"),
	// optional display name; defaults to username
	name: z.string().min(1).max(64).optional(),
});
export type CreateUser = z.infer<typeof CreateUserSchema>;

const createUser = async (req: CreateUser, ctx: RequestContext) => {
	await assertAdmin(ctx);
	const { db } = getContext();

	const username = normalizeUsername(req.username);
	const existing = await db.query.user.findFirst({
		where: eq(user.username, username),
	});
	if (existing) {
		throw new ServiceException("invalid_parameter", "Username already exists");
	}

	const userId = nanoid();
	const now = new Date();
	const passwordHash = await hashPassword(req.password);
	const displayName = req.name?.trim() || username;

	await db.insert(user).values({
		id: userId,
		name: displayName,
		email: usernameToEmail(username),
		emailVerified: true,
		username,
		displayUsername: displayName,
		role: req.role,
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

	return { id: userId };
};

export const UpdateUserSchema = z.object({
	id: z.string(),
	name: z.string().min(1).max(64).optional(),
	password: z.string().min(6).max(128).optional(),
	role: z.enum(["admin", "user"]).optional(),
	banned: z.boolean().optional(),
});
export type UpdateUser = z.infer<typeof UpdateUserSchema>;

const updateUser = async (req: UpdateUser, ctx: RequestContext) => {
	await assertAdmin(ctx);
	const { db } = getContext();

	const target = await db.query.user.findFirst({
		where: eq(user.id, req.id),
	});
	if (!target) {
		throw new ServiceException("not_found", "User not found");
	}

	// Prevent admin from demoting/banning the last admin
	if ((req.role === "user" || req.banned === true) && target.role === "admin") {
		const admins = await db.query.user.findMany({
			where: eq(user.role, "admin"),
		});
		if (admins.length <= 1) {
			throw new ServiceException("invalid_parameter", "Cannot modify the last admin");
		}
	}

	const now = new Date();
	const updateStatement = db
		.update(user)
		.set({
			...(req.name !== undefined ? { name: req.name } : {}),
			...(req.role !== undefined ? { role: req.role } : {}),
			...(req.banned !== undefined ? { banned: req.banned } : {}),
			updatedAt: now,
		})
		.where(eq(user.id, req.id));
	if (req.banned === true) {
		await runAtomic(db, [updateStatement, db.delete(session).where(eq(session.userId, req.id))]);
	} else {
		await updateStatement;
	}

	if (req.password) {
		const passwordHash = await hashPassword(req.password);
		const existingAccount = await db.query.account.findFirst({
			where: eq(account.userId, req.id),
		});
		if (existingAccount) {
			await runAtomic(db, [
				db
					.update(account)
					.set({ password: passwordHash, updatedAt: now })
					.where(eq(account.id, existingAccount.id)),
				db.delete(session).where(eq(session.userId, req.id)),
			]);
		} else {
			await runAtomic(db, [
				db.insert(account).values({
					id: nanoid(),
					accountId: req.id,
					providerId: "credential",
					userId: req.id,
					password: passwordHash,
					createdAt: now,
					updatedAt: now,
				}),
				db.delete(session).where(eq(session.userId, req.id)),
			]);
		}
	}

	return true;
};

export const DeleteUserSchema = z.object({
	id: z.string(),
});
export type DeleteUser = z.infer<typeof DeleteUserSchema>;

const deleteUser = async (req: DeleteUser, ctx: RequestContext) => {
	await assertAdmin(ctx);
	const { db } = getContext();

	if (req.id === ctx.userId) {
		throw new ServiceException("invalid_parameter", "Cannot delete yourself");
	}

	const target = await db.query.user.findFirst({
		where: eq(user.id, req.id),
	});
	if (!target) {
		throw new ServiceException("not_found", "User not found");
	}

	if (target.role === "admin") {
		const admins = await db.query.user.findMany({
			where: eq(user.role, "admin"),
		});
		if (admins.length <= 1) {
			throw new ServiceException("invalid_parameter", "Cannot delete the last admin");
		}
	}

	const userFiles = await db.select().from(files).where(eq(files.userId, req.id));
	await deleteUserR2Objects(
		req.id,
		userFiles
			.filter((file) => file.storage === "r2" || file.url.startsWith("r2://"))
			.map((file) => file.url.replace(/^r2:\/\//, ""))
			.filter(Boolean),
	);

	const userChatIds = (await db.select().from(chats).where(eq(chats.userId, req.id))).map((chat) => chat.id);
	const userMessages = await db.query.messages.findMany({
		where: userChatIds.length
			? or(eq(messages.userId, req.id), inArray(messages.chatId, userChatIds))
			: eq(messages.userId, req.id),
	});
	const userMessageIds = userMessages.map((message) => message.id);
	const userFileIds = userFiles.map((file) => file.id);

	await runAtomic(db, [
		...(userMessageIds.length || userFileIds.length
			? [
					db.delete(messageAttachments).where(
						userMessageIds.length && userFileIds.length
							? or(
									inArray(messageAttachments.messageId, userMessageIds),
									inArray(messageAttachments.fileId, userFileIds),
								)
							: userMessageIds.length
								? inArray(messageAttachments.messageId, userMessageIds)
								: inArray(messageAttachments.fileId, userFileIds),
					),
				]
			: []),
		db.delete(messages).where(
			userChatIds.length
				? or(eq(messages.userId, req.id), inArray(messages.chatId, userChatIds))
				: eq(messages.userId, req.id),
		),
		db.delete(chats).where(eq(chats.userId, req.id)),
		db.delete(messageGenerations).where(eq(messageGenerations.userId, req.id)),
		db.delete(files).where(eq(files.userId, req.id)),
		db.delete(aiModels).where(eq(aiModels.userId, req.id)),
		db.delete(aiProviders).where(eq(aiProviders.userId, req.id)),
		db.delete(userRelays).where(eq(userRelays.userId, req.id)),
		db.delete(settings).where(eq(settings.userId, req.id)),
		db.delete(session).where(eq(session.userId, req.id)),
		db.delete(account).where(eq(account.userId, req.id)),
		db.delete(verification).where(eq(verification.identifier, target.email)),
		db.delete(user).where(eq(user.id, req.id)),
	]);
	return true;
};

const getMe = async (ctx: RequestContext) => {
	const { db } = getContext();
	const current = await db.query.user.findFirst({
		where: eq(user.id, ctx.userId),
	});
	if (!current) {
		throw new ServiceException("not_found", "User not found");
	}
	return {
		id: current.id,
		name: current.name,
		username: current.username || current.name,
		role: current.role,
		banned: current.banned,
	};
};

class AdminService {
	listUsers = listUsers;
	createUser = createUser;
	updateUser = updateUser;
	deleteUser = deleteUser;
	getMe = getMe;
}

export const adminService = new AdminService();
