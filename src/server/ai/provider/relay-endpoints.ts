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

async function parseImageResponse(json: any): Promise<string[]> {
	const out: string[] = [];
	const data = Array.isArray(json?.data) ? json.data : [];
	for (const image of data) {
		if (image?.b64_json) {
			out.push(base64ToDataURI(String(image.b64_json)));
		} else if (image?.url) {
			try {
				out.push(await fetchUrlToDataURI(String(image.url)));
			} catch {
				/* skip */
			}
		}
	}
	// Some relays nest under result/images
	if (!out.length && Array.isArray(json?.images)) {
		for (const item of json.images) {
			if (typeof item === "string") {
				if (item.startsWith("data:")) out.push(item);
				else if (item.startsWith("http")) {
					try {
						out.push(await fetchUrlToDataURI(item));
					} catch {
						/* skip */
					}
				} else out.push(base64ToDataURI(item));
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
	const size = params.request.aspectRatio ? sizeMap[params.request.aspectRatio] : undefined;

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
