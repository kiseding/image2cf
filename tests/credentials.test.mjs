import assert from "node:assert/strict";
import test from "node:test";
import {
	decryptCredential,
	encryptCredential,
	isEncryptedCredential,
} from "../src/server/lib/credentials.ts";

test("credentials are encrypted with authenticated encryption", async () => {
	const encrypted = await encryptCredential("sk-secret", "stable-test-secret");
	assert.equal(isEncryptedCredential(encrypted), true);
	assert.equal(encrypted.includes("sk-secret"), false);
	assert.equal(await decryptCredential(encrypted, "stable-test-secret"), "sk-secret");
	await assert.rejects(decryptCredential(encrypted, "wrong-secret"));
});

test("legacy plaintext credentials remain readable for migration", async () => {
	assert.equal(await decryptCredential("legacy-key", "stable-test-secret"), "legacy-key");
	await assert.rejects(encryptCredential("new-key", undefined), /CREDENTIALS_SECRET/);
});
