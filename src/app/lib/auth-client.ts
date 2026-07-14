import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	baseURL: "",
});

/** Convert UI username to the synthetic email used in the database */
export function usernameToLoginEmail(username: string) {
	const u = username.trim().toLowerCase();
	return `${u}@local.image2cf`;
}
