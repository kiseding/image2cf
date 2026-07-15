import { getProviderById } from "@/server/ai/provider";
import { generateViaRelay } from "@/server/ai/provider/relay";
import { type ApiProviderSettings, ConfigInvalidError } from "@/server/ai/types/provider";
import { chats, messageAttachments, messageGenerations, messages } from "@/server/db/schemas";
import { createSchemaOmits } from "@/server/db/util";
import { inBrowser, inCfWorker } from "@/server/lib/env";
import { ServiceException } from "@/server/lib/exception";
import { and, desc, eq, inArray, lt, ne, or } from "drizzle-orm";
import { createInsertSchema, createUpdateSchema } from "drizzle-zod";
import z from "zod/v4";
import { aiService } from "../ai";
import { type RequestContext, getContext } from "../context";
import { deleteStoredFiles, getFileData, getFileUrl, saveFiles } from "../file/storage";
import { relayService } from "../relay";

export const CreateChatSchema = createInsertSchema(chats)
	.pick({
		title: true,
		provider: true,
		model: true,
	})
	.extend({
		content: z.string().optional(),
		/**
		 * Number of images to generate
		 */
		imageCount: z.number().int().min(1).max(10).default(1),
		/**
		 * Pixel size (preferred)
		 */
		width: z.number().int().min(64).max(4096).optional(),
		height: z.number().int().min(64).max(4096).optional(),
		/**
		 * Aspect ratio for image generation (legacy)
		 */
		aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
		/**
		 * Attachments for the first message
		 */
		attachments: z
			.array(
				z.object({
					data: z.string(), // base64 data
					type: z.enum(["image"]).default("image"),
				}),
			)
			.optional(),
		/**
		 * @deprecated Use attachments instead
		 * Data URI (base64) images
		 */
		images: z.array(z.string()).optional(),
	});
export type CreateChat = z.infer<typeof CreateChatSchema>;
/** Next sequential title: 新创作 1, 新创作 2, ... (also accepts "New Chat N") */
async function nextChatTitle(userId: string, preferred?: string) {
	const { db } = getContext();
	const existing = await db.query.chats.findMany({
		where: and(eq(chats.userId, userId), eq(chats.deleted, false)),
		columns: { title: true },
	});
	const re = /^(?:新创作|New Chat|新对话)\s*(\d+)\s*$/i;
	let max = 0;
	for (const c of existing) {
		const m = String(c.title || "").trim().match(re);
		if (m?.[1]) max = Math.max(max, Number(m[1]) || 0);
	}
	const n = max + 1;
	const base = preferred?.trim();
	// If client sent default unnumbered title, replace with numbered
	if (!base || /^(?:新创作|New Chat|新对话)$/i.test(base)) {
		return `新创作 ${n}`;
	}
	// If already numbered default, keep preferred only if unique; else renumber
	if (re.test(base) && existing.some((c) => c.title === base)) {
		return `新创作 ${n}`;
	}
	return base;
}

const createChat = async (req: CreateChat, ctx: RequestContext) => {
	const { db } = getContext();
	const { userId } = ctx;

	const title = await nextChatTitle(userId, req.title);

	const [chat] = await db
		.insert(chats)
		.values({
			userId,
			title,
			provider: req.provider,
			model: req.model,
		})
		.returning();

	if (req.content) {
		const messageResult = await createMessage(
			{
				chatId: chat!.id,
				content: req.content,
				type: "text",
				provider: req.provider,
				model: req.model,
				imageCount: req.imageCount,
				width: req.width,
				height: req.height,
				aspectRatio: req.aspectRatio,
				attachments: req.attachments,
				images: req.images,
			},
			ctx,
		);

		// Return chat id and messages for frontend to trigger generation
		return { id: chat!.id, messages: messageResult.messages };
	}

	return { id: chat!.id };
};

const getChats = async (ctx: RequestContext) => {
	const { db } = getContext();
	const { userId } = ctx;

	const userChats = await db.query.chats.findMany({
		where: and(eq(chats.userId, userId), eq(chats.deleted, false)),
		orderBy: [desc(chats.createdAt)],
	});

	return userChats;
};

export const GetChatByIdSchema = z.object({
	id: z.string(),
});
export type GetChatById = z.infer<typeof GetChatByIdSchema>;
const getChatById = async (req: GetChatById, ctx: RequestContext) => {
	const { db } = getContext();
	const { userId } = ctx;

	const chat = await db.query.chats.findFirst({
		where: and(eq(chats.id, req.id), eq(chats.userId, userId), eq(chats.deleted, false)),
		with: {
			messages: {
				orderBy: [messages.createdAt],
				with: {
					generation: true,
					attachments: {
						with: {
							file: true,
						},
					},
				},
			},
		},
	});

	if (!chat || chat.userId !== userId) {
		return null;
	}

	const chatMessages = await Promise.all(
		chat.messages.map(async (msg) => {
			const fileIds = msg.generation?.fileIds as string[] | null;

			// Process attachments for user messages
			const attachmentUrls = msg.attachments
				? await Promise.all(
						msg.attachments.map(async (attachment) => ({
							id: attachment.id,
							type: attachment.type,
							url: await getFileUrl(attachment.fileId, userId),
						})),
					)
				: [];

			return {
				...msg,
				attachments: attachmentUrls,
				generation: msg.generation
					? {
							...msg.generation,
							...(fileIds
								? {
										resultUrls: await Promise.all(
											fileIds!.map(async (fileId) => {
												return await getFileUrl(fileId, userId);
											}),
										),
									}
								: null),
						}
					: null,
			};
		}),
	);

	return {
		...chat,
		messages: chatMessages,
	};
};

