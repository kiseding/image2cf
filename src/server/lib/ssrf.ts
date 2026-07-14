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

function isBlockedIp(host: string): boolean {
	// IPv6 localhost / link-local / ULA
	if (host === "::1" || host === "[::1]") return true;
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
