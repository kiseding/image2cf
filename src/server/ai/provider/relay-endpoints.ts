import { extractImagesFromAny } from "@/server/lib/image-parse";
import type { TypixChatApiResponse, TypixGenerateRequest } from "../types/api";
import { normalizeOpenAIBaseURL } from "./relay-presets";

export type RelayEndpoints = {
	/** 文生图 · text-to-image */
	t2i: string;
	/** 图生图 · image-to-image (prompt + image) */
	i2i: string;
	/** 编辑图片 · edit (prompt + image, optional mask; OpenAI /images/edits) */
	edit: string;
};

export const DEFAULT_OPENAI_ENDPOINTS: RelayEndpoints = {
	t2i: "/images/generations",
	i2i: "/images/edits",
	edit: "/images/edits",
};

export function normalizeEndpoints(input?: Partial<RelayEndpoints> | null): RelayEndpoints {
	const pick = (v: string | undefined, fallback: string) => {
		const s = (v || "").trim();
		if (!s) return fallback;
		return s.startsWith("/") ? s : `/${s}`;
	};
	return {
		t2i: pick(input?.t2i, DEFAULT_OPENAI_ENDPOINTS.t2i),
		i2i: pick(input?.i2i, DEFAULT_OPENAI_ENDPOINTS.i2i),
		edit: pick(input?.edit, DEFAULT_OPENAI_ENDPOINTS.edit),
	};
}

export function pickEndpointKind(hasImages: boolean, preferEdit = false): keyof RelayEndpoints {
	if (!hasImages) return "t2i";
	if (preferEdit) return "edit";
	return "i2i";
}

function joinUrl(baseURL: string, path: string) {
	const base = baseURL.replace(/\/+$/, "");
	const p = path.startsWith("/") ? path : `/${path}`;
	if (/^https?:\/\//i.test(path)) return path;
	return `${base}${p}`;
}

function dataUriToBlob(dataUri: string): { blob: Blob; filename: string; mime: string } {
	const [meta, b64] = dataUri.split(",");
	if (!b64 || !meta) throw new Error("Invalid DataURI");
	const mimeMatch = meta.match(/data:([^;]+)/);
	const mime = mimeMatch?.[1] || "image/png";
	const ext = mime.split("/")[1] || "png";
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return { blob: new Blob([bytes], { type: mime }), filename: `image.${ext}`, mime };
}

const sizeMap: Record<string, string> = {
	"1:1": "1024x1024",
	"16:9": "1792x1024",
	"9:16": "1024x1792",
	"4:3": "1536x1024",
	"3:4": "1024x1536",
};

/** Relay fetch timeout (ms). Large b64 bodies can hang; fail cleanly instead of stuck UI. */
const RELAY_FETCH_TIMEOUT_MS = 90_000;
/** Max response body to parse (bytes). Prevents multi-minute base64 text reads. */
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = RELAY_FETCH_TIMEOUT_MS) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: ctrl.signal });
	} finally {
		clearTimeout(timer);
	}
}

async function readResponseTextLimited(resp: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
	const cl = resp.headers.get("content-length");
	if (cl && Number(cl) > maxBytes) {
		throw Object.assign(new Error(`Response too large: ${cl} bytes`), { name: "AbortError" });
	}
	// Prefer arrayBuffer with size check over unbounded text()
	const buf = await resp.arrayBuffer();
	if (buf.byteLength > maxBytes) {
		throw Object.assign(new Error(`Response too large: ${buf.byteLength} bytes`), { name: "AbortError" });
	}
	return new TextDecoder().decode(buf);
}

async function parseOkResponse(text: string, json: any): Promise<TypixChatApiResponse> {
	const images = await extractImagesFromAny(json, { preferUrl: true });
	if (images.length) return { images };
	if (text.startsWith("http") || text.startsWith("data:image")) {
		return { images: [text.trim()] };
	}
	// Some relays wrap JSON as string
	if (typeof json === "string") {
		try {
			const nested = JSON.parse(json);
			const imgs2 = await extractImagesFromAny(nested, { preferUrl: true });
			if (imgs2.length) return { images: imgs2 };
		} catch {
			/* ignore */
		}
	}
	console.error("[relay] ok but no images parsed:", text.slice(0, 800));
	return { errorReason: "API_ERROR", images: [] };
}

/**
 * Call OpenAI-compatible image endpoints with custom paths.
 * Prefer URL responses when possible; always accept b64_json too.
 */
