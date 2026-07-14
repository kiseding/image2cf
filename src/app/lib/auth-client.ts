import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	baseURL: "",
});

/** Convert UI username to the synthetic email used in the database */
export function usernameToLoginEmail(username: string) {
	const u = username.trim().toLowerCase();
	// Must pass better-auth/zod email validation
	return `${u}@users.image2cf.local`;
}
