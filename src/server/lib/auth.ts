import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import * as schema from "@/server/db/schemas";

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

/**
 * Map plain username → synthetic email (better-auth requires a valid email).
 * Domain must pass zod email validation (e.g. @local.image2cf is INVALID).
 */
export function usernameToEmail(username: string) {
	return `${normalizeUsername(username)}@users.image2cf.local`;
}

export function normalizeUsername(value: string) {
	return value.trim().toLowerCase();
}

export const createAuth = (db: any, config?: AuthConfig) =>
	betterAuth({
		database: drizzleAdapter(db, {
			provider: "sqlite",
			schema: {
				user: schema.user,
				session: schema.session,
				account: schema.account,
				verification: schema.verification,
			},
		}),
		user: {
			additionalFields: {
				username: {
					type: "string" as const,
					required: false,
					input: false,
					returned: true,
				},
				displayUsername: {
					type: "string" as const,
					required: false,
					input: false,
					returned: true,
				},
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
		// No username plugin — login uses synthetic email under the hood (more reliable on D1)
		plugins: [],
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
