import { scryptSync } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { username } from "better-auth/plugins";

export interface AuthConfig {
	email: {
		verification: boolean;
		resend: {
			apiKey: string;
			from: string;
		};
	};
	social: {
		google: {
			enabled: boolean;
			clientId: string;
			clientSecret: string;
		};
		github: {
			enabled: boolean;
			clientId: string;
			clientSecret: string;
		};
	};
	cookieDomain?: string;
	disableSignUp?: boolean;
}

/** Synthetic email for better-auth required email field */
export function usernameToEmail(username: string) {
	return `${username.toLowerCase()}@local.image2cf`;
}

export function normalizeUsername(value: string) {
	return value.trim().toLowerCase();
}

export async function hashPassword(password: string) {
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

export async function verifyPassword(hash: string, password: string) {
	const [saltHex, keyHex] = hash.split(":");
	if (!saltHex || !keyHex) return false;

	const targetKey = scryptSync(password.normalize("NFKC"), saltHex, 64, {
		N: 16384,
		r: 16,
		p: 1,
		maxmem: 128 * 16384 * 16 * 2,
	});

	const targetKeyHex = Array.from(targetKey)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return targetKeyHex === keyHex;
}

export const createAuth = (db: any, config?: AuthConfig) =>
	betterAuth({
		database: drizzleAdapter(db, {
			provider: "sqlite",
		}),
		user: {
			additionalFields: {
				role: {
					type: "string" as const,
					required: false,
					defaultValue: "user",
					input: false,
					returned: true,
				},
				banned: {
					type: "boolean" as const,
					required: false,
					defaultValue: false,
					input: false,
					returned: true,
				},
			},
		},
		...(config?.cookieDomain
			? {
					advanced: {
						crossSubDomainCookies: {
							enabled: true,
							domain: config.cookieDomain,
						},
					},
				}
			: {}),
		emailAndPassword: {
			enabled: true,
			disableSignUp: config?.disableSignUp !== false,
			requireEmailVerification: false,
			password: {
				hash: hashPassword,
				verify: async ({ hash, password }) => verifyPassword(hash, password),
			},
		},
		databaseHooks: {
			session: {
				create: {
					before: async (session) => {
						const found = await db.query.user.findFirst({
							where: (u: any, { eq }: any) => eq(u.id, session.userId),
						});
						if (found?.banned) {
							throw new APIError("FORBIDDEN", {
								message: "User is banned",
							});
						}
						return { data: session };
					},
				},
			},
		},
		plugins: [
			username({
				minUsernameLength: 2,
				maxUsernameLength: 32,
				// Always lowercase before DB lookup so login matches stored username
				usernameNormalization: (u) => normalizeUsername(u),
				validationOrder: {
					username: "pre-normalization",
					displayUsername: "pre-normalization",
				},
				usernameValidator: (value) => /^[a-zA-Z0-9_.-]+$/.test(value),
			}),
		],
		socialProviders: {
			google:
				config?.social.google.enabled === true
					? {
							clientId: config.social.google.clientId,
							clientSecret: config.social.google.clientSecret,
							disableSignUp: true,
						}
					: undefined,
			github:
				config?.social.github.enabled === true
					? {
							clientId: config.social.github.clientId,
							clientSecret: config.social.github.clientSecret,
							disableSignUp: true,
						}
					: undefined,
		},
	});
