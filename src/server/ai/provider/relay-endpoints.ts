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

/**
 * Call OpenAI-compatible image endpoints with custom paths.
 * Prefer URL responses (lighter) over huge base64 in D1.
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

	try {
		let resp: Response;

		if (kind === "t2i") {
			// Prefer url so we can store short https links in D1 (base64 often exceeds D1 row limit)
			resp = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${params.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					prompt: params.request.prompt,
					n,
					...(size ? { size } : {}),
					...(width ? { width } : {}),
					...(height ? { height } : {}),
					response_format: "url",
				}),
			});
		} else {
			const form = new FormData();
			form.append("model", model);
			form.append("prompt", params.request.prompt || "");
			form.append("n", String(n));
			if (size) form.append("size", size);
			if (width) form.append("width", String(width));
			if (height) form.append("height", String(height));
			form.append("response_format", "url");

			const images = params.request.images || [];
			if (images[0]) {
				// images may be https URL or data URI
				let dataUri = images[0];
				if (dataUri.startsWith("http")) {
					// multipart needs file bytes — fetch
					const r = await fetch(dataUri);
					const buf = await r.arrayBuffer();
					const mime = r.headers.get("content-type") || "image/png";
					const ext = mime.split("/")[1] || "png";
					form.append("image", new Blob([buf], { type: mime }), `image.${ext}`);
				} else {
					const { blob, filename } = dataUriToBlob(dataUri);
					form.append("image", blob, filename);
				}
			}
			for (let i = 1; i < images.length; i++) {
				const img = images[i]!;
				if (img.startsWith("http")) {
					const r = await fetch(img);
					const buf = await r.arrayBuffer();
					const mime = r.headers.get("content-type") || "image/png";
					form.append("image[]", new Blob([buf], { type: mime }), `image${i}.png`);
				} else {
					const { blob, filename } = dataUriToBlob(img);
					form.append(`image${i}`, blob, filename);
					form.append("image[]", blob, filename);
				}
			}

			resp = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${params.apiKey}`,
				},
				body: form,
			});
		}

		const text = await resp.text();
		let json: any = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* ignore */
		}

		if (!resp.ok) {
			const msg = json?.error?.message || json?.message || text.slice(0, 300);
			// Some relays reject response_format=url — retry once without it / with b64
			if (
				kind === "t2i" &&
				/response_format|unknown|invalid/i.test(String(msg)) &&
				!params.preferEdit
			) {
				const retry = await fetch(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${params.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model,
						prompt: params.request.prompt,
						n,
						...(size ? { size } : {}),
						...(width ? { width } : {}),
						...(height ? { height } : {}),
					}),
				});
				const retryText = await retry.text();
				let retryJson: any = null;
				try {
					retryJson = JSON.parse(retryText);
				} catch {
					/* ignore */
				}
				if (retry.ok) {
					const imgs = await extractImagesFromAny(retryJson, { preferUrl: true });
					if (imgs.length) return { images: imgs };
					console.error("[relay] ok but no images parsed (retry):", retryText.slice(0, 500));
					return { errorReason: "API_ERROR", images: [] };
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

		const images = await extractImagesFromAny(json, { preferUrl: true });
		if (!images.length) {
			// raw text might be a lone data-uri or url
			if (text.startsWith("http") || text.startsWith("data:image")) {
				return { images: [text.trim()] };
			}
			console.error("[relay] ok but no images parsed:", text.slice(0, 800));
			return { errorReason: "API_ERROR", images: [] };
		}
		return { images };
	} catch (e) {
		console.error(`[relay] ${kind} request error:`, e);
		return { errorReason: "UNKNOWN", images: [] };
	}
}
