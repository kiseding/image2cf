import { getProviderById } from "@/server/ai/provider";
import { generateViaRelay } from "@/server/ai/provider/relay";
import { type ApiProviderSettings, ConfigInvalidError } from "@/server/ai/types/provider";
import type { DrizzleDb } from "@/server/db";
import { chats, messageAttachments, messageGenerations, messages } from "@/server/db/schemas";
import { createSchemaOmits } from "@/server/db/util";
import { inBrowser, inCfWorker } from "@/server/lib/env";
import { ServiceException } from "@/server/lib/exception";
import { and, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { createInsertSchema, createUpdateSchema } from "drizzle-zod";
import z from "zod/v4";
import { aiService, getAiProviderByIdWithSecrets } from "../ai";
import { type GenerationQueueMessage, type RequestContext, getContext } from "../context";
import {
	ALLOWED_IMAGE_MIMES,
	MAX_ATTACHMENTS_TOTAL_BYTES,
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENT_COUNT,
	deleteStoredFiles,
	getFileData,
	getFileUrl,
	saveFiles,
} from "../file/storage";
import { relayService } from "../relay";

const AttachmentDataSchema = z.string().superRefine((value, ctx) => {
	const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i);
	if (!match?.[1] || !match[2]) {
		ctx.addIssue({ code: "custom", message: "Image must be a base64 data URI" });
		return;
	}
	if (!(ALLOWED_IMAGE_MIMES as readonly string[]).includes(match[1].toLowerCase())) {
		ctx.addIssue({ code: "custom", message: "Unsupported image MIME type" });
	}
	const estimatedBytes =
		Math.floor((match[2].length * 3) / 4) - (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0);
	if (estimatedBytes > MAX_ATTACHMENT_BYTES) {
		ctx.addIssue({ code: "custom", message: "Image exceeds the per-file size limit" });
	}
});

const AttachmentArraySchema = z
	.array(
		z.object({
			data: AttachmentDataSchema,
			type: z.enum(["image"]).default("image"),
		}),
	)
	.max(MAX_ATTACHMENT_COUNT)
	.superRefine((attachments, ctx) => {
		const total = attachments.reduce((sum, attachment) => {
			const b64 = attachment.data.split(",")[1] || "";
			return sum + Math.floor((b64.length * 3) / 4);
		}, 0);
		if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
			ctx.addIssue({ code: "custom", message: "Images exceed the total size limit" });
		}
	});

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
		attachments: AttachmentArraySchema.optional(),
		/**
		 * @deprecated Use attachments instead
		 * Data URI (base64) images
		 */
		images: z.array(AttachmentDataSchema).max(MAX_ATTACHMENT_COUNT).optional(),
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
		attachments: AttachmentArraySchema.optional(),
		/**
		 * @deprecated Use attachments instead
		 * base64-encoded image strings
		 */
		images: z.array(AttachmentDataSchema).max(MAX_ATTACHMENT_COUNT).optional(),
	});
export type CreateMessage = z.infer<typeof CreateMessageSchema>;
type CreateMessageResponse = Pick<NonNullable<Awaited<ReturnType<typeof getChatById>>>, "messages">;

