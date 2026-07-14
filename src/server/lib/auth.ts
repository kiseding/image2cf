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
			// Use better-auth default scrypt (works on Cloudflare Workers)
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
