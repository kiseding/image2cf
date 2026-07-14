import { extractImagesFromAny, summarizeRelayPayload } from "@/server/lib/image-parse";
import type { TypixChatApiResponse, TypixGenerateRequest } from "../types/api";
import { normalizeOpenAIBaseURL } from "./relay-presets";

export type RelayEndpoints = {
	t2i: string;
	i2i: string;
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

/** Default upstream timeout (ms) */
const RELAY_FETCH_TIMEOUT_MS = 180_000;
/** Allow large b64_json bodies (gpt-image can be multi‑MB) */
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

export type RelayCallMeta = {
	url: string;
	kind: string;
	httpStatus?: number;
	ok?: boolean;
	bodyBytes?: number;
	parseSummary?: Record<string, unknown>;
	imageCount?: number;
	error?: string;
	ms?: number;
};

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = RELAY_FETCH_TIMEOUT_MS, externalSignal?: AbortSignal) {
	const ctrl = new AbortController();
	const onAbort = () => ctrl.abort();
	if (externalSignal) {
		if (externalSignal.aborted) ctrl.abort();
		else externalSignal.addEventListener("abort", onAbort, { once: true });
	}
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: ctrl.signal });
	} finally {
		clearTimeout(timer);
		externalSignal?.removeEventListener("abort", onAbort);
	}
}

