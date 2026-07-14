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
		baseHint: "填到 /v1。生图调用 /images/generations、/images/edits；可拉取 /models 中的生图模型",
		authHint: "Authorization: Bearer <API Key>",
	},
	google: {
		label: "Google 兼容（生图）",
		basePlaceholder: "https://your-relay.example",
		baseHint: "填主机根地址。用于 Gemini / Imagen 等生图模型",
		authHint: "x-goog-api-key 或 Bearer（视中转站文档）",
	},
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
	/image|imagen|dall-?e|flux|sdxl|stable-?diffusion|midjourney|banana|seedream|kontext|gpt-image|i2i|t2i|img2img|inpaint|draw|ideogram|recraft|playground|kandinsky|cogview|wanx|qwen-image|hunyuan-image|kolors|sd3|sd-3/i;

const IMAGE_EDIT_RE =
	/edit|i2i|img2img|image-to-image|kontext|inpaint|variation|remix|refiner|instruct/i;

/** Whether a remote model id looks like an image-generation model (not chat/LLM). */
export function isLikelyImageModel(id: string, name?: string): boolean {
	const s = `${id} ${name || ""}`;
	if (
		/^(gpt-4|gpt-3|o1|o3|o4|claude|deepseek|qwen(?!-image)|llama|mistral|gemini-.*-pro$|gemini-.*-flash$|command-r|chat)/i.test(
			id,
		) &&
		!IMAGE_MODEL_RE.test(s)
	) {
		return false;
	}
	return IMAGE_MODEL_RE.test(s);
}

/** Heuristic ability for image models only */
export function guessImageModelMeta(id: string, name?: string): Pick<RelayModel, "ability" | "maxInputImages"> {
	const s = `${id} ${name || ""}`;
	const isEdit = IMAGE_EDIT_RE.test(s);
	return {
		ability: isEdit ? "i2i" : "t2i",
		maxInputImages: isEdit ? 3 : 1,
	};
}
