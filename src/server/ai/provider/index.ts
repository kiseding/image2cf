import { ServiceException } from "@/server/lib/exception";
import type { AiProvider } from "../types/provider";
import { default as cloudflare } from "./cloudflare";
import { default as fal } from "./fal";
import { default as flux } from "./flux";
import { default as google } from "./google";
import { default as openAI } from "./openai";

export const AI_PROVIDERS = [cloudflare, google, openAI, flux, fal].map(enhancedProvider);

export function getDefaultProvider() {
	return AI_PROVIDERS[0]!;
}

export function getProviderById(providerId: string) {
	// Relay stations are virtual providers resolved at runtime
	if (providerId.startsWith("relay:")) {
		throw new ServiceException("not_found", "Relay provider must be resolved via relayService");
	}
	const provider = AI_PROVIDERS.find((provider) => provider.id === providerId);
	if (!provider) {
		throw new ServiceException("not_found", "AI provider not found in system");
	}
	return provider;
}

export function getModelById(providerId: string, modelId: string) {
	if (providerId.startsWith("relay:")) {
		// Virtual model placeholder for client-side capability checks
		return {
			id: modelId,
			name: modelId,
			ability: "i2i" as const,
			maxInputImages: 3,
			enabledByDefault: true,
		};
	}
	const provider = getProviderById(providerId);
	const model = provider.models.find((model) => model.id === modelId);
	if (!model) {
		throw new ServiceException("not_found", `Model ${modelId} not found in provider ${providerId}`);
	}
	return model;
}

function enhancedProvider(provider: AiProvider): AiProvider {
	return {
		...provider,
		generate: provider.generate,
	};
}
