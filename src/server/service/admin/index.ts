import { account, user } from "@/server/db/schemas";
import { usernameToEmail } from "@/server/lib/auth";
import { ServiceException } from "@/server/lib/exception";
import { scryptSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import z from "zod/v4";
import { type RequestContext, getContext } from "../context";

const UsernameSchema = z
	.string()
	.min(2)
	.max(32)
	.regex(/^[a-zA-Z0-9_\u4e00-\u9fa5.-]+$/, "Invalid username");

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

	const username = req.username.trim();
	const existing = await db.query.user.findFirst({
		where: eq(user.username, username.toLowerCase()),
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
		username: username.toLowerCase(),
		displayUsername: username,
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
	await db
		.update(user)
		.set({
			...(req.name !== undefined ? { name: req.name } : {}),
			...(req.role !== undefined ? { role: req.role } : {}),
			...(req.banned !== undefined ? { banned: req.banned } : {}),
			updatedAt: now,
		})
		.where(eq(user.id, req.id));

	if (req.password) {
		const passwordHash = await hashPassword(req.password);
		const existingAccount = await db.query.account.findFirst({
			where: eq(account.userId, req.id),
		});
		if (existingAccount) {
			await db
				.update(account)
				.set({ password: passwordHash, updatedAt: now })
				.where(eq(account.id, existingAccount.id));
		} else {
			await db.insert(account).values({
				id: nanoid(),
				accountId: req.id,
				providerId: "credential",
				userId: req.id,
				password: passwordHash,
				createdAt: now,
				updatedAt: now,
			});
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

	await db.delete(user).where(eq(user.id, req.id));
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
