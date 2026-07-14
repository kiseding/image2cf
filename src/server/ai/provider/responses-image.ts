import { extractImagesFromAny } from "@/server/lib/image-parse";
import { base64ToDataURI, fetchUrlToDataURI } from "@/server/lib/util";
import openai from "openai";
import type { TypixChatApiResponse, TypixGenerateRequest } from "../types/api";
import { normalizeOpenAIBaseURL } from "./relay-presets";

const sizeMap: Record<string, "1024x1024" | "1024x1536" | "1536x1024" | "auto"> = {
	"1:1": "1024x1024",
	"3:4": "1024x1536",
	"4:3": "1536x1024",
	"9:16": "1024x1536",
	"16:9": "1536x1024",
};

/**
 * Image generation via OpenAI Responses API:
 * POST /v1/responses with tools: [{ type: "image_generation" }]
 * Used by modern relays (e.g. apikey.fun) for gpt-image / multimodal image models.
 */
export async function generateImageViaResponsesApi(params: {
	baseURL: string;
	apiKey: string;
	model: string;
	request: TypixGenerateRequest;
}): Promise<TypixChatApiResponse> {
	const baseURL = normalizeOpenAIBaseURL(params.baseURL);
	const client = new openai.OpenAI({
		baseURL,
		apiKey: params.apiKey,
		dangerouslyAllowBrowser: true,
	});

	const size = params.request.aspectRatio ? sizeMap[params.request.aspectRatio] || "auto" : "auto";
	const n = Math.min(Math.max(params.request.n || 1, 1), 4);

	// Build multimodal input
	const content: any[] = [{ type: "input_text", text: params.request.prompt }];
	if (params.request.images?.length) {
		for (const dataUri of params.request.images) {
			content.push({
				type: "input_image",
				image_url: dataUri,
			});
		}
	}

	const body: any = {
		model: params.model,
		input: [
			{
				role: "user",
				content,
			},
		],
		tools: [
			{
				type: "image_generation",
				// Optional hints; relays may ignore unknown fields
				model: params.model.includes("gpt-image") ? "gpt-image-1" : undefined,
				size,
			},
		],
		tool_choice: { type: "image_generation" },
		// Some relays require this for tool results
		store: false,
	};

	// Request multiple images by repeating tool preference when n > 1
	// (Responses API typically returns one image_generation_call per tool use;
	//  we issue sequential calls if n > 1 after first response if needed.)
	const images: string[] = [];

	try {
		const first = await client.responses.create(body);
		images.push(...(await extractImagesFromResponse(first)));

		// Extra images if requested and first call only returned one
		while (images.length < n) {
			const more = await client.responses.create(body);
			const got = await extractImagesFromResponse(more);
			if (!got.length) break;
			images.push(...got);
		}
	} catch (e: any) {
		if (e instanceof openai.AuthenticationError || e?.status === 401) {
			return { errorReason: "CONFIG_ERROR", images: [] };
		}
		if (e instanceof openai.NotFoundError || e?.status === 404) {
			return { errorReason: "CONFIG_ERROR", images: [] };
		}
		// Rate limit
		if (e?.status === 429) {
			return { errorReason: "TOO_MANY_REQUESTS", images: [] };
		}
		throw e;
	}

	return { images: images.slice(0, n) };
}

async function extractImagesFromResponse(response: any): Promise<string[]> {
	const out: string[] = [];
	const items: any[] = Array.isArray(response?.output) ? response.output : [];

	for (const item of items) {
		// Official shape: image_generation_call with base64 result
		if (item?.type === "image_generation_call" && item.result) {
			const r = String(item.result);
			out.push(r.startsWith("data:") ? r : base64ToDataURI(r));
			continue;
		}

		// Some relays put images inside message content
		if (item?.type === "message" && Array.isArray(item.content)) {
			for (const part of item.content) {
				if (part?.type === "output_image" || part?.type === "image") {
					const b64 = part.b64_json || part.image_base64 || part.result;
					const url = part.image_url || part.url;
					if (b64) {
						out.push(String(b64).startsWith("data:") ? b64 : base64ToDataURI(String(b64)));
					} else if (url) {
						try {
							out.push(await fetchUrlToDataURI(String(url)));
						} catch {
							/* skip */
						}
					}
				}
				// Markdown image in output_text
				if (part?.type === "output_text" && typeof part.text === "string") {
					const md = part.text.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
					if (md?.[1]) {
						try {
							out.push(await fetchUrlToDataURI(md[1]));
						} catch {
							/* skip */
						}
					}
					const dataUri = part.text.match(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/);
					if (dataUri?.[0]) out.push(dataUri[0]);
				}
			}
		}
	}

	// Fallback: top-level data array (some proxies mirror images API)
	if (!out.length && Array.isArray(response?.data)) {
		for (const image of response.data) {
			if (image.b64_json) out.push(base64ToDataURI(image.b64_json));
			else if (image.url) {
				// keep URL — avoid huge base64 in D1
				out.push(String(image.url));
			}
		}
	}

	if (!out.length) {
		return await extractImagesFromAny(response, { preferUrl: true });
	}

	return out;
}