async function readResponseText(resp: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<{ text: string; bytes: number }> {
	const cl = resp.headers.get("content-length");
	if (cl && Number(cl) > maxBytes) {
		throw Object.assign(new Error(`Response too large: ${cl} bytes`), { name: "AbortError" });
	}
	const buf = await resp.arrayBuffer();
	if (buf.byteLength > maxBytes) {
		throw Object.assign(new Error(`Response too large: ${buf.byteLength} bytes`), { name: "AbortError" });
	}
	return { text: new TextDecoder().decode(buf), bytes: buf.byteLength };
}

async function parseOkResponse(text: string, json: any): Promise<{ images: string[]; summary: Record<string, unknown> }> {
	const summary = summarizeRelayPayload(json, text);
	const images = await extractImagesFromAny(json, { preferUrl: true });
	if (images.length) return { images, summary };
	if (text.startsWith("http") || text.startsWith("data:image")) {
		return { images: [text.trim()], summary };
	}
	if (typeof json === "string") {
		try {
			const nested = JSON.parse(json);
			const imgs2 = await extractImagesFromAny(nested, { preferUrl: true });
			if (imgs2.length) return { images: imgs2, summary: summarizeRelayPayload(nested, text) };
		} catch {
			/* ignore */
		}
	}
	// last resort: scan entire text for data-uri or https image urls
	const dataUris = text.match(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\r\n_-]{80,}/g);
	if (dataUris?.length) {
		return { images: dataUris.map((s) => s.replace(/\s+/g, "")), summary };
	}
	const httpImgs = text.match(/https?:\/\/[^\s"'\\]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'\\]*)?/gi);
	if (httpImgs?.length) {
		return { images: [...new Set(httpImgs)], summary };
	}
	console.error("[relay] ok but no images parsed:", summary);
	return { images: [], summary };
}

/**
 * Call OpenAI-compatible image endpoints with custom paths.
 */
export async function generateViaEndpointPaths(params: {
	baseURL: string;
	apiKey: string;
	model: string;
	request: TypixGenerateRequest;
	endpoints?: Partial<RelayEndpoints> | null;
	preferEdit?: boolean;
	signal?: AbortSignal;
	/** Collect diagnostics for DB progress */
	onMeta?: (meta: RelayCallMeta) => void;
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
	const t0 = Date.now();

	const baseBody: Record<string, unknown> = {
		model,
		prompt: params.request.prompt,
		n,
		...(size ? { size } : {}),
		...(width ? { width } : {}),
		...(height ? { height } : {}),
	};

	const report = (meta: Partial<RelayCallMeta>) => {
		params.onMeta?.({ url, kind, ms: Date.now() - t0, ...meta });
	};

	try {
		let resp: Response;

		if (kind === "t2i") {
			// Try without response_format first (widest relay compatibility)
			resp = await fetchWithTimeout(
				url,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${params.apiKey}`,
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify(baseBody),
				},
				RELAY_FETCH_TIMEOUT_MS,
				params.signal,
			);
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
					const r = await fetchWithTimeout(dataUri, {}, 60_000, params.signal);
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
					const r = await fetchWithTimeout(img, {}, 60_000, params.signal);
					const buf = await r.arrayBuffer();
					const mime = r.headers.get("content-type") || "image/png";
					form.append("image[]", new Blob([buf], { type: mime }), `image${i}.png`);
				} else {
					const { blob, filename } = dataUriToBlob(img);
					form.append(`image${i}`, blob, filename);
					form.append("image[]", blob, filename);
				}
			}

			resp = await fetchWithTimeout(
				url,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${params.apiKey}`,
						Accept: "application/json",
					},
					body: form,
				},
				RELAY_FETCH_TIMEOUT_MS,
				params.signal,
			);
		}

		const { text, bytes } = await readResponseText(resp);
		let json: any = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* ignore */
		}

		report({ httpStatus: resp.status, ok: resp.ok, bodyBytes: bytes });

		if (!resp.ok) {
			const msg = json?.error?.message || json?.message || text.slice(0, 300);

			// Retry t2i with b64_json if relay complains about format / empty
			if (kind === "t2i") {
				const retry = await fetchWithTimeout(
					url,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${params.apiKey}`,
							"Content-Type": "application/json",
							Accept: "application/json",
						},
						body: JSON.stringify({ ...baseBody, response_format: "b64_json" }),
					},
					RELAY_FETCH_TIMEOUT_MS,
					params.signal,
				);
				const retryRead = await readResponseText(retry);
				let retryJson: any = null;
				try {
					retryJson = JSON.parse(retryRead.text);
				} catch {
					/* ignore */
				}
				if (retry.ok) {
					const parsed = await parseOkResponse(retryRead.text, retryJson);
					report({
						httpStatus: retry.status,
						ok: true,
						bodyBytes: retryRead.bytes,
						parseSummary: parsed.summary,
						imageCount: parsed.images.length,
					});
					if (parsed.images.length) return { images: parsed.images };
					return { errorReason: "API_ERROR", images: [] };
				}
			}

			if (kind === "i2i" && endpoints.edit !== endpoints.i2i) {
				return generateViaEndpointPaths({ ...params, preferEdit: true });
			}
			if (resp.status === 401 || resp.status === 403) {
				report({ error: msg, httpStatus: resp.status });
				return { errorReason: "CONFIG_ERROR", images: [] };
			}
			if (resp.status === 429) {
				return { errorReason: "TOO_MANY_REQUESTS", images: [] };
			}
			console.error(`[relay] ${kind} ${url} failed:`, resp.status, msg);
			report({ error: String(msg).slice(0, 200), httpStatus: resp.status, parseSummary: summarizeRelayPayload(json, text) });
			return { errorReason: "API_ERROR", images: [] };
		}

		const parsed = await parseOkResponse(text, json);
		report({
			httpStatus: resp.status,
			ok: true,
			bodyBytes: bytes,
			parseSummary: parsed.summary,
			imageCount: parsed.images.length,
		});
		if (!parsed.images.length) {
			console.error("[relay] empty parse", url, parsed.summary);
			return { errorReason: "API_ERROR", images: [] };
		}
		return { images: parsed.images };
	} catch (e: any) {
		const name = e?.name || "";
		const msg = e?.message || String(e);
		console.error(`[relay] ${kind} request error:`, msg);
		report({ error: msg.slice(0, 200) });
		if (name === "AbortError" || /aborted|timeout/i.test(msg)) {
			return { errorReason: "TIMEOUT", images: [] };
		}
		return { errorReason: "UNKNOWN", images: [] };
	}
}
