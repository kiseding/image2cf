import { base64ToDataURI, fetchUrlToDataURI } from "@/server/lib/util";
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

/**
 * Decide which endpoint to use:
 * - no reference images → t2i (文生图)
 * - has reference images → i2i (图生图)
 * - edit is available as same OpenAI edits contract; used when path differs from i2i
 *   and caller requests "edit" mode (mask-style local edit). For normal 引用/上传 we use i2i.
 */
export function pickEndpointKind(hasImages: boolean, preferEdit = false): keyof RelayEndpoints {
	if (!hasImages) return "t2i";
	if (preferEdit) return "edit";
	return "i2i";
}

function joinUrl(baseURL: string, path: string) {
	const base = baseURL.replace(/\/+$/, "");
	const p = path.startsWith("/") ? path : `/${path}`;
	// avoid double /v1/v1 if user put full path including host
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

function normalizeBase64Image(raw: string): string {
	const s = String(raw || "").trim();
	if (!s) return "";
	if (s.startsWith("data:image")) return s;
	if (s.startsWith("data:")) return s;
	// strip whitespace/newlines from raw base64
	const b64 = s.replace(/\s+/g, "");
	// detect mime from prefix if present
	if (b64.startsWith("/9j/")) return base64ToDataURI(b64, "jpeg");
	if (b64.startsWith("iVBOR")) return base64ToDataURI(b64, "png");
	if (b64.startsWith("R0lGOD")) return base64ToDataURI(b64, "gif");
	if (b64.startsWith("UklGR")) return base64ToDataURI(b64, "webp");
	return base64ToDataURI(b64, "png");
}

async function parseImageResponse(json: any): Promise<string[]> {
	const out: string[] = [];
	const push = async (v: any) => {
		if (!v) return;
		if (typeof v === "string") {
			if (v.startsWith("http://") || v.startsWith("https://")) {
				try {
					out.push(await fetchUrlToDataURI(v));
				} catch {
					/* skip */
				}
			} else {
				const n = normalizeBase64Image(v);
				if (n) out.push(n);
			}
			return;
		}
		if (typeof v === "object") {
			const candidates = [v.b64_json, v.b64, v.base64, v.image_base64, v.imageBase64, v.result];
			// only treat .data as base64 when it is a long string (not nested array/object)
			if (typeof v.data === "string") candidates.push(v.data);
			const url = v.url || v.image_url || v.imageUrl;
			let found = false;
			for (const b64 of candidates) {
				if (typeof b64 === "string" && b64.length > 32 && !b64.startsWith("http")) {
					const n = normalizeBase64Image(b64);
					if (n) {
						out.push(n);
						found = true;
						break;
					}
				}
			}
			if (!found && typeof url === "string") await push(url);
			if (!found && Array.isArray(v.data)) {
				for (const item of v.data) await push(item);
			}
		}
	};

	// OpenAI style
	if (Array.isArray(json?.data)) {
		for (const image of json.data) await push(image);
	}
	// nested images / results
	if (!out.length && Array.isArray(json?.images)) {
		for (const item of json.images) await push(item);
	}
	if (!out.length && Array.isArray(json?.results)) {
		for (const item of json.results) await push(item);
	}
	// single fields
	if (!out.length) {
		await push(json?.image);
		await push(json?.b64_json);
		await push(json?.base64);
		await push(json?.output);
	}
	// output array (responses-like)
	if (!out.length && Array.isArray(json?.output)) {
		for (const item of json.output) {
			if (item?.type === "image_generation_call" && item.result) await push(item.result);
			if (Array.isArray(item?.content)) {
				for (const part of item.content) {
					if (part?.type === "output_image" || part?.type === "image") {
						await push(part.b64_json || part.image_url || part.url || part.result);
					}
					if (part?.type === "output_text" && typeof part.text === "string") {
						const m = part.text.match(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\s]+/);
						if (m?.[0]) await push(m[0].replace(/\s+/g, ""));
					}
				}
			}
		}
	}
	return out;
}

/**
 * Call OpenAI-compatible image endpoints with custom paths.
 * - t2i: JSON POST { model, prompt, n, size }
 * - i2i / edit: multipart { model, prompt, image, n, size }  (OpenAI edits contract)
 *
 * 图生图 vs 编辑图片 (OpenAI):
 * - 图生图 (i2i): 参考图 + 提示词，整图按描述重绘/转换（用户引用历史图时走这里）
 * - 编辑图片 (edit): 同 edits 协议，常用于局部修改；可配不同 path。无 mask 时与 i2i 行为接近，
 *   默认 path 相同；中转若拆成两个 URL，把「编辑」指到另一路径即可。
 */
export async function generateViaEndpointPaths(params: {
	baseURL: string;
	apiKey: string;
	model: string;
	request: TypixGenerateRequest;
	endpoints?: Partial<RelayEndpoints> | null;
	/** force edit path even with images */
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
	// Prefer explicit pixel size from UI; fall back to aspect ratio map
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
					// many relays accept response_format
					response_format: "b64_json",
				}),
			});
		} else {
			// i2i / edit — multipart form (OpenAI images.edit)
			const form = new FormData();
			form.append("model", model);
			form.append("prompt", params.request.prompt || "");
			form.append("n", String(n));
			if (size) form.append("size", size);
			if (width) form.append("width", String(width));
			if (height) form.append("height", String(height));
			form.append("response_format", "b64_json");

			const images = params.request.images || [];
			// OpenAI API: field name "image"; some relays accept multiple as image[]
			if (images[0]) {
				const { blob, filename } = dataUriToBlob(images[0]);
				form.append("image", blob, filename);
			}
			// Extra refs if relay supports image[] / image1...
			for (let i = 1; i < images.length; i++) {
				const { blob, filename } = dataUriToBlob(images[i]!);
				form.append(`image${i}`, blob, filename);
				form.append("image[]", blob, filename);
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
			// Fallback: if i2i failed and edit path differs, try edit once
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

		const images = await parseImageResponse(json);
		return { images };
	} catch (e) {
		console.error(`[relay] ${kind} request error:`, e);
		return { errorReason: "UNKNOWN", images: [] };
	}
}
