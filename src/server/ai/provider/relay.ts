import type { TypixChatApiResponse, TypixGenerateRequest } from "../types/api";
import Google from "./google";
import OpenAI from "./openai";
import {
	type RelayEndpoints,
	generateViaEndpointPaths,
	normalizeEndpoints,
} from "./relay-endpoints";
import { normalizeGoogleBaseURL, normalizeOpenAIBaseURL } from "./relay-presets";
import { generateImageViaResponsesApi } from "./responses-image";

export type RelayApiMode = "auto" | "images" | "responses" | "endpoints";

export interface RelayConfig {
	type: "openai" | "google";
	baseURL: string;
	apiKey: string;
	modelId: string;
	apiMode?: RelayApiMode;
	/** Custom paths: 文生图 / 图生图 / 编辑图片 */
	endpoints?: Partial<RelayEndpoints> | null;
}

/**
 * Generate images via user relay.
 * OpenAI-compatible routing (no per-model t2i/i2i flag):
 * - no reference images → endpoints.t2i (文生图)
 * - has reference images → endpoints.i2i (图生图)
 * - edit path used as fallback if i2i fails and path differs
 */
export async function generateViaRelay(
	request: TypixGenerateRequest,
	relay: RelayConfig,
): Promise<TypixChatApiResponse> {
	const modelId = relay.modelId || request.modelId;

	if (relay.type === "google") {
		return await Google.generate(
			{ ...request, modelId, providerId: "google" },
			{ apiKey: relay.apiKey, baseURL: normalizeGoogleBaseURL(relay.baseURL) },
		);
	}

	const baseURL = normalizeOpenAIBaseURL(relay.baseURL);
	const mode = relay.apiMode || "endpoints";
	const endpoints = normalizeEndpoints(relay.endpoints);

	const viaEndpoints = () =>
		generateViaEndpointPaths({
			baseURL,
			apiKey: relay.apiKey,
			model: modelId,
			request: { ...request, modelId },
			endpoints,
		});

	const viaImagesSdk = () =>
		OpenAI.generate(
			{ ...request, modelId, providerId: "openai" },
			{ apiKey: relay.apiKey, baseURL, model: modelId },
		);

	const viaResponses = () =>
		generateImageViaResponsesApi({
			baseURL,
			apiKey: relay.apiKey,
			model: modelId,
			request: { ...request, modelId },
		});

	if (mode === "endpoints") {
		return await viaEndpoints();
	}
	if (mode === "images") {
		return await viaImagesSdk();
	}
	if (mode === "responses") {
		return await viaResponses();
	}

	// auto: endpoints first (path-based), then responses for gpt-image, then images SDK
	const hasImages = !!(request.images && request.images.length > 0);
	const tryOrder = hasImages
		? [viaEndpoints, viaResponses, viaImagesSdk]
		: /gpt-image|image-1/i.test(modelId)
			? [viaResponses, viaEndpoints, viaImagesSdk]
			: [viaEndpoints, viaImagesSdk, viaResponses];

	let last: TypixChatApiResponse = { images: [] };
	let lastErr: unknown;
	for (const fn of tryOrder) {
		try {
			const r = await fn();
			if (r.images?.length) return r;
			last = r;
		} catch (e) {
			lastErr = e;
		}
	}
	if (lastErr && !last.images?.length) throw lastErr;
	return last;
}
