import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	baseURL: "",
});

/** Username login — never sends email to the client API */
export async function loginWithUsername(username: string, password: string) {
	const resp = await fetch("/api/auth/username-login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		credentials: "include",
		body: JSON.stringify({
			username: username.trim(),
			password,
		}),
	});

	const data = (await resp.json().catch(() => ({}))) as {
		code?: string;
		message?: string;
		data?: unknown;
	};

	if (!resp.ok || data.code !== "ok") {
		return {
			error: {
				code: data.code || "UNAUTHORIZED",
				message: data.message || "Invalid username or password",
			},
			data: null,
		};
	}

	return { error: null, data: data.data };
}
