import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
	assertSafePublicUrl,
	fetchPublicUrl,
	readResponseBytes,
} from "../src/server/lib/ssrf.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function dnsResponse(address = "1.1.1.1") {
	return new Response(JSON.stringify({ Status: 0, Answer: [{ type: address.includes(":") ? 28 : 1, data: address }] }), {
		headers: { "content-type": "application/dns-json" },
	});
}

test("rejects local, private, metadata, and non-HTTPS targets", () => {
	for (const url of [
		"http://example.com",
		"https://localhost/api",
		"https://127.0.0.1/api",
		"https://10.0.0.1/api",
		"https://169.254.169.254/latest/meta-data",
		"https://metadata.google.internal/",
	]) {
		assert.throws(() => assertSafePublicUrl(url));
	}
	assert.equal(assertSafePublicUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
});

test("validates redirects and never forwards credentials across origins", async () => {
	globalThis.fetch = async (input) => String(input).startsWith("https://cloudflare-dns.com/")
		? dnsResponse()
		: new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } });
	await assert.rejects(fetchPublicUrl("https://api.example.com", {
		headers: { authorization: "Bearer secret" },
	}));

	globalThis.fetch = async (input) => String(input).startsWith("https://cloudflare-dns.com/")
		? dnsResponse()
		: new Response(null, { status: 302, headers: { location: "https://other.example.com/result" } });
	await assert.rejects(
		fetchPublicUrl("https://api.example.com", { headers: { authorization: "Bearer secret" } }),
		/credentials/,
	);
});

test("rejects hostnames that resolve to private addresses", async () => {
	globalThis.fetch = async (input) => String(input).startsWith("https://cloudflare-dns.com/")
		? dnsResponse("10.0.0.7")
		: new Response("unexpected");
	await assert.rejects(fetchPublicUrl("https://relay.example.com"), /private/);
});

test("bounds streamed response bodies", async () => {
	const response = new Response(new Uint8Array([1, 2, 3, 4]));
	await assert.rejects(readResponseBytes(response, 3), /exceeds/);
	assert.deepEqual(
		await readResponseBytes(new Response(new Uint8Array([1, 2, 3])), 3),
		new Uint8Array([1, 2, 3]),
	);
});
