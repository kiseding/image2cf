import type { TypixChatApiResponse, TypixGenerateRequest } from "../types/api";
import Google from "./google";
import OpenAI from "./openai";
import { normalizeGoogleBaseURL, normalizeOpenAIBaseURL } from "./relay-presets";
import { generateImageViaResponsesApi } from "./responses-image";

export type RelayApiMode = "auto" | "images" | "responses";

export interface RelayConfig {
	type: "openai" | "google";
	baseURL: string;
	apiKey: string;
	modelId: string;
	/**
	 * OpenAI-compatible only:
	 * - images: /v1/images/generations|edits (classic)
	 * - responses: /v1/responses + image_generation tool
	 * - auto: try responses first for gpt-image-like models, else images; fallback the other way on failure
	 */
	apiMode?: RelayApiMode;
}

function prefersResponsesApi(modelId: string, apiMode?: RelayApiMode): boolean {
	if (apiMode === "responses") return true;
	if (apiMode === "images") return false;
	// auto
	return /gpt-image|chatgpt-image|image-1|o3|o4|gpt-4o/i.test(modelId);
}

/**
 * Generate images via a user-defined relay station.
 */
export async function generateViaRelay(
	request: TypixGenerateRequest,
	relay: RelayConfig,
): Promise<TypixChatApiResponse> {
	const modelId = relay.modelId || request.modelId;

	if (relay.type === "google") {
		const settings = {
			apiKey: relay.apiKey,
			baseURL: normalizeGoogleBaseURL(relay.baseURL),
		};
		return await Google.generate(
			{ ...request, modelId, providerId: "google" },
			settings,
		);
	}

	// OpenAI-compatible relay
	const baseURL = normalizeOpenAIBaseURL(relay.baseURL);
	const useResponses = prefersResponsesApi(modelId, relay.apiMode);

	const viaImages = async () =>
		OpenAI.generate(
			{ ...request, modelId, providerId: "openai" },
			{ apiKey: relay.apiKey, baseURL, model: modelId },
		);

	const viaResponses = async () =>
		generateImageViaResponsesApi({
			baseURL,
			apiKey: relay.apiKey,
			model: modelId,
			request: { ...request, modelId },
		});

	if (relay.apiMode === "images") {
		return await viaImages();
	}
	if (relay.apiMode === "responses") {
		return await viaResponses();
	}

	// auto: primary then fallback
	const primary = useResponses ? viaResponses : viaImages;
	const fallback = useResponses ? viaImages : viaResponses;

	try {
		const result = await primary();
		if (result.images?.length) return result;
		// empty images without hard error → try fallback
		const fb = await fallback();
		return fb.images?.length ? fb : result;
	} catch (e) {
		try {
			return await fallback();
		} catch {
			throw e;
		}
	}
}