// Common image generation logic
interface GenerationParams {
	generationId: string;
	attempt: number;
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

const executeImageGeneration = async (params: GenerationParams, ctx: RequestContext) => {
	const { db } = getContext();
	const {
		generationId,
		attempt,
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
		const isRelay = providerId.startsWith("relay:");
		let modelAbility: "t2i" | "i2i" = "t2i";
		let maxInputImages = 1;

		if (isRelay) {
			const relay = await relayService.resolveRelayForGeneration(providerId, ctx);
			const model = relay?.models.find((m) => m.id === modelId);
			// Only i2i when user attached images (971 used i2i default; keep explicit)
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

		let result;
		if (isRelay) {
			const relay = await relayService.resolveRelayForGeneration(providerId, ctx);
			result = await generateViaRelay(generateRequest, {
				type: relay!.type,
				baseURL: relay!.baseURL,
				apiKey: relay!.apiKey,
				modelId,
				apiMode: relay!.apiMode || "endpoints",
				endpoints: relay!.endpoints || null,
			});
		} else {
			const providerInstance = getProviderById(providerId);
			const provider = await getAiProviderByIdWithSecrets({ providerId }, ctx);
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
		if (result.errorReason) {
			await db
				.update(messageGenerations)
				.set({
					status: "failed",
					errorReason: result.errorReason,
					updatedAt: now.toISOString(),
				})
				.where(
					and(
						eq(messageGenerations.id, generationId),
						eq(messageGenerations.attempt, attempt),
						eq(messageGenerations.status, "generating"),
					),
				);
			return;
		}

		if (!result.images?.length) {
			console.error("Image generation returned no images", { providerId, modelId });
			await db
				.update(messageGenerations)
				.set({
					status: "failed",
					errorReason: "API_ERROR",
					updatedAt: now.toISOString(),
				})
				.where(
					and(
						eq(messageGenerations.id, generationId),
						eq(messageGenerations.attempt, attempt),
						eq(messageGenerations.status, "generating"),
					),
				);
			return;
		}

		// Save generated files to database (URLs preferred over huge base64)
		const fileIds = await saveFiles(result.images, userId);
		if (!fileIds.length) {
			await db
				.update(messageGenerations)
				.set({
					status: "failed",
					errorReason: "API_ERROR",
					updatedAt: now.toISOString(),
				})
				.where(
					and(
						eq(messageGenerations.id, generationId),
						eq(messageGenerations.attempt, attempt),
						eq(messageGenerations.status, "generating"),
					),
				);
			return;
		}

		const completed = await db
			.update(messageGenerations)
			.set({
				status: "completed",
				fileIds,
				generationTime: Date.now() - now.getTime(),
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(messageGenerations.id, generationId),
					eq(messageGenerations.attempt, attempt),
					eq(messageGenerations.status, "generating"),
				),
			)
			.returning();
		if (!completed.length) {
			// A newer regeneration owns the row, so this attempt's files are no longer reachable.
			await deleteStoredFiles(fileIds, userId);
		}
	} catch (error) {
		console.error("Error generating image:", error);
		const msg = error instanceof Error ? error.message : String(error);
		const isSize =
			/too large|too big|SQLITE_TOOBIG|max length|string or blob too big/i.test(msg);
		await db
			.update(messageGenerations)
			.set({
				status: "failed",
				errorReason: error instanceof ConfigInvalidError ? "CONFIG_INVALID" : isSize ? "API_ERROR" : "UNKNOWN",
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(messageGenerations.id, generationId),
					eq(messageGenerations.attempt, attempt),
					eq(messageGenerations.status, "generating"),
				),
			);
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
			true,
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

	// Don't execute image generation here - client will call createMessageGenerate
	// This avoids CF Worker 30-second timeout limitation (971eb01 working pattern)

	return {
		messages: [
			{
				...userMessage,
				generation: null,
				attachments: attachmentResults,
			},
			{ ...assistantMessage, generation: generation!, attachments: [] },
		],
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

	return {
		...generation,
		resultUrls: generation.fileIds
			? await Promise.all(
					(generation.fileIds as string[]).map(async (fileId) => {
						return await getFileUrl(fileId, userId);
					}),
				)
			: undefined,
	};
};

export const CreateMessageGenerateSchema = z.object({
	generationId: z.string(),
});
export type CreateMessageGenerate = z.infer<typeof CreateMessageGenerateSchema>;
const createMessageGenerate = async (req: CreateMessageGenerate, ctx: RequestContext) => {
	const { db, generationQueue } = getContext();
	const { userId } = ctx;
	const [generation] = await db
		.update(messageGenerations)
		.set({
			status: "generating",
			attempt: sql`${messageGenerations.attempt} + 1`,
			errorReason: null,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(messageGenerations.id, req.generationId),
				eq(messageGenerations.userId, userId),
				or(eq(messageGenerations.status, "pending"), eq(messageGenerations.status, "failed")),
			),
		)
		.returning();

	if (!generation) {
		const existing = await db.query.messageGenerations.findFirst({
			where: and(eq(messageGenerations.id, req.generationId), eq(messageGenerations.userId, userId)),
			columns: { status: true, attempt: true },
		});
		if (!existing) throw new ServiceException("not_found", "Generation not found");
		return { success: true, skipped: true, status: existing.status, attempt: existing.attempt };
	}

	const message: GenerationQueueMessage = {
		generationId: generation.id,
		userId,
		attempt: generation.attempt,
	};
	if (generationQueue) {
		try {
			await generationQueue.send(message, { contentType: "json" });
			return { success: true, accepted: true, queued: true, attempt: generation.attempt };
		} catch (error) {
			await db
				.update(messageGenerations)
				.set({ status: "failed", errorReason: "UNKNOWN", updatedAt: new Date().toISOString() })
				.where(
					and(
						eq(messageGenerations.id, generation.id),
						eq(messageGenerations.attempt, generation.attempt),
						eq(messageGenerations.status, "generating"),
					),
				);
			throw error;
		}
	}

	const task = processClaimedGeneration(message, ctx);

	if (ctx.executionCtx && !ctx.blockGenerate) {
		ctx.executionCtx.waitUntil(task);
		return { success: true, accepted: true, queued: false, attempt: generation.attempt };
	}
	await task;
	return { success: true, attempt: generation.attempt };
};

export async function processClaimedGeneration(job: GenerationQueueMessage, ctx: RequestContext) {
	const { db } = getContext();
	const generation = await db.query.messageGenerations.findFirst({
		where: and(
			eq(messageGenerations.id, job.generationId),
			eq(messageGenerations.userId, job.userId),
			eq(messageGenerations.attempt, job.attempt),
			eq(messageGenerations.status, "generating"),
		),
	});
	if (!generation) return;

	await (async () => {
		try {
			const message = await db.query.messages.findFirst({
				where: and(eq(messages.generationId, generation.id), eq(messages.userId, job.userId)),
			});
			if (!message) throw new Error("Message not found for claimed generation");

			const userMessage = await db.query.messages.findFirst({
				where: and(eq(messages.chatId, message.chatId), eq(messages.role, "user"), eq(messages.type, "text")),
				orderBy: [desc(messages.createdAt)],
				with: { attachments: true },
			});
			const userImages = userMessage?.attachments.length
				? await Promise.all(userMessage.attachments.map((att) => getFileData(att.fileId, job.userId)))
				: undefined;
			const params = generation.parameters as any;
			await executeImageGeneration(
				{
					generationId: generation.id,
					attempt: generation.attempt,
					prompt: generation.prompt,
					provider: generation.provider,
					model: generation.model,
					chatId: message.chatId,
					userId: job.userId,
					userImages: userImages?.filter(Boolean) as string[] | undefined,
					imageCount: params?.imageCount || 1,
					width: params?.width,
					height: params?.height,
					aspectRatio: params?.aspectRatio,
					messageId: message.id,
				},
				{ ...ctx, userId: job.userId },
			);
		} catch (error) {
			console.error("Failed to run claimed generation:", error);
			await db
				.update(messageGenerations)
				.set({ status: "failed", errorReason: "UNKNOWN", updatedAt: new Date().toISOString() })
				.where(
					and(
						eq(messageGenerations.id, generation.id),
						eq(messageGenerations.attempt, generation.attempt),
						eq(messageGenerations.status, "generating"),
					),
				);
		}
	})();
}

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
	const previousFileIds = Array.isArray(originalGeneration.fileIds)
		? (originalGeneration.fileIds as string[])
		: [];

	// Incrementing the version immediately prevents any older execution from publishing.
	const [regenerated] = await db
		.update(messageGenerations)
		.set({
			status: "pending",
			attempt: sql`${messageGenerations.attempt} + 1`,
			fileIds: null, // Clear previous results
			errorReason: null, // Clear previous errors
			generationTime: null, // Clear previous timing
			updatedAt: new Date().toISOString(),
		})
		.where(and(eq(messageGenerations.id, originalGeneration.id), eq(messageGenerations.userId, userId)))
		.returning();
	if (!regenerated) throw new ServiceException("not_found", "Generation not found");
	if (previousFileIds.length) {
		await deleteStoredFiles(previousFileIds, userId);
	}

	// Reset message content while regenerating
	await db
		.update(messages)
		.set({
			content: "", // Reset content while regenerating
		})
		.where(eq(messages.id, req.messageId));

	// Update chat timestamp
	await db.update(chats).set({ updatedAt: new Date().toISOString() }).where(eq(chats.id, chat.id));

	// Start server-side. The existing client trigger remains safe because the claim is atomic.
	await createMessageGenerate({ generationId: originalGeneration.id }, ctx);

	return {
		messageId: req.messageId,
		generationId: originalGeneration.id, // Return the existing generation ID
	};
};

export async function recoverStaleGenerations(
	db: DrizzleDb,
	staleBefore = new Date(Date.now() - 15 * 60_000).toISOString(),
) {
	return await db
		.update(messageGenerations)
		.set({
			status: "failed",
			attempt: sql`${messageGenerations.attempt} + 1`,
			errorReason: "TIMEOUT",
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				or(eq(messageGenerations.status, "pending"), eq(messageGenerations.status, "generating")),
				lt(messageGenerations.updatedAt, staleBefore),
			),
		)
		.returning();
}

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