export const DeleteChatSchema = z.object({
	id: z.string(),
});
export type DeleteChat = z.infer<typeof DeleteChatSchema>;

/**
 * Hard-delete a chat and purge all related data:
 * - messages / attachments / generations
 * - file rows in D1
 * - R2 object bytes
 * Preview links become invalid after this (not soft-delete).
 */
const deleteChat = async (req: DeleteChat, ctx: RequestContext) => {
	const { db } = getContext();
	const { userId } = ctx;

	const chat = await db.query.chats.findFirst({
		where: eq(chats.id, req.id),
	});

	if (!chat || chat.userId !== userId) {
		return false;
	}

	const msgs = await db.query.messages.findMany({
		where: eq(messages.chatId, req.id),
		with: {
			attachments: true,
			generation: true,
		},
	});

	const fileIds = new Set<string>();
	const generationIds = new Set<string>();
	const messageIds: string[] = [];

	for (const m of msgs) {
		messageIds.push(m.id);
		if (m.generationId) generationIds.add(m.generationId);
		for (const att of m.attachments || []) {
			if (att.fileId) fileIds.add(att.fileId);
		}
		const gFiles = m.generation?.fileIds as string[] | null | undefined;
		if (Array.isArray(gFiles)) {
			for (const fid of gFiles) if (fid) fileIds.add(fid);
		}
	}

	// Extra: load generations by id in case relation missing
	if (generationIds.size) {
		const gens = await db.query.messageGenerations.findMany({
			where: inArray(messageGenerations.id, [...generationIds]),
		});
		for (const g of gens) {
			const gFiles = g.fileIds as string[] | null;
			if (Array.isArray(gFiles)) {
				for (const fid of gFiles) if (fid) fileIds.add(fid);
			}
		}
	}

	// 1) Delete R2 objects + D1 file rows first
	await deleteStoredFiles([...fileIds], userId);

	// 2) Delete attachments for these messages
	if (messageIds.length) {
		await db.delete(messageAttachments).where(inArray(messageAttachments.messageId, messageIds));
	}

	// 3) Clear generationId on messages so generations can be hard-deleted
	if (messageIds.length) {
		await db
			.update(messages)
			.set({ generationId: null })
			.where(inArray(messages.id, messageIds));
	}

	// 4) Delete generations
	if (generationIds.size) {
		await db.delete(messageGenerations).where(inArray(messageGenerations.id, [...generationIds]));
	}

	// 5) Delete messages
	await db.delete(messages).where(eq(messages.chatId, req.id));

	// 6) Hard-delete chat (not soft-delete)
	await db.delete(chats).where(eq(chats.id, req.id));

	return true;
};

export const UpdateChatSchema = createUpdateSchema(chats)
	.pick({
		id: true,
		provider: true,
		model: true,
		title: true,
	})
	.extend({
		id: z.string().nonempty(),
	});
export type UpdateChat = z.infer<typeof UpdateChatSchema>;
const updateChat = async (req: UpdateChat, ctx: RequestContext) => {
	const { db } = getContext();
	const { userId } = ctx;

	const chat = await db.query.chats.findFirst({
		where: eq(chats.id, req.id),
	});

	if (!chat || chat.userId !== userId) {
		throw new ServiceException("not_found", "Chat not found");
	}

	// Validate provider and model if provided
	if (req.provider && req.model) {
		if (req.provider.startsWith("relay:")) {
			const relay = await relayService.resolveRelayForGeneration(req.provider, ctx);
			const modelExists = relay?.models.some((m) => m.id === req.model);
			if (!modelExists) {
				throw new ServiceException("invalid_parameter", "Model not found for the specified relay");
			}
		} else {
			const providerInstance = getProviderById(req.provider);
			const modelExists = providerInstance.models.some((m) => m.id === req.model);
			if (!modelExists) {
				throw new ServiceException("invalid_parameter", "Model not found for the specified provider");
			}
		}
	}

	await getContext()
		.db.update(chats)
		.set({
			...(req.provider && { provider: req.provider }),
			...(req.model && { model: req.model }),
			...(req.title && { title: req.title }),
		})
		.where(eq(chats.id, req.id));

	return true;
};

