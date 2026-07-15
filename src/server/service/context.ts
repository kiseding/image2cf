import type { ExecutionContext } from "hono";
import type { Resend } from "resend";
import type { DrizzleDb } from "../db";

interface ServiceContext {
	db: DrizzleDb;
	AI?: Ai;
	/** Cloudflare R2 bucket binding */
	R2?: R2Bucket;
	resend?: {
		instance: Resend;
		from: string;
	};
	providerCloudflareBuiltin?: boolean;
	/** DEBUG=true */
	debug?: boolean;
	fileStorage?: string;
	credentialsSecret?: string;
	generationQueue?: Queue<GenerationQueueMessage>;
}

export interface GenerationQueueMessage {
	generationId: string;
	userId: string;
	attempt: number;
}

let serviceContext: ServiceContext | null = null;

export const localUserId = "GUEST";

export function initContext(context: ServiceContext): ServiceContext {
	serviceContext = context;
	return serviceContext;
}

export function getContext(): ServiceContext {
	if (!serviceContext) {
		throw new Error("Service context is not initialized");
	}
	return serviceContext;
}

export interface RequestContext {
	userId: string;
	executionCtx?: ExecutionContext;
	/**
	 * When true, createMessageGenerate awaits full image generation (for outer waitUntil).
	 * When false/undefined, HTTP path uses waitUntil + early return to avoid 30s timeout.
	 */
	blockGenerate?: boolean;
}
