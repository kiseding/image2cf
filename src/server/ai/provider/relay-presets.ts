import type { RelayModel } from "@/server/service/relay";

export type RelayPreset = {
	id: string;
	name: string;
	description: string;
	type: "openai" | "google";
	baseURL: string;
	/** Shown as placeholder for API key */
	apiKeyPlaceholder?: string;
	docsUrl?: string;
	models: RelayModel[];
};

/**
 * Built-in presets for popular Chinese AI relay stations.
 * Users still paste their own API key.
 */
export const RELAY_PRESETS: RelayPreset[] = [
	{
		id: "apikey-fun-openai",
		name: "APIKEY.FUN · OpenAI 兼容",
		description: "推荐生产环境（CF 企业级）· OpenAI Images / Chat 兼容",
		type: "openai",
		baseURL: "https://api.apikey.fun/v1",
		apiKeyPlaceholder: "sk-...",
		docsUrl: "https://apikey.fun/docs#ApiScripts",
		models: [
			{
				id: "gpt-image-1",
				name: "GPT Image 1",
				ability: "i2i",
				maxInputImages: 3,
				supportedAspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
			},
			{
				id: "gpt-image-1.5",
				name: "GPT Image 1.5",
				ability: "i2i",
				maxInputImages: 3,
				supportedAspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
			},
			{
				id: "dall-e-3",
				name: "DALL·E 3",
				ability: "t2i",
				maxInputImages: 1,
				supportedAspectRatios: ["1:1", "16:9", "9:16"],
			},
			{
				id: "flux-kontext-pro",
				name: "FLUX Kontext Pro",
				ability: "i2i",
				maxInputImages: 1,
			},
			{
				id: "flux-kontext-max",
				name: "FLUX Kontext Max",
				ability: "i2i",
				maxInputImages: 1,
			},
		],
	},
	{
		id: "apikey-fun-openai-slb",
		name: "APIKEY.FUN · 专线直连 (OpenAI)",
		description: "低延迟专线 · OpenAI 兼容",
		type: "openai",
		baseURL: "https://slb.apikey.fun/v1",
		apiKeyPlaceholder: "sk-...",
		docsUrl: "https://apikey.fun/docs#ApiScripts",
		models: [
			{
				id: "gpt-image-1",
				name: "GPT Image 1",
				ability: "i2i",
				maxInputImages: 3,
				supportedAspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
			},
			{
				id: "gpt-image-1.5",
				name: "GPT Image 1.5",
				ability: "i2i",
				maxInputImages: 3,
			},
			{
				id: "dall-e-3",
				name: "DALL·E 3",
				ability: "t2i",
				maxInputImages: 1,
			},
		],
	},
	{
		id: "apikey-fun-google",
		name: "APIKEY.FUN · Google 兼容",
		description: "Gemini / Imagen 等 Google GenAI 兼容接口",
		type: "google",
		// Google GenAI SDK uses base host; paths like /v1beta are appended by SDK
		baseURL: "https://api.apikey.fun",
		apiKeyPlaceholder: "sk-...",
		docsUrl: "https://apikey.fun/docs#ApiScripts",
		models: [
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
			{
				id: "imagen-4.0-generate-001",
				name: "Imagen 4.0",
				ability: "t2i",
				maxInputImages: 1,
			},
			{
				id: "imagen-4.0-ultra-generate-001",
				name: "Imagen 4.0 Ultra",
				ability: "t2i",
				maxInputImages: 1,
			},
		],
	},
];

export function getRelayPreset(id: string) {
	return RELAY_PRESETS.find((p) => p.id === id);
}

/** Normalize base URL for OpenAI-compatible relays (ensure trailing /v1) */
export function normalizeOpenAIBaseURL(url: string) {
	let u = url.trim().replace(/\/+$/, "");
	if (!u) return u;
	// Already ends with /v1 or /v1beta etc.
	if (/\/v\d+[a-z]*$/i.test(u)) return u;
	// Common mistake: only host
	return `${u}/v1`;
}

export function normalizeGoogleBaseURL(url: string) {
	// Google SDK expects host root, not /v1
	return url.trim().replace(/\/+$/, "").replace(/\/v1beta$/i, "").replace(/\/v1$/i, "");
}
