import type { TypixGenerateRequest, TypixChatApiResponse } from "../types/api";
import OpenAI from "./openai";
import Google from "./google";

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
	const settings = {
		apiKey: relay.apiKey,
		baseURL: relay.baseURL,
		...(relay.type === "openai" ? { model: relay.modelId || request.modelId } : {}),
	};

	const generateRequest: TypixGenerateRequest = {
		...request,
		modelId: relay.modelId || request.modelId,
	};

	if (relay.type === "google") {
		return await Google.generate(generateRequest, settings);
	}

	// Default: OpenAI-compatible images API
	return await OpenAI.generate(generateRequest, settings);
}