export async function generateViaEndpointPaths(params: {
	baseURL: string;
	apiKey: string;
	model: string;
	request: TypixGenerateRequest;
	endpoints?: Partial<RelayEndpoints> | null;
	preferEdit?: boolean;
}): Promise<TypixChatApiResponse> {
	const baseURL = normalizeOpenAIBaseURL(params.baseURL);
	const endpoints = normalizeEndpoints(params.endpoints);
	const hasImages = !!(params.request.images && params.request.images.length > 0);
	const kind = pickEndpointKind(hasImages, params.preferEdit);
	const path = endpoints[kind];
	const url = joinUrl(baseURL, path);
	const model = params.model;
	const n = params.request.n || 1;
	const size =
		params.request.width && params.request.height
			? `${params.request.width}x${params.request.height}`
			: params.request.aspectRatio
				? sizeMap[params.request.aspectRatio]
				: undefined;
	const width = params.request.width;
	const height = params.request.height;

	const baseBody = {
		model,
		prompt: params.request.prompt,
		n,
		...(size ? { size } : {}),
		...(width ? { width } : {}),
		...(height ? { height } : {}),
	};

	try {
		let resp: Response;

		if (kind === "t2i") {
			// Do NOT force response_format first — many Chinese relays reject or ignore it.
			// Prefer natural response (url or b64_json). Retry with url / without format if needed.
			resp = await fetchWithTimeout(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${params.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(baseBody),
			});
		} else {
			const form = new FormData();
			form.append("model", model);
			form.append("prompt", params.request.prompt || "");
			form.append("n", String(n));
			if (size) form.append("size", size);
			if (width) form.append("width", String(width));
			if (height) form.append("height", String(height));

			const images = params.request.images || [];
			if (images[0]) {
				const dataUri = images[0];
				if (dataUri.startsWith("http")) {
					const r = await fetchWithTimeout(dataUri, {}, 30_000);
					const buf = await r.arrayBuffer();
					const mime = r.headers.get("content-type") || "image/png";
					const ext = (mime.split("/")[1] || "png").split(";")[0] || "png";
					form.append("image", new Blob([buf], { type: mime }), `image.${ext}`);
				} else {
					const { blob, filename } = dataUriToBlob(dataUri);
					form.append("image", blob, filename);
				}
			}
			for (let i = 1; i < images.length; i++) {
				const img = images[i]!;
				if (img.startsWith("http")) {
					const r = await fetchWithTimeout(img, {}, 30_000);
					const buf = await r.arrayBuffer();
					const mime = r.headers.get("content-type") || "image/png";
					form.append("image[]", new Blob([buf], { type: mime }), `image${i}.png`);
				} else {
					const { blob, filename } = dataUriToBlob(img);
					form.append(`image${i}`, blob, filename);
					form.append("image[]", blob, filename);
				}
			}

			resp = await fetchWithTimeout(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${params.apiKey}`,
				},
				body: form,
			});
		}

		const text = await readResponseTextLimited(resp);
		let json: any = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* ignore */
		}

		if (!resp.ok) {
			const msg = json?.error?.message || json?.message || text.slice(0, 300);

			// Retry t2i once with response_format=url if first failed on format issues
			if (kind === "t2i" && /response_format|unknown|invalid|format/i.test(String(msg))) {
				const retry = await fetchWithTimeout(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${params.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ ...baseBody, response_format: "b64_json" }),
				});
				const retryText = await readResponseTextLimited(retry);
				let retryJson: any = null;
				try {
					retryJson = JSON.parse(retryText);
				} catch {
					/* ignore */
				}
				if (retry.ok) {
					return await parseOkResponse(retryText, retryJson);
				}
			}

			if (kind === "i2i" && endpoints.edit !== endpoints.i2i) {
				return generateViaEndpointPaths({ ...params, preferEdit: true });
			}
			if (resp.status === 401 || resp.status === 403) {
				return { errorReason: "CONFIG_ERROR", images: [] };
			}
			if (resp.status === 429) {
				return { errorReason: "TOO_MANY_REQUESTS", images: [] };
			}
			console.error(`[relay] ${kind} ${url} failed:`, resp.status, msg);
			return { errorReason: "API_ERROR", images: [] };
		}

		return await parseOkResponse(text, json);
	} catch (e: any) {
		const name = e?.name || "";
		const msg = e?.message || String(e);
		console.error(`[relay] ${kind} request error:`, msg);
		if (name === "AbortError" || /aborted|timeout/i.test(msg)) {
			return { errorReason: "TIMEOUT", images: [] };
		}
		return { errorReason: "UNKNOWN", images: [] };
	}
}
