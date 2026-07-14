import type { RelayModel } from "@/server/service/relay";

export type RelayProtocol = "openai" | "google";

/** Protocol field guide shown in UI */
export const RELAY_PROTOCOL_GUIDE: Record<
	RelayProtocol,
	{ label: string; basePlaceholder: string; baseHint: string; authHint: string }
> = {
	openai: {
		label: "OpenAI 兼容（生图）",
		basePlaceholder: "https://your-relay.example/v1",
		baseHint: "填到 /v1。生图走 /images/* 或 /responses；多数中转 /models 只列文本模型，生图 ID 需手填或点「常用生图模型」",
		authHint: "Authorization: Bearer <API Key>",
	},
	google: {
		label: "Google 兼容（生图）",
		basePlaceholder: "https://your-relay.example",
		baseHint: "填主机根地址。用于 Gemini / Imagen 等生图模型",
		authHint: "x-goog-api-key 或 Bearer（视中转站文档）",
	},
};

/** Common image model IDs for manual add when /models only returns chat LLMs */
export const COMMON_IMAGE_MODELS: Record<RelayProtocol, RelayModel[]> = {
	openai: [
		{ id: "gpt-image-1", name: "GPT Image 1", ability: "i2i", maxInputImages: 3 },
		{ id: "gpt-image-1.5", name: "GPT Image 1.5", ability: "i2i", maxInputImages: 3 },
		{ id: "gpt-image-1-mini", name: "GPT Image 1 Mini", ability: "i2i", maxInputImages: 3 },
		{ id: "dall-e-3", name: "DALL·E 3", ability: "t2i", maxInputImages: 1 },
		{ id: "dall-e-2", name: "DALL·E 2", ability: "i2i", maxInputImages: 1 },
		{ id: "flux-kontext-pro", name: "FLUX Kontext Pro", ability: "i2i", maxInputImages: 1 },
		{ id: "flux-kontext-max", name: "FLUX Kontext Max", ability: "i2i", maxInputImages: 1 },
		{ id: "flux-dev", name: "FLUX Dev", ability: "t2i", maxInputImages: 1 },
		{ id: "flux-pro", name: "FLUX Pro", ability: "t2i", maxInputImages: 1 },
		{ id: "flux-pro-1.1", name: "FLUX Pro 1.1", ability: "t2i", maxInputImages: 1 },
		{ id: "flux-schnell", name: "FLUX Schnell", ability: "t2i", maxInputImages: 1 },
		{ id: "stable-diffusion-xl", name: "SDXL", ability: "t2i", maxInputImages: 1 },
		{ id: "ideogram-v2", name: "Ideogram V2", ability: "t2i", maxInputImages: 1 },
		{ id: "recraft-v3", name: "Recraft V3", ability: "t2i", maxInputImages: 1 },
	],
	google: [
		{
			id: "gemini-2.0-flash-preview-image-generation",
			name: "Gemini 2.0 Flash Image",
			ability: "i2i",
			maxInputImages: 3,
		},
		{
			id: "gemini-2.5-flash-image-preview",
			name: "Gemini 2.5 Flash Image",
			ability: "i2i",
			maxInputImages: 3,
		},
		{
			id: "gemini-3-pro-image-preview",
			name: "Gemini 3 Pro Image",
			ability: "i2i",
			maxInputImages: 3,
		},
		{ id: "imagen-3.0-generate-002", name: "Imagen 3.0", ability: "t2i", maxInputImages: 1 },
		{ id: "imagen-4.0-generate-001", name: "Imagen 4.0", ability: "t2i", maxInputImages: 1 },
		{ id: "imagen-4.0-ultra-generate-001", name: "Imagen 4.0 Ultra", ability: "t2i", maxInputImages: 1 },
		{ id: "imagen-4.0-fast-generate-001", name: "Imagen 4.0 Fast", ability: "t2i", maxInputImages: 1 },
	],
};

export function normalizeOpenAIBaseURL(url: string) {
	let u = url.trim().replace(/\/+$/, "");
	if (!u) return u;
	if (/\/v\d+[a-z]*$/i.test(u)) return u;
	return `${u}/v1`;
}

export function normalizeGoogleBaseURL(url: string) {
	return url.trim().replace(/\/+$/, "").replace(/\/v1beta$/i, "").replace(/\/v1$/i, "");
}

export function normalizeRelayBaseURL(type: RelayProtocol, url: string) {
	return type === "google" ? normalizeGoogleBaseURL(url) : normalizeOpenAIBaseURL(url);
}

const IMAGE_MODEL_RE =
	/image|imagen|dall-?e|flux|sdxl|stable[-_]?diffusion|midjourney|banana|seedream|kontext|gpt-image|chatgpt-image|i2i|t2i|img2img|inpaint|draw|ideogram|recraft|playground|kandinsky|cogview|wanx|qwen-image|hunyuan[-_]?image|kolors|sd3|sd-3|sd35|dreamshaper|realistic|photon|aura-flow|lumina|sana|hidream|janus|bagel|step1x|grok-.*image|mj_|niji|v6\.|v7\./i;

const IMAGE_EDIT_RE =
	/edit|i2i|img2img|image-to-image|kontext|inpaint|variation|remix|refiner|instruct|image-1/i;

const CHAT_ONLY_RE =
	/^(gpt-4|gpt-3\.5|gpt-3|o1-|o3-|o4-|chatgpt-4|claude|deepseek|qwen\d|qwen-|llama|mistral|mixtral|command-r|chatglm|yi-|internlm|baichuan|moonshot|kimi|glm-|ernie|spark|hunyuan-t|doubao|minimax|gemini-\d+(\.\d+)?-(pro|flash|flash-lite)(-|$)|text-embedding|embedding|tts|whisper|moderation)/i;

/** Whether a remote model id looks like an image-generation model (not chat/LLM). */
export function isLikelyImageModel(id: string, name?: string): boolean {
	const s = `${id} ${name || ""}`;
	// Strong positive for image
	if (IMAGE_MODEL_RE.test(s)) return true;
	// Explicit chat-only
	if (CHAT_ONLY_RE.test(id)) return false;
	return false;
}

/** Heuristic ability for image models only */
export function guessImageModelMeta(id: string, name?: string): Pick<RelayModel, "ability" | "maxInputImages"> {
	const s = `${id} ${name || ""}`;
	const isEdit = IMAGE_EDIT_RE.test(s) || /gpt-image/i.test(s);
	return {
		ability: isEdit ? "i2i" : "t2i",
		maxInputImages: isEdit ? 3 : 1,
	};
}
