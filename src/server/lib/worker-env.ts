/**
 * Cloudflare Worker secrets are available as env.NAME but are often
 * non-enumerable, so object spread `{...env}` may drop them.
 * Always read known keys by direct property access.
 */
export function readWorkerEnv(env: Record<string, any> | undefined | null) {
	const e = env || {};
	const get = (key: string): string | undefined => {
		try {
			const v = e[key];
			if (v === undefined || v === null) return undefined;
			const s = String(v).trim();
			return s.length ? s : undefined;
		} catch {
			return undefined;
		}
	};

	return {
		ADMIN_PASSWORD: get("ADMIN_PASSWORD"),
		ADMIN_NAME: get("ADMIN_NAME"),
		BETTER_AUTH_SECRET: get("BETTER_AUTH_SECRET"),
		MODE: get("MODE"),
		PROVIDER_CLOUDFLARE_BUILTIN: get("PROVIDER_CLOUDFLARE_BUILTIN"),
		AUTH_EMAIL_VERIFICATION_ENABLED: get("AUTH_EMAIL_VERIFICATION_ENABLED"),
		AUTH_EMAIL_RESEND_API_KEY: get("AUTH_EMAIL_RESEND_API_KEY"),
		AUTH_EMAIL_RESEND_FROM: get("AUTH_EMAIL_RESEND_FROM"),
		AUTH_SOCIAL_GOOGLE_ENABLED: get("AUTH_SOCIAL_GOOGLE_ENABLED"),
		AUTH_SOCIAL_GOOGLE_CLIENT_ID: get("AUTH_SOCIAL_GOOGLE_CLIENT_ID"),
		AUTH_SOCIAL_GOOGLE_CLIENT_SECRET: get("AUTH_SOCIAL_GOOGLE_CLIENT_SECRET"),
		AUTH_SOCIAL_GITHUB_ENABLED: get("AUTH_SOCIAL_GITHUB_ENABLED"),
		AUTH_SOCIAL_GITHUB_CLIENT_ID: get("AUTH_SOCIAL_GITHUB_CLIENT_ID"),
		AUTH_SOCIAL_GITHUB_CLIENT_SECRET: get("AUTH_SOCIAL_GITHUB_CLIENT_SECRET"),
		COOKIE_DOMAIN: get("COOKIE_DOMAIN"),
		FILE_STORAGE: get("FILE_STORAGE"),
		DEBUG: get("DEBUG"),
		R2_RETENTION_DAYS: get("R2_RETENTION_DAYS"),
		// Keep raw env for D1 / AI / R2 bindings (not copied via spread)
		raw: e,
		DB: e.DB as D1Database | undefined,
		AI: e.AI as Ai | undefined,
		R2: e.R2 as R2Bucket | undefined,
	};
}
