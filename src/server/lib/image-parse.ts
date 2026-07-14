import { base64ToDataURI, fetchUrlToDataURI } from "@/server/lib/util";

/** Normalize raw base64 / data URI into a data:image URI */
export function normalizeBase64Image(raw: string): string {
	const s = String(raw || "").trim();
	if (!s) return "";
	if (s.startsWith("data:image")) return s.replace(/\s+/g, "");
	if (s.startsWith("data:")) return s;
	const b64 = s.replace(/\s+/g, "");
	if (b64.length < 32) return "";
	if (b64.startsWith("/9j/")) return base64ToDataURI(b64, "jpeg");
	if (b64.startsWith("iVBOR")) return base64ToDataURI(b64, "png");
	if (b64.startsWith("R0lGOD")) return base64ToDataURI(b64, "gif");
	if (b64.startsWith("UklGR")) return base64ToDataURI(b64, "webp");
	// likely raw base64
	if (/^[A-Za-z0-9+/]+=*$/.test(b64.slice(0, 80)) && b64.length > 100) {
		return base64ToDataURI(b64, "png");
	}
	return "";
}

function isHttpUrl(s: string) {
	return /^https?:\/\//i.test(s);
}

/**
 * Extract image data-uris or http(s) URLs from heterogeneous relay responses.
 * Prefer keeping remote URLs (lighter for D1) unless only base64 is present.
 */
export async function extractImagesFromAny(json: any, opts?: { preferUrl?: boolean }): Promise<string[]> {
	const preferUrl = opts?.preferUrl !== false;
	const urls: string[] = [];
	const b64s: string[] = [];
	const seen = new Set<string>();

	const addUrl = (u: string) => {
		const s = String(u || "").trim();
		if (!s || !isHttpUrl(s) || seen.has(s)) return;
		seen.add(s);
		urls.push(s);
	};
	const addB64 = (raw: string) => {
		const n = normalizeBase64Image(raw);
		if (!n || seen.has(n.slice(0, 120))) return;
		seen.add(n.slice(0, 120));
		b64s.push(n);
	};

	const visit = (v: any, depth = 0) => {
		if (v == null || depth > 8) return;
		if (typeof v === "string") {
			const s = v.trim();
			if (isHttpUrl(s)) addUrl(s);
			else if (s.startsWith("data:image") || s.length > 200) {
				// data uri or long base64
				if (s.includes("base64,") || s.length > 200) addB64(s);
			}
			// markdown image
			const md = s.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
			if (md?.[1]) addUrl(md[1]);
			const dataInText = s.match(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\s]+/);
			if (dataInText?.[0]) addB64(dataInText[0]);
			return;
		}
		if (Array.isArray(v)) {
			for (const item of v) visit(item, depth + 1);
			return;
		}
		if (typeof v === "object") {
			// common image fields first
			const urlKeys = ["url", "image_url", "imageUrl", "image", "src", "href"];
			const b64Keys = ["b64_json", "b64", "base64", "image_base64", "imageBase64", "result"];
			for (const k of urlKeys) {
				const val = v[k];
				if (typeof val === "string") {
					if (isHttpUrl(val)) addUrl(val);
					else if (val.startsWith("data:image") || val.length > 200) addB64(val);
				} else if (val && typeof val === "object" && typeof val.url === "string") {
					addUrl(val.url);
				}
			}
			for (const k of b64Keys) {
				if (typeof v[k] === "string" && v[k].length > 32) addB64(v[k]);
			}
			// image_generation_call
			if (v.type === "image_generation_call" && v.result) {
				if (typeof v.result === "string") {
					if (isHttpUrl(v.result)) addUrl(v.result);
					else addB64(v.result);
				}
			}
			// walk nested without re-processing huge strings twice
			for (const [k, val] of Object.entries(v)) {
				if (urlKeys.includes(k) || b64Keys.includes(k)) continue;
				if (k === "usage" || k === "created" || k === "id" || k === "object") continue;
				visit(val, depth + 1);
			}
		}
	};

	visit(json);

	// Prefer URLs to avoid D1 base64 size limits; fall back to base64
	if (preferUrl && urls.length) {
		return urls;
	}
	if (b64s.length) return b64s;
	if (urls.length) return urls;
	return [];
}

/** Download only when we need data URI (e.g. for i2i input). */
export async function ensureDataUri(image: string): Promise<string> {
	if (image.startsWith("data:")) return image;
	if (isHttpUrl(image)) return await fetchUrlToDataURI(image);
	return normalizeBase64Image(image);
}
