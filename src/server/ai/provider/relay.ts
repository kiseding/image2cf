import type { TypixGenerateRequest, TypixChatApiResponse } from "../types/api";
import OpenAI from "./openai";
import Google from "./google";
import { normalizeGoogleBaseURL, normalizeOpenAIBaseURL } from "./relay-presets";

export interface RelayConfig {
	type: "openai" | "google";
	baseURL: string;
	apiKey: string;
	modelId: string;
}

/**
 * Generate images via a user-defined relay station.
 * Reuses OpenAI / Google provider implementations with custom baseURL + apiKey.
 */
export async function generateViaRelay(
	request: TypixGenerateRequest,
	relay: RelayConfig,
): Promise<TypixChatApiResponse> {
	const baseURL =
		relay.type === "google"
			? normalizeGoogleBaseURL(relay.baseURL)
			: normalizeOpenAIBaseURL(relay.baseURL);

	const settings = {
		apiKey: relay.apiKey,
		baseURL,
		...(relay.type === "openai" ? { model: relay.modelId || request.modelId } : {}),
	};

	const generateRequest: TypixGenerateRequest = {
		...request,
		modelId: relay.modelId || request.modelId,
		// For OpenAI provider, model id is also taken from settings.model
		providerId: relay.type === "google" ? "google" : "openai",
	};

	if (relay.type === "google") {
		return await Google.generate(generateRequest, settings);
	}

	// OpenAI-compatible: /v1/images/generations & /v1/images/edits
	return await OpenAI.generate(generateRequest, settings);
}
