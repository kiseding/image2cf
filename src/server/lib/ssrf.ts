/**
 * Basic SSRF guards for user-supplied relay base URLs.
 * Only allow public http(s) hosts; block private/link-local/metadata ranges.
 */

export function assertSafePublicUrl(raw: string, opts?: { allowHttp?: boolean }): string {
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		throw new Error("Invalid URL");
	}

	const protocol = u.protocol.toLowerCase();
	if (protocol !== "https:" && !(opts?.allowHttp && protocol === "http:")) {
		throw new Error("Only HTTPS URLs are allowed for relays");
	}

	const host = u.hostname.toLowerCase();
	if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
		throw new Error("Localhost hosts are not allowed");
	}

	// Block IPv4 private / special
	if (isBlockedIp(host)) {
		throw new Error("Private or special-use IP addresses are not allowed");
	}

	// Block obvious metadata hostnames
	if (
		host === "metadata.google.internal" ||
		host.endsWith(".internal") ||
		host === "metadata" ||
		host.endsWith(".metadata.google.internal")
	) {
		throw new Error("Metadata hosts are not allowed");
	}

	return u.toString().replace(/\/+$/, "");
}

export const REMOTE_FETCH_TIMEOUT_MS = 30_000;
export const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Fetch a public URL while validating every redirect target. */
export async function fetchPublicUrl(
	raw: string,
	init: RequestInit = {},
	opts: { allowHttp?: boolean; timeoutMs?: number; maxRedirects?: number } = {},
): Promise<Response> {
	let url = assertSafePublicUrl(raw, { allowHttp: opts.allowHttp });
	const maxRedirects = opts.maxRedirects ?? 3;

	for (let redirects = 0; ; redirects++) {
		await assertPublicDns(url);
		const response = await fetch(url, {
			...init,
			redirect: "manual",
			signal: AbortSignal.timeout(opts.timeoutMs ?? REMOTE_FETCH_TIMEOUT_MS),
		});
		if (![301, 302, 303, 307, 308].includes(response.status)) return response;
		if (redirects >= maxRedirects) throw new Error("Too many redirects");
		const location = response.headers.get("location");
		if (!location) throw new Error("Redirect response has no location");
		const nextUrl = assertSafePublicUrl(new URL(location, url).toString(), { allowHttp: opts.allowHttp });
		if (new Headers(init.headers).has("authorization") && new URL(nextUrl).origin !== new URL(url).origin) {
			throw new Error("Refusing to forward credentials across origins");
		}
		url = nextUrl;
	}
}

async function assertPublicDns(raw: string): Promise<void> {
	const host = new URL(raw).hostname.toLowerCase();
	if (host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return;

	const answers = await Promise.all(
		["A", "AAAA"].map(async (type) => {
			const endpoint = new URL("https://cloudflare-dns.com/dns-query");
			endpoint.searchParams.set("name", host);
			endpoint.searchParams.set("type", type);
			const response = await fetch(endpoint, {
				headers: { accept: "application/dns-json" },
				signal: AbortSignal.timeout(5_000),
			});
			if (!response.ok) throw new Error("Unable to validate relay DNS");
			const body = JSON.parse(await readResponseText(response, 64 * 1024)) as {
				Status?: number;
				Answer?: Array<{ type?: number; data?: string }>;
			};
			if (body.Status !== 0 && body.Status !== undefined) return [];
			return (body.Answer || [])
				.filter((answer) => answer.type === 1 || answer.type === 28)
				.map((answer) => String(answer.data || "").toLowerCase())
				.filter(Boolean);
		}),
	);
	const addresses = answers.flat();
	if (!addresses.length) throw new Error("Relay hostname did not resolve to a public address");
	if (addresses.some(isBlockedIp)) throw new Error("Relay hostname resolves to a private or special-use address");
}

export async function readResponseBytes(
	response: Response,
	maxBytes: number,
	timeoutMs = REMOTE_FETCH_TIMEOUT_MS,
): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Remote response exceeds ${maxBytes} bytes`);
	if (!response.body) return new Uint8Array();

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		while (true) {
			const result = await Promise.race([
				reader.read(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Remote response body timed out")), timeoutMs);
				}),
			]);
			if (timer) clearTimeout(timer);
			if (result.done) break;
			total += result.value.byteLength;
			if (total > maxBytes) throw new Error(`Remote response exceeds ${maxBytes} bytes`);
			chunks.push(result.value);
		}
	} catch (error) {
		await reader.cancel(error).catch(() => undefined);
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export async function readResponseText(response: Response, maxBytes = MAX_PROVIDER_RESPONSE_BYTES): Promise<string> {
	return new TextDecoder().decode(await readResponseBytes(response, maxBytes));
}

function isBlockedIp(host: string): boolean {
	// IPv6 localhost / link-local / ULA
	if (host === "::1" || host === "[::1]") return true;
	if (host === "::" || host === "[::]") return true;
	if (/^\[?::ffff:/i.test(host)) {
		const mapped = host.replace(/^\[?::ffff:/i, "").replace(/]$/, "");
		return isBlockedIp(mapped);
	}
	if (host.startsWith("fe80:") || host.startsWith("[fe80:")) return true;
	if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("[fc") || host.startsWith("[fd")) {
		// rough ULA check
		if (/^\[?f[cd][0-9a-f]{0,2}:/i.test(host)) return true;
	}

	// IPv4 dotted
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return false;
	const a = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
	if (a.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;

	const [o1, o2] = a;
	// 0.0.0.0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10, 192.0.0/24, 198.18/15, 224+/
	if (o1 === 0) return true;
	if (o1 === 10) return true;
	if (o1 === 127) return true;
	if (o1 === 169 && o2 === 254) return true;
	if (o1 === 172 && o2! >= 16 && o2! <= 31) return true;
	if (o1 === 192 && o2 === 168) return true;
	if (o1 === 100 && o2! >= 64 && o2! <= 127) return true;
	if (o1 === 192 && o2 === 0) return true;
	if (o1 === 198 && (o2 === 18 || o2 === 19)) return true;
	if (o1! >= 224) return true;
	return false;
}