export const DeleteMessageSchema = z.object({
	messageId: z.string().nonempty(),
});
export type DeleteMessage = z.infer<typeof DeleteMessageSchema>;
const deleteMessage = async (req: DeleteMessage, ctx: RequestContext) => {
	const { db } = getContext();
	const { userId } = ctx;

	// Find the message and verify ownership
	const message = await db.query.messages.findFirst({
		where: eq(messages.id, req.messageId),
		with: {
			chat: true,
			generation: true,
			attachments: true, // Include attachments for cleanup
		},
	});

	if (!message || message.chat.userId !== userId) {
		throw new ServiceException("not_found", "Message not found");
	}

	const fileIds = new Set<string>();
	for (const att of message.attachments || []) {
		if (att.fileId) fileIds.add(att.fileId);
	}
	const gFiles = message.generation?.fileIds as string[] | null | undefined;
	if (Array.isArray(gFiles)) {
		for (const fid of gFiles) if (fid) fileIds.add(fid);
	}

	// Delete attachment rows first
	if (message.attachments && message.attachments.length > 0) {
		await db.delete(messageAttachments).where(eq(messageAttachments.messageId, req.messageId));
	}

	// Clear generation link then delete generation + files
	const generationId = message.generationId;
	if (generationId) {
		await db.update(messages).set({ generationId: null }).where(eq(messages.id, req.messageId));
		await db.delete(messageGenerations).where(eq(messageGenerations.id, generationId));
	}

	await deleteStoredFiles([...fileIds], userId);

	// Delete the message
	await db.delete(messages).where(eq(messages.id, req.messageId));

	// Update chat timestamp
	await db.update(chats).set({ updatedAt: new Date().toISOString() }).where(eq(chats.id, message.chatId));

	return true;
};

export const CreateMessageSchema = createInsertSchema(messages)
	.omit(createSchemaOmits)
	.pick({
		chatId: true,
		content: true,
		type: true,
	})
	.extend({
		provider: z.string(),
		model: z.string(),
		/**
		 * Number of images to generate
		 */
		imageCount: z.number().int().min(1).max(10).default(1),
		/**
		 * Pixel size (preferred)
		 */
		width: z.number().int().min(64).max(4096).optional(),
		height: z.number().int().min(64).max(4096).optional(),
		/**
		 * Aspect ratio for image generation (legacy)
		 */
		aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
		/**
		 * base64-encoded image strings for attachments
		 */
		attachments: z
			.array(
				z.object({
					data: z.string(), // base64 data
					type: z.enum(["image"]).default("image"),
				}),
			)
			.optional(),
		/**
		 * @deprecated Use attachments instead
		 * base64-encoded image strings
		 */
		images: z.array(z.string()).optional(),
	});
export type CreateMessage = z.infer<typeof CreateMessageSchema>;
type CreateMessageResponse = Pick<NonNullable<Awaited<ReturnType<typeof getChatById>>>, "messages"> & {
	generationId?: string;
};

// Common image generation logic
interface GenerationParams {
	generationId: string;
	prompt: string;
	provider: string;
	model: string;
	chatId: string;
	userId: string;
	userImages?: string[];
	imageCount?: number;
	width?: number;
	height?: number;
	aspectRatio?: string;
	messageId?: string; // For regeneration, exclude this message from reference search
}

type ProgressPhase =
	| "queued"
	| "preparing"
	| "calling_api"
	| "parsing"
	| "saving"
	| "completed"
	| "failed";

async function setGenerationProgress(
	generationId: string,
	phase: ProgressPhase,
	percent: number,
	extra?: Record<string, unknown>,
	opts?: { touchRow?: boolean },
) {
	const { db } = getContext();
	const row = await db.query.messageGenerations.findFirst({
		where: eq(messageGenerations.id, generationId),
		columns: { parameters: true, status: true },
	});
	if (!row || row.status === "completed" || row.status === "failed") return;
	const prev = (row.parameters as any) || {};
	const startedAt = prev.progress?.startedAt || new Date().toISOString();
	// Soft progress must NOT bump row.updatedAt — that blocked stale reclaim forever
	const patch: Record<string, unknown> = {
		parameters: {
			...prev,
			progress: {
				phase,
				percent: Math.max(0, Math.min(100, Math.round(percent))),
				startedAt,
				updatedAt: new Date().toISOString(),
				...extra,
			},
		} as any,
	};
	if (opts?.touchRow !== false && phase !== "calling_api") {
		patch.updatedAt = new Date().toISOString();
	}
	await db.update(messageGenerations).set(patch as any).where(eq(messageGenerations.id, generationId));
}

