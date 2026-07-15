const PREFIX = "enc:v1:";

async function deriveKey(secret: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`image2cf:${secret}`));
	return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function encode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function decode(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function isEncryptedCredential(value: unknown): value is string {
	return typeof value === "string" && value.startsWith(PREFIX);
}

export async function encryptCredential(value: string, secret: string | undefined): Promise<string> {
	if (!value || isEncryptedCredential(value)) return value;
	if (!secret) throw new Error("CREDENTIALS_SECRET is required before credentials can be stored");
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		await deriveKey(secret),
		new TextEncoder().encode(value),
	);
	return `${PREFIX}${encode(iv)}:${encode(new Uint8Array(encrypted))}`;
}

export async function decryptCredential(value: string, secret: string | undefined): Promise<string> {
	if (!isEncryptedCredential(value)) return value;
	if (!secret) throw new Error("CREDENTIALS_SECRET is required to decrypt stored credentials");
	const [ivValue, encryptedValue] = value.slice(PREFIX.length).split(":");
	if (!ivValue || !encryptedValue) throw new Error("Invalid encrypted credential");
	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: decode(ivValue) },
		await deriveKey(secret),
		decode(encryptedValue),
	);
	return new TextDecoder().decode(decrypted);
}
