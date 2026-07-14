import { base64ToDataURI, fetchUrlToDataURI } from "@/server/lib/util";

/** Normalize raw base64 / data URI into a data:image URI */
export function normalizeBase64Image(raw: string): string {
	let s = String(raw || "").trim();
	if (!s) return "";
	if (s.startsWith("data:image")) return s.replace(/\s+/g, "");
	if (s.startsWith("data:")) return s;
	// strip whitespace/newlines; support URL-safe base64
	let b64 = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
	if (b64.length < 32) return "";
	// pad
	const pad = b64.length % 4;
	if (pad) b64 += "=".repeat(4 - pad);

	if (b64.startsWith("/9j/")) return base64ToDataURI(b64, "jpeg");
	if (b64.startsWith("iVBOR")) return base64ToDataURI(b64, "png");
	if (b64.startsWith("R0lGOD")) return base64ToDataURI(b64, "gif");
	if (b64.startsWith("UklGR")) return base64ToDataURI(b64, "webp");
	// accept any long base64-ish payload
	if (/^[A-Za-z0-9+/]+=*$/.test(b64.slice(0, 120)) && b64.length > 80) {
		return base64ToDataURI(b64, "png");
	}
	return "";
}

function isHttpUrl(s: string) {
	return /^https?:\/\//i.test(s);
}

/**
 * Extract image data-uris or http(s) URLs from heterogeneous relay responses.
 */
export async function extractImagesFromAny(json: any, opts?: { preferUrl?: boolean }): Promise<string[]> {
	const preferUrl = opts?.preferUrl !== false;
	const urls: string[] = [];
	const b64s: string[] = [];
	const seen = new Set<string>();

	const addUrl = (u: string) => {
		const s = String(u || "").trim();
		if (!s || seen.has(s)) return;
		if (isHttpUrl(s)) {
			seen.add(s);
			urls.push(s);
			return;
		}
		// protocol-relative
		if (s.startsWith("//") && s.length > 8) {
			const full = `https:${s}`;
			if (!seen.has(full)) {
				seen.add(full);
				urls.push(full);
			}
		}
	};

	const addB64 = (raw: string) => {
		const n = normalizeBase64Image(raw);
		if (!n) return;
		const key = `${n.length}:${n.slice(0, 64)}`;
		if (seen.has(key)) return;
		seen.add(key);
		b64s.push(n);
	};

	const visit = (v: any, depth = 0) => {
		if (v == null || depth > 10) return;
		if (typeof v === "string") {
			const s = v.trim();
			if (isHttpUrl(s) || s.startsWith("//")) {
				addUrl(s);
				return;
			}
			if (s.startsWith("data:image") || (s.length > 200 && !s.startsWith("{"))) {
				addB64(s);
			}
			const md = s.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
			if (md?.[1]) addUrl(md[1]);
			const dataInText = s.match(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\s_-]+/);
			if (dataInText?.[0]) addB64(dataInText[0]);
			return;
		}
		if (Array.isArray(v)) {
			for (const item of v) visit(item, depth + 1);
			return;
		}
		if (typeof v === "object") {
			// OpenAI images: { data: [ { b64_json | url } ] }
			if (Array.isArray(v.data)) {
				for (const item of v.data) visit(item, depth + 1);
			}

			const urlKeys = [
				"url",
				"image_url",
				"imageUrl",
				"src",
				"href",
				"file_url",
				"fileUrl",
				"output_url",
				"outputUrl",
			];
			const b64Keys = [
				"b64_json",
				"b64",
				"base64",
				"image_base64",
				"imageBase64",
				"result",
				"image_data",
				"imageData",
				"output",
			];

			for (const k of urlKeys) {
				const val = (v as any)[k];
				if (typeof val === "string") {
					if (isHttpUrl(val) || val.startsWith("//")) addUrl(val);
					else if (val.startsWith("data:image") || val.length > 200) addB64(val);
				} else if (val && typeof val === "object") {
					if (typeof val.url === "string") addUrl(val.url);
					if (typeof val.b64_json === "string") addB64(val.b64_json);
				}
			}
			for (const k of b64Keys) {
				const val = (v as any)[k];
				if (typeof val === "string" && val.length > 32) {
					if (isHttpUrl(val)) addUrl(val);
					else addB64(val);
				}
			}

			// image field can be string | object | array
			if ((v as any).image != null) visit((v as any).image, depth + 1);
			if ((v as any).images != null) visit((v as any).images, depth + 1);

			if ((v as any).type === "image_generation_call" && (v as any).result) {
				visit((v as any).result, depth + 1);
			}

			// nested content (responses API)
			if (Array.isArray((v as any).content)) {
				for (const part of (v as any).content) visit(part, depth + 1);
			}
			if (Array.isArray((v as any).output)) {
				for (const part of (v as any).output) visit(part, depth + 1);
			}

			// walk remaining shallow keys (skip huge already-handled)
			for (const [k, val] of Object.entries(v)) {
				if (urlKeys.includes(k) || b64Keys.includes(k)) continue;
				if (k === "data" || k === "image" || k === "images" || k === "content" || k === "output") continue;
				if (k === "usage" || k === "created" || k === "id" || k === "object" || k === "model") continue;
				if (typeof val === "string" && val.length > 5000) {
					// might be raw base64 under unknown key
					addB64(val);
					continue;
				}
				if (val && typeof val === "object") visit(val, depth + 1);
			}
		}
	};

	visit(json);

	if (preferUrl && urls.length) return urls;
	if (b64s.length) return b64s;
	if (urls.length) return urls;
	return [];
}

/** Summarize response for debug without storing full base64 */
export function summarizeRelayPayload(json: any, text: string): Record<string, unknown> {
	const keys = json && typeof json === "object" ? Object.keys(json).slice(0, 20) : [];
	const data0 =
		json && typeof json === "object" && Array.isArray(json.data) && json.data[0]
			? Object.keys(json.data[0]).slice(0, 15)
			: [];
	return {
		textLen: text?.length ?? 0,
		topKeys: keys,
		data0Keys: data0,
		hasData: Array.isArray(json?.data),
		dataLen: Array.isArray(json?.data) ? json.data.length : 0,
		sample: typeof text === "string" ? text.slice(0, 180).replace(/\s+/g, " ") : "",
	};
}

export async function ensureDataUri(image: string): Promise<string> {
	if (image.startsWith("data:")) return image;
	if (isHttpUrl(image)) return await fetchUrlToDataURI(image);
	return normalizeBase64Image(image);
}