const executeImageGeneration = async (params: GenerationParams, ctx: RequestContext) => {
	const { db } = getContext();
	const {
		generationId,
		prompt,
		provider: providerId,
		model: modelId,
		chatId,
		userId,
		userImages,
		imageCount,
		width,
		height,
		aspectRatio,
		messageId,
	} = params;

	try {
		await setGenerationProgress(generationId, "preparing", 12, { message: "preparing_request" });

		const isRelay = providerId.startsWith("relay:");
		let modelAbility: "t2i" | "i2i" = "t2i";
		let maxInputImages = 1;

		if (isRelay) {
			const relay = await relayService.resolveRelayForGeneration(providerId, ctx);
			const model = relay?.models.find((m) => m.id === modelId);
			// Only use images when the user explicitly attached them (no silent last-image i2i)
			modelAbility = userImages && userImages.length > 0 ? "i2i" : "t2i";
			maxInputImages = model?.maxInputImages || 4;
		} else {
			const providerInstance = getProviderById(providerId);
			const model = providerInstance.models.find((m) => m.id === modelId);
			modelAbility = model?.ability || "t2i";
			maxInputImages = (model as any)?.maxInputImages || 1;
		}

		let referImages: string[] | undefined;

		// Always use user uploaded images if provided
		if (userImages && userImages.length > 0) {
			referImages = userImages;
		} else if (modelAbility !== "t2i") {
			// If no user images and model supports image edit, refer to last message's images
			const lastMessageImage = async () => {
				const whereConditions = [
					eq(messages.chatId, chatId),
					eq(messages.role, "assistant"),
					eq(messages.type, "image"),
				];

				// Exclude the current message being regenerated
				if (messageId) {
					whereConditions.push(ne(messages.id, messageId));
				}

				const lastMessage = await db.query.messages.findFirst({
					where: and(...whereConditions),
					orderBy: [desc(messages.createdAt)],
					with: {
						generation: {
							columns: {
								fileIds: true,
							},
						},
					},
				});
				const fileIds = lastMessage?.generation?.fileIds as string[] | null;
				if (fileIds && fileIds.length > 0) {
					if (modelAbility === "i2i") {
						const maxImages = maxInputImages || 1;
						if (maxImages === 1) {
							return [await getFileData(fileIds[fileIds.length - 1]!, userId)].filter(Boolean) as string[];
						}
						const imagesToUse = fileIds.slice(-maxImages);
						return (await Promise.all(imagesToUse.map((id) => getFileData(id, userId)))).filter(Boolean) as string[];
					}
				}
			};

			referImages = await lastMessageImage();
		}

		const now = new Date();
		const generateRequest = {
			providerId,
			modelId,
			prompt,
			images: referImages,
			n: imageCount || 1,
			aspectRatio: aspectRatio as any,
			width,
			height,
		};

		// NO soft-progress D1 ticks (rate-limit killed completed writes).
		// Phase writes only: preparing → calling_api → parsing → saving → done.
		const wallStart = Date.now();
		const WALL_MS = 360_000; // 6 minutes hard cap
		let lastMeta: any = null;
		const abortCtrl = new AbortController();
		await setGenerationProgress(
			generationId,
			"calling_api",
			30,
			{
				message: referImages?.length ? "calling_i2i" : "calling_t2i",
				hasReference: !!referImages?.length,
			},
			{ touchRow: true },
		);

		let result;
		try {
			const wallTimer = setTimeout(() => abortCtrl.abort(), WALL_MS);
			try {
				if (isRelay) {
					const relay = await relayService.resolveRelayForGeneration(providerId, ctx);
					result = await generateViaRelay(
						generateRequest,
						{
							type: relay!.type,
							baseURL: relay!.baseURL,
							apiKey: relay!.apiKey,
							modelId,
							apiMode: relay!.apiMode || "endpoints",
							endpoints: relay!.endpoints || null,
						},
						{
							signal: abortCtrl.signal,
							onMeta: (m) => {
								lastMeta = m;
							},
						},
					);
				} else {
					const providerInstance = getProviderById(providerId);
					const provider = await aiService.getAiProviderById({ providerId }, ctx);
					const settings =
						provider?.settings?.reduce((acc, setting) => {
							const value = setting.value ?? setting.defaultValue;
							if (value !== undefined) {
								acc[setting.key] = value;
							}
							return acc;
						}, {} as ApiProviderSettings) ?? {};
					result = await providerInstance.generate(generateRequest, settings);
				}
			} finally {
				clearTimeout(wallTimer);
			}
			console.log(
				"[generate] upstream done",
				generationId,
				"ms",
				Date.now() - wallStart,
				"images",
				result?.images?.length,
				"meta",
				JSON.stringify(lastMeta || {}).slice(0, 300),
			);
		} catch (upErr: any) {
			const isTimeout = upErr?.name === "AbortError" || /timeout|aborted/i.test(String(upErr?.message || upErr));
			console.error("[generate] upstream failed", generationId, upErr, lastMeta);
			await setGenerationProgress(generationId, "failed", 100, {
				message: isTimeout ? "upstream_timeout" : String(upErr?.message || upErr).slice(0, 120),
				meta: lastMeta || undefined,
			});
			await db
				.update(messageGenerations)
				.set({
					status: "failed",
					errorReason: isTimeout ? "TIMEOUT" : "API_ERROR",
					updatedAt: new Date().toISOString(),
				})
				.where(eq(messageGenerations.id, generationId));
			return;
		}

		// Save relay meta into parameters for post-mortem (single write, no per-tick D1 spam)
		try {
			const cur = await db.query.messageGenerations.findFirst({
				where: eq(messageGenerations.id, generationId),
				columns: { parameters: true },
			});
			const pp = (cur?.parameters as any) || {};
			await db
				.update(messageGenerations)
				.set({
					parameters: { ...pp, relayMeta: lastMeta, upstreamDoneAt: new Date().toISOString() },
					updatedAt: new Date().toISOString(),
				})
				.where(eq(messageGenerations.id, generationId));
		} catch {
			/* non-fatal */
		}

		await setGenerationProgress(generationId, "parsing", 85, {
			message: "parsing_response",
			meta: lastMeta || undefined,
		});

		if (result.errorReason) {
			await setGenerationProgress(generationId, "failed", 100, {
				message: result.errorReason,
				meta: lastMeta || undefined,
			});
			await db
				.update(messageGenerations)
				.set({
					status: "failed",
					errorReason: result.errorReason,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(messageGenerations.id, generationId));
			return;
		}

		if (!result.images?.length) {
			console.error("Image generation returned no images", { providerId, modelId, lastMeta });
			await setGenerationProgress(generationId, "failed", 100, {
				message: "no_images_parsed",
				meta: lastMeta || undefined,
			});
			await db
				.update(messageGenerations)
				.set({
					status: "failed",
					errorReason: "API_ERROR",
					updatedAt: new Date().toISOString(),
				})
				.where(eq(messageGenerations.id, generationId));
			return;
		}

		await setGenerationProgress(generationId, "saving", 92, {
			message: "saving_images",
			imageCount: result.images.length,
		});

		let fileIds: string[] = [];
		try {
			fileIds = await saveFiles(result.images, userId);
		} catch (saveErr) {
			console.error("[generate] saveFiles error", saveErr);
			const urls = result.images.filter((u) => /^https?:\/\//i.test(u));
			if (urls.length) {
				try {
					fileIds = await saveFiles(urls, userId);
				} catch (e2) {
					console.error("[generate] saveFiles fallback failed", e2);
				}
			}
		}
		if (!fileIds.length) {
			await setGenerationProgress(generationId, "failed", 100, { message: "save_failed" });
			await db
				.update(messageGenerations)
				.set({
					status: "failed",
					errorReason: "API_ERROR",
					updatedAt: new Date().toISOString(),
				})
				.where(eq(messageGenerations.id, generationId));
			return;
		}

		// CRITICAL: completed write with retry — if this fails, UI is stuck forever
		const completedAt = new Date().toISOString();
		const completedPatch = {
			status: "completed" as const,
			fileIds: [...fileIds],
			generationTime: Date.now() - now.getTime(),
			parameters: {
				relayMeta: lastMeta,
				progress: {
					phase: "completed",
					percent: 100,
					updatedAt: completedAt,
					message: "done",
					saved: fileIds.length,
				},
			} as any,
			updatedAt: completedAt,
		};

		let completed = false;
		for (let attempt = 0; attempt < 3 && !completed; attempt++) {
			try {
				await db
					.update(messageGenerations)
					.set(completedPatch)
					.where(eq(messageGenerations.id, generationId));
				completed = true;
			} catch (e) {
				console.error(`[generate] completed write attempt ${attempt + 1} failed`, e);
				if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
			}
		}
		if (!completed) {
			console.error("[generate] FATAL: could not write completed status after 3 attempts", generationId);
		}
		console.log("[generate] completed", generationId, "files", fileIds.length, "attempts", completed ? 1 : "FAILED");
	} catch (error) {
		console.error("Error generating image:", error);
		const msg = error instanceof Error ? error.message : String(error);
		const isSize =
			/too large|too big|SQLITE_TOOBIG|max length|string or blob too big/i.test(msg);
		await setGenerationProgress(generationId, "failed", 100, { message: msg.slice(0, 120) });
		await db
			.update(messageGenerations)
			.set({
				status: "failed",
				errorReason: error instanceof ConfigInvalidError ? "CONFIG_INVALID" : isSize ? "API_ERROR" : "UNKNOWN",
				updatedAt: new Date().toISOString(),
			})
			.where(eq(messageGenerations.id, generationId));
		return;
	}
};

const createMessage = async (req: CreateMessage, ctx: RequestContext) => {
	const { db } = getContext();
	const { userId } = ctx;

	// Verify chat exists and belongs to user
	const chat = await db.query.chats.findFirst({
		where: eq(chats.id, req.chatId),
	});
	if (!chat || chat.userId !== userId) {
		throw new ServiceException("not_found", "Chat not found");
	}

	// Add user message
	const [userMessage] = await db
		.insert(messages)
		.values({
			userId: userId,
			chatId: req.chatId,
			content: req.content,
			role: "user",
			type: req.type,
		})
		.returning();

	if (!userMessage) {
		throw new ServiceException("error", "Failed to create user message");
	}

	// Handle attachments if provided
	const attachmentResults: Array<{ id: string; type: "image"; url: string | null }> = [];
	if (req.attachments && req.attachments.length > 0) {
		// Save attachment files
		const attachmentFileIds = await saveFiles(
			req.attachments.map((att) => att.data),
			userId,
		);

		// Create attachment records and prepare results
		for (let i = 0; i < req.attachments.length; i++) {
			const attachment = req.attachments[i];
			const fileId = attachmentFileIds[i];
			if (fileId && attachment) {
				await db.insert(messageAttachments).values({
					messageId: userMessage.id,
					fileId: fileId,
					type: attachment.type,
				});

				// Prepare attachment result for response
				const fileUrl = await getFileUrl(fileId, userId);
				attachmentResults.push({
					id: `${userMessage.id}-${i}`,
					type: "image",
					url: fileUrl,
				});
			}
		}
	}

	// Update chat timestamp
	await db.update(chats).set({ updatedAt: new Date().toISOString() }).where(eq(chats.id, req.chatId));

	// Create generation record
	const [generation] = await db
		.insert(messageGenerations)
		.values({
			userId: userId,
			prompt: req.content,
			provider: req.provider,
			model: req.model,
			type: "image",
			status: "pending",
			parameters: {
				imageCount: req.imageCount,
				width: req.width,
				height: req.height,
				aspectRatio: req.aspectRatio,
				progress: {
					phase: "queued",
					percent: 5,
					startedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					message: "queued",
				},
			} as any,
		})
		.returning();

	// Add assistant message
	const [assistantMessage] = await db
		.insert(messages)
		.values({
			userId: userId,
			chatId: req.chatId,
			content: "",
			role: "assistant",
			type: "image",
			generationId: generation!.id,
		})
		.returning();
	if (!assistantMessage) {
		throw new ServiceException("error", "Failed to create assistant message");
	}

	// Start generation. Prefer waitUntil so HTTP returns fast; always ensure a start path.
	// CAS in createMessageGenerate prevents double-run if client also triggers.
	const exec = ctx.executionCtx as { waitUntil?: (p: Promise<unknown>) => void } | undefined;
	if (generation) {
		const start = createMessageGenerate({ generationId: generation.id }, { ...ctx, blockGenerate: true } as any).catch(
			(e) => console.error("auto createMessageGenerate failed", e),
		);
		if (exec?.waitUntil) {
			exec.waitUntil(start);
		} else {
			// No CF executionCtx (or miswired) — still start; may be cut short on Workers without waitUntil
			console.warn("[generate] no executionCtx.waitUntil — starting without background guarantee");
			void start;
		}
	}

	return {
		messages: [
			{
				...userMessage,
				generation: null,
				// Include attachments for immediate display
				attachments: attachmentResults,
			},
			{
				...assistantMessage,
				generation: generation!,
				attachments: [],
			},
		],
		// Client can use this to call createMessageGenerate once as fallback (idempotent)
		generationId: generation?.id,
	} satisfies CreateMessageResponse;
};

export const GetGenerationStatusSchema = z.object({
	generationId: z.string(),
});
export type GetGenerationStatus = z.infer<typeof GetGenerationStatusSchema>;
const getGenerationStatus = async (req: GetGenerationStatus, ctx: RequestContext) => {
	const { db } = getContext();
	const { userId } = ctx;

	const generation = await db.query.messageGenerations.findFirst({
		where: eq(messageGenerations.id, req.generationId),
	});

	if (!generation || generation.userId !== userId) {
		return null;
	}

	// Read-only status (do not mutate TIMEOUT here — races with in-flight generation)
	const params = (generation.parameters as any) || {};
	const progress = params.progress || null;
	const rawIds = generation.fileIds;
	const fileIdList: string[] = Array.isArray(rawIds)
		? (rawIds as string[])
		: typeof rawIds === "string"
			? (() => {
					try {
						const p = JSON.parse(rawIds);
						return Array.isArray(p) ? p : [];
					} catch {
						return [];
					}
				})()
			: [];

	// PURE READ. Never write TIMEOUT here — that race-killed live jobs waiting on slow relays
	// while soft-progress heartbeats were silent (D1 rate limit / no ticks).
	const startedAtIso = progress?.startedAt || generation.createdAt;
	const ageMs = Date.now() - new Date(startedAtIso).getTime();
	const stale =
		(generation.status === "pending" || generation.status === "generating") && ageMs > 420_000;

	const resultUrls =
		fileIdList.length > 0
			? (
					await Promise.all(
						fileIdList.map(async (fileId) => {
							try {
								return await getFileUrl(fileId, userId);
							} catch {
								return null;
							}
						}),
					)
				).filter(Boolean)
			: undefined;

	return {
		...generation,
		progress,
		stale,
		ageMs,
		resultUrls: resultUrls?.length ? resultUrls : undefined,
	};
};

export const CreateMessageGenerateSchema = z.object({
	generationId: z.string(),
});
export type CreateMessageGenerate = z.infer<typeof CreateMessageGenerateSchema>;
async function createMessageGenerate(req: CreateMessageGenerate, ctx: RequestContext) {
	const { db } = getContext();
	const { userId } = ctx;

	const generation = await db.query.messageGenerations.findFirst({
		where: eq(messageGenerations.id, req.generationId),
	});

	if (!generation || generation.userId !== userId) {
		throw new ServiceException("not_found", "Generation not found");
	}

	// Idempotent: already done
	if (generation.status === "completed") {
		return { success: true, skipped: true, reason: "already_completed" as const };
	}
	// Already running: never re-call relay. Only past wall (7min) mark TIMEOUT without re-run.
	if (generation.status === "generating") {
		const params = (generation.parameters as any) || {};
		const startedIso = params.progress?.startedAt || generation.createdAt;
		const age = Date.now() - new Date(startedIso).getTime();
		if (age < 420_000) {
			return { success: true, skipped: true, reason: "already_generating" as const };
		}
		console.warn("[generate] beyond wall — TIMEOUT without re-run", generation.id, "ageMs", age);
		await db
			.update(messageGenerations)
			.set({
				status: "failed",
				errorReason: "TIMEOUT",
				updatedAt: new Date().toISOString(),
			})
			.where(eq(messageGenerations.id, generation.id));
		return { success: false, skipped: true, reason: "stale_timeout" as const };
	}
	// CAS claim: only pending or failed (retry). Never re-enter from generating.
	const claim = await db
		.update(messageGenerations)
		.set({ status: "generating", updatedAt: new Date().toISOString(), errorReason: null as any })
		.where(
			and(
				eq(messageGenerations.id, generation.id),
				or(eq(messageGenerations.status, "pending"), eq(messageGenerations.status, "failed")),
			),
		)
		.returning();

	if (!claim.length) {
		return { success: true, skipped: true, reason: "claim_failed" as const };
	}

	await setGenerationProgress(generation.id, "preparing", 10, { message: "claimed" });

	const message = await db.query.messages.findFirst({
		where: eq(messages.generationId, req.generationId),
		with: {
			chat: true,
			attachments: { with: { file: true } },
		},
	});

	if (!message || message.userId !== userId) {
		throw new ServiceException("not_found", "Message not found");
	}

	// Abort if chat was hard-deleted mid-flight
	const chatStill = await db.query.chats.findFirst({ where: eq(chats.id, message.chatId) });
	if (!chatStill || chatStill.userId !== userId) {
		await db
			.update(messageGenerations)
			.set({ status: "failed", errorReason: "UNKNOWN", updatedAt: new Date().toISOString() })
			.where(eq(messageGenerations.id, generation.id));
		return { success: false, skipped: true, reason: "chat_gone" as const };
	}

	// Parent user message = latest user message created BEFORE this assistant message
	const userMessage = await db.query.messages.findFirst({
		where: and(
			eq(messages.chatId, message.chatId),
			eq(messages.role, "user"),
			lt(messages.createdAt, message.createdAt),
		),
		orderBy: [desc(messages.createdAt)],
		with: {
			attachments: { with: { file: true } },
		},
	});

	const userImages = userMessage?.attachments?.length
		? await Promise.all(userMessage.attachments.map(async (att) => await getFileData(att.fileId, userId)))
		: undefined;

	const params = generation.parameters as any;
	const imageCount = params?.imageCount || 1;
	const width = params?.width;
	const height = params?.height;
	const aspectRatio = params?.aspectRatio;

	// Capture context at claim time — waitUntil may outlive the request;
	// getContext() is a module singleton and must still point at D1/R2 bindings.
	const run = async () => {
		// No updatedAt heartbeat — stale reclaim uses progress.startedAt / createdAt

		try {
			const still = await db.query.chats.findFirst({ where: eq(chats.id, message.chatId) });
			if (!still) {
				await db
					.update(messageGenerations)
					.set({ status: "failed", errorReason: "UNKNOWN", updatedAt: new Date().toISOString() })
					.where(eq(messageGenerations.id, generation.id));
				return;
			}

			await executeImageGeneration(
				{
					generationId: generation.id,
					prompt: generation.prompt,
					provider: generation.provider,
					model: generation.model,
					chatId: message.chatId,
					userId,
					userImages: userImages?.filter(Boolean) as string[] | undefined,
					imageCount,
					width,
					height,
					aspectRatio,
					messageId: message.id,
				},
				ctx,
			);

			// Safety net: if still generating after execute, do NOT blindly TIMEOUT —
			// completed write may have failed while files were saved. Try to recover.
			const gAfter = await db.query.messageGenerations.findFirst({
				where: eq(messageGenerations.id, generation.id),
			});
			if (gAfter && (gAfter.status === "generating" || gAfter.status === "pending")) {
				const fids = (gAfter.fileIds as string[] | null) || [];
				if (fids.length > 0) {
					console.warn("[generate] recovering completed from fileIds", generation.id);
					await db
						.update(messageGenerations)
						.set({
							status: "completed",
							updatedAt: new Date().toISOString(),
						})
						.where(eq(messageGenerations.id, generation.id));
				} else {
					console.error("[generate] left in", gAfter.status, "after execute — API_ERROR");
					await db
						.update(messageGenerations)
						.set({
							status: "failed",
							errorReason: "API_ERROR",
							updatedAt: new Date().toISOString(),
						})
						.where(eq(messageGenerations.id, generation.id));
				}
			}

			const after = await db.query.chats.findFirst({ where: eq(chats.id, message.chatId) });
			if (!after) {
				const g = await db.query.messageGenerations.findFirst({
					where: eq(messageGenerations.id, generation.id),
				});
				const fids = (g?.fileIds as string[] | null) || [];
				if (fids.length) await deleteStoredFiles(fids, userId);
				await db.delete(messageGenerations).where(eq(messageGenerations.id, generation.id));
			}
		} catch (e) {
			console.error("createMessageGenerate background error:", e);
			try {
				await db
					.update(messageGenerations)
					.set({
						status: "failed",
						errorReason: "UNKNOWN",
						updatedAt: new Date().toISOString(),
					})
					.where(eq(messageGenerations.id, generation.id));
			} catch (e2) {
				console.error("failed to mark generation failed:", e2);
			}
		} finally {
			/* no hb */
		}
	};

	// Prefer background execution on Cloudflare to avoid 30s request timeout.
	// IMPORTANT: when already invoked from an outer waitUntil (createMessage auto-start),
	// we must AWAIT run() so the outer promise tracks full work. Nested waitUntil(run())
	// + early return caused the worker to exit after claim while relay still ran → UI stuck.
	const exec = ctx.executionCtx as { waitUntil?: (p: Promise<unknown>) => void } | undefined;
	const block = !!(ctx as any).blockGenerate;

	if (block) {
		await run();
		return { success: true, async: false };
	}

	if (exec?.waitUntil) {
		// HTTP path: respond immediately, keep worker alive for run()
		exec.waitUntil(
			run().catch((e) => {
				console.error("[generate] waitUntil run failed", e);
			}),
		);
		return { success: true, async: true };
	}

	await run();
	return { success: true, async: false };
};

export const RegenerateMessageSchema = z.object({
	messageId: z.string(),
});
export type RegenerateMessage = z.infer<typeof RegenerateMessageSchema>;
const regenerateMessage = async (req: RegenerateMessage, ctx: RequestContext) => {
	const { db } = getContext();
	const { userId } = ctx;

	// Find the message to regenerate
	const message = await db.query.messages.findFirst({
		where: eq(messages.id, req.messageId),
		with: {
			generation: true,
			chat: true,
		},
	});

	if (!message || message.userId !== userId || message.role !== "assistant") {
		throw new ServiceException("not_found", "Message not found or not regeneratable");
	}

	if (!message.generation) {
		throw new ServiceException("invalid_parameter", "Message has no generation to regenerate");
	}

	const originalGeneration = message.generation;
	const chat = message.chat;

	if (!chat) {
		throw new ServiceException("not_found", "Chat not found");
	}

	const prevParams = (originalGeneration.parameters as any) || {};
	// Reset the existing generation record to pending status
	await db
		.update(messageGenerations)
		.set({
			status: "pending",
			fileIds: null, // Clear previous results
			errorReason: null, // Clear previous errors
			generationTime: null, // Clear previous timing
			parameters: {
				...prevParams,
				progress: {
					phase: "queued",
					percent: 5,
					startedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					message: "queued",
				},
			} as any,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(messageGenerations.id, originalGeneration.id));

	// Reset message content while regenerating
	await db
		.update(messages)
		.set({
			content: "", // Reset content while regenerating
		})
		.where(eq(messages.id, req.messageId));

	// Update chat timestamp
	await db.update(chats).set({ updatedAt: new Date().toISOString() }).where(eq(chats.id, chat.id));

	const exec = ctx.executionCtx as { waitUntil?: (p: Promise<unknown>) => void } | undefined;
	const start = createMessageGenerate(
		{ generationId: originalGeneration.id },
		{ ...ctx, blockGenerate: true } as any,
	).catch((e) => console.error("auto regenerate generate failed", e));
	if (exec?.waitUntil) exec.waitUntil(start);
	else void start;

	return {
		messageId: req.messageId,
		generationId: originalGeneration.id,
	};
};

class ChatService {
	createChat = createChat;
	getChats = getChats;
	getChatById = getChatById;
	deleteChat = deleteChat;
	updateChat = updateChat;
	createMessage = createMessage;
	deleteMessage = deleteMessage;
	getGenerationStatus = getGenerationStatus;
	createMessageGenerate = createMessageGenerate;
	regenerateMessage = regenerateMessage;
}

export const chatService = new ChatService();
