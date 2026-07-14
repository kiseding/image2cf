import { hashPassword as baHash, verifyPassword as baVerify } from "better-auth/crypto";

/** Hash password with the same algorithm better-auth uses for sign-in */
export async function hashPassword(password: string) {
	return baHash(password);
}

export async function verifyPassword(hash: string, password: string) {
	return baVerify({ hash, password });
}
