import { Avatar, AvatarFallback, AvatarImage } from "@/app/components/ui/avatar";
import { ImagePreview, type ImageSlide } from "@/app/components/ui/image-preview";
import { Skeleton } from "@/app/components/ui/skeleton";
import { useChatService } from "@/app/hooks/useService";
import { cn } from "@/app/lib/utils";
import type { chatService } from "@/server/service/chat";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GenerationErrorItem } from "./GenerationErrorItem";
import { MessageActions } from "./MessageActions";

// Type inference from service functions
type ChatData = NonNullable<Awaited<ReturnType<typeof chatService.getChatById>>>;
type ChatMessage = ChatData["messages"][0];

type User = {
	id: string;
	nickname: string;
	avatar?: string;
};

interface ChatMessageItemProps {
	message: ChatMessage;
	user: User;
	allMessages?: ChatMessage[]; // Add all messages to get all images
	onMessageUpdate?: (messageId: string, updates: Partial<ChatMessage>) => void;
	onRetry?: (messageId: string) => Promise<void>; // Add retry callback
	onDelete?: (messageId: string) => void; // Add delete callback
	onUseAsReference?: (imageUrls: string[]) => void;
}

export function ChatMessageItem({
	message,
	user,
	allMessages,
	onMessageUpdate,
	onRetry,
	onDelete,
	onUseAsReference,
}: ChatMessageItemProps) {
	const { t } = useTranslation();
	const chatService = useChatService();
	const intervalRef = useRef<NodeJS.Timeout | null>(null);
	const skipPoll = useRef<boolean>(false);
	const pollingGenerationIdRef = useRef<string | null>(null); // Track which generation is being polled
	const [isLightboxOpen, setIsLightboxOpen] = useState(false);
	const [currentImageIndex, setCurrentImageIndex] = useState(0);
	const [isHovered, setIsHovered] = useState(false);
	const isUser = message.role === "user";

	// Get user message attachments
	const userAttachments = message.attachments || [];

	// Get all images from the chat (including user attachments and AI generations)
	const allImages: ImageSlide[] = (allMessages || []).flatMap((msg) => {
		const images: ImageSlide[] = [];

		// Add user attachments
		if (msg.attachments) {
			for (const attachment of msg.attachments) {
				if (attachment.type === "image" && attachment.url) {
					images.push({
						src: attachment.url,
						title: t("chat.userImage"),
					});
				}
			}
		}

		// Add AI generated images
		if (msg.type === "image" && msg.generation?.resultUrls && msg.generation?.status === "completed") {
			const urls = msg.generation!.resultUrls;
			// Handle both string and array formats
			const imageUrls = typeof urls === "string" ? [urls] : (urls as string[]);
			for (const url of imageUrls) {
				images.push({
					src: url,
					title: msg.content || t("chat.generatedImage"),
				});
			}
		}

		return images;
	});
	// Find current image index
	const currentImageUrls = message.generation?.resultUrls;
	const currentImageUrl = currentImageUrls
		? typeof currentImageUrls === "string"
			? currentImageUrls
			: (currentImageUrls as string[])[0]
		: undefined;
	const isCurrentImageSuccessful = message.generation?.status === "completed" && currentImageUrl;

	const formatTime = (date: Date) => {
		return date.toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
		});
	};

	// Transform server data for display
	const displayTime = (() => {
		const date = new Date(message.createdAt);
		// Check if date is valid
		if (Number.isNaN(date.getTime())) {
			// Fallback to current time if invalid
			return new Date();
		}
		return date;
	})();
	const isMessageGenerating = message.generation?.status === "pending" || message.generation?.status === "generating";
	const isMessageFailed = message.generation?.status === "failed";

	// Get current message's images for display
	const currentMessageImages = message.generation?.resultUrls;
	const currentMessageImageUrls = currentMessageImages
		? typeof currentMessageImages === "string"
			? [currentMessageImages]
			: (currentMessageImages as string[])
		: [];

	// Poll generation status for generating messages
	useEffect(() => {
		// Get generation ID from either message.generationId or message.generation?.id
		const generationId = message.generationId || message.generation?.id;

		if (isMessageGenerating && generationId && onMessageUpdate) {
			// If we're already polling this exact generation, don't restart
			if (intervalRef.current && pollingGenerationIdRef.current === generationId) {
				return;
			}

			// Clear any existing interval for a different generation
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
				intervalRef.current = null;
			}

			// Mark this generation as being polled
			pollingGenerationIdRef.current = generationId;

			let reclaimTried = false;
			const pollStatus = async () => {
				try {
					if (skipPoll.current) {
						return;
					}

					const status = await chatService.getGenerationStatus({
						generationId: generationId!,
					});

					if (status) {
						// Lift progress from parameters if top-level missing
						const gen = {
							...status,
							progress:
								(status as any).progress ||
								(status as any).parameters?.progress ||
								undefined,
							resultUrls: (status as any).resultUrls,
						};
						onMessageUpdate(message.id, {
							generation: gen as any,
						});

						// Stop polling if generation is complete or failed
						if (status.status === "completed" || status.status === "failed") {
							if (intervalRef.current) {
								clearInterval(intervalRef.current);
								intervalRef.current = null;
								pollingGenerationIdRef.current = null;
							}
							return;
						}

						// Stale generating (worker waitUntil cut off) → reclaim once
						if (
							!reclaimTried &&
							((status as any).stale ||
								((status.status === "generating" || status.status === "pending") &&
									typeof (status as any).ageMs === "number" &&
									(status as any).ageMs > 90_000))
						) {
							reclaimTried = true;
							console.warn("[poll] reclaiming stale generation", generationId);
							chatService.createMessageGenerate({ generationId: generationId! }).catch((e) => {
								console.error("reclaim generate failed", e);
							});
						}
					}
				} catch (error) {
					console.error("Error polling generation status:", error);
				}
			};

			// Poll sooner so users see "queued → calling" progress quickly
			const timeoutId = setTimeout(() => {
				if (isMessageGenerating && pollingGenerationIdRef.current === generationId) {
					pollStatus();
					intervalRef.current = setInterval(pollStatus, 1500);
				}
			}, 400);

			// Cleanup on unmount or when generation is no longer pending
			return () => {
				clearTimeout(timeoutId);
				if (intervalRef.current) {
					clearInterval(intervalRef.current);
					intervalRef.current = null;
					pollingGenerationIdRef.current = null;
				}
			};
		}

		// If message is no longer generating, clear the interval
		if (!isMessageGenerating && intervalRef.current) {
			clearInterval(intervalRef.current);
			intervalRef.current = null;
			pollingGenerationIdRef.current = null;
		}
	}, [isMessageGenerating, message.generationId, message.id, onMessageUpdate, chatService]);
	// Note: Removed message.generation?.id from dependencies to avoid unnecessary re-runs

	// Cleanup interval on unmount
	useEffect(() => {
		return () => {
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
			}
		};
	}, []);

	return (
		<div
			className={cn("group flex gap-4 p-6 transition-all duration-200", isUser && "flex-row-reverse")}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			{/* Avatar */}
			<div className="flex-shrink-0">
				<Avatar
					className={cn(
						"mt-6 h-10 w-10 ring-2 transition-all duration-200",
						isUser ? "ring-primary/30" : "ring-muted-foreground/20",
					)}
				>
					{isUser ? (
						<>
							<AvatarImage src={user.avatar} alt={user.nickname} />
							<AvatarFallback className="bg-gradient-to-br from-primary to-primary/80 font-medium text-primary-foreground">
								{user.nickname.charAt(0).toUpperCase()}
							</AvatarFallback>
						</>
					) : (
						<>
							<AvatarImage src="/logo.png" alt={t("chat.ai")} />
							<AvatarFallback className="bg-gradient-to-br from-muted-foreground to-muted-foreground/80 text-background">
								<span className="font-bold text-sm">{t("chat.ai")}</span>
							</AvatarFallback>
						</>
					)}
				</Avatar>
			</div>

			{/* Message Content */}
			<div className={cn("min-w-0", message.type === "image" && !message.content ? "" : "flex-1")}>
				{/* Message Header - positioned above the message box */}
				<div className={cn("mb-1 flex items-center gap-2 text-muted-foreground text-xs", isUser && "flex-row-reverse")}>
					<span className="opacity-70">{formatTime(displayTime)}</span>
				</div>

				{/* Message Body - aligned with avatar top */}
				<div className={cn("flex flex-col gap-2", isUser ? "items-end" : "items-start")}>
					{/* User attachments - displayed above the text message */}
					{isUser && userAttachments.length > 0 && (
						<div className={cn("mb-2", isUser ? "flex justify-end" : "flex justify-start")}>
							<div className="w-full max-w-2xl">
								{userAttachments.length === 1 ? (
									<div className="flex justify-center">
										<button
											type="button"
											className="block rounded-xl transition-transform duration-200 hover:scale-[1.02] focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
											onClick={() => {
												if (userAttachments[0]?.url && allImages.length > 0) {
													const imageIndex = allImages.findIndex((img) => img.src === userAttachments[0]?.url);
													setCurrentImageIndex(imageIndex >= 0 ? imageIndex : 0);
													setIsLightboxOpen(true);
												}
											}}
											aria-label={t("chat.clickToEnlarge")}
											disabled={!userAttachments[0]?.url}
										>
											<img
												src={userAttachments[0]?.url || ""}
												alt={t("chat.userImage")}
												className="h-auto w-full max-w-sm rounded-xl object-cover shadow-lg sm:max-w-md md:max-w-lg"
												loading="lazy"
											/>
										</button>
									</div>
								) : (
									<div className="grid grid-cols-1 xs:grid-cols-2 gap-2">
										{userAttachments.map((attachment, index) => (
											<button
												key={`${message.id}-attachment-${attachment.id}`}
												type="button"
												className="block rounded-xl transition-transform duration-200 hover:scale-[1.02] focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
												onClick={() => {
													if (attachment.url && allImages.length > 0) {
														const imageIndex = allImages.findIndex((img) => img.src === attachment.url);
														setCurrentImageIndex(imageIndex >= 0 ? imageIndex : 0);
														setIsLightboxOpen(true);
													}
												}}
												aria-label={t("chat.clickToEnlarge")}
												disabled={!attachment.url}
											>
												<img
													src={attachment.url || ""}
													alt={t("chat.userImage")}
													className="aspect-square h-auto w-full rounded-xl object-cover shadow-lg"
													loading="lazy"
												/>
											</button>
										))}
									</div>
								)}
							</div>
						</div>
					)}

					{/* Text message card container - separate from attachments to maintain independent width */}
					{(message.content || isMessageGenerating || isMessageFailed) && (
						<div className={cn("relative", isUser ? "flex justify-end" : "flex justify-start")}>
							{/* Message Actions - positioned near the message card */}
							{isHovered && !isMessageGenerating && (
								<MessageActions
									messageId={message.id}
									messageType={message.type}
									content={message.content}
									imageUrls={
										isUser
											? (userAttachments.map((att) => att.url).filter(Boolean) as string[])
											: currentMessageImageUrls
									}
									isUser={isUser}
									onDelete={onDelete}
									onUseAsReference={onUseAsReference}
									className={cn(
										"absolute top-1 z-10",
										// Desktop positioning
										isUser ? "sm:-left-2 sm:-translate-x-full" : "sm:-right-2 sm:translate-x-full",
										// Mobile positioning - show inside content area
										isUser ? "right-2 sm:right-auto" : "left-2 sm:left-auto",
									)}
								/>
							)}

							<div
								className={cn(
									"max-w-2xl rounded-xl border border-border/50 bg-card/80 p-4 text-left shadow-sm transition-all duration-200 hover:shadow-md",
								)}
							>
							{isMessageGenerating && !isUser ? (
								(() => {
									const progress = (message.generation as any)?.progress as
										| { phase?: string; percent?: number; message?: string; startedAt?: string }
										| undefined;
									const phase = progress?.phase || (message.generation?.status === "pending" ? "queued" : "calling_api");
									const percent =
										typeof progress?.percent === "number"
											? progress.percent
											: message.generation?.status === "pending"
												? 8
												: 35;
									const phaseLabel = (() => {
										switch (phase) {
											case "queued":
												return t("chat.progress.queued", "已提交，排队中");
											case "preparing":
												return t("chat.progress.preparing", "准备请求…");
											case "calling_api":
												return t("chat.progress.calling", "正在调用生图接口…");
											case "parsing":
												return t("chat.progress.parsing", "解析返回结果…");
											case "saving":
												return t("chat.progress.saving", "保存图片…");
											default:
												return t("chat.generating");
										}
									})();
									const elapsedSec = progress?.startedAt
										? Math.max(0, Math.floor((Date.now() - Date.parse(progress.startedAt)) / 1000))
										: null;
									return (
										<div className="w-full min-w-[16rem] space-y-3 sm:min-w-[20rem]">
											<div className="flex items-center justify-between gap-3">
												<div className="flex items-center gap-2">
													<div className="flex space-x-1">
														<div className="h-2 w-2 animate-bounce rounded-full bg-primary" />
														<div className="h-2 w-2 animate-bounce rounded-full bg-primary delay-75" />
														<div className="h-2 w-2 animate-bounce rounded-full bg-primary delay-150" />
													</div>
													<span className="font-medium text-foreground text-xs">{phaseLabel}</span>
												</div>
												<span className="font-mono text-muted-foreground text-xs tabular-nums">
													{percent}%
													{elapsedSec != null ? ` · ${elapsedSec}s` : ""}
												</span>
											</div>
											<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
												<div
													className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
													style={{ width: `${Math.max(4, Math.min(100, percent))}%` }}
												/>
											</div>
											<p className="text-muted-foreground text-[11px] leading-relaxed">
												{t(
													"chat.progress.hint",
													"消息已发送成功。多数生图接口不支持像素级流式进度，这里显示的是服务端阶段进度。",
												)}
											</p>
											<div className="space-y-2">
												<Skeleton className="h-24 w-full rounded-lg" />
											</div>
										</div>
									);
								})()
							) : isMessageFailed && !isUser ? (
									<div className="space-y-3">
										{/* Show original prompt if available */}
										{message.content && (
											<p className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
										)}
										{/* Show error card */}
										<GenerationErrorItem
											errorReason={message.generation?.errorReason || "UNKNOWN"}
											provider={message.generation?.provider}
											onRetry={async () => {
												skipPoll.current = true;
												try {
													// Call the retry callback with message ID
													await onRetry?.(message.id);
												} finally {
													skipPoll.current = false;
												}
											}}
										/>
									</div>
								) : (
									<>
										{/* Text content */}
										{message.content && (
											<p className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
										)}
									</>
								)}
							</div>
						</div>
					)}

					{/* Display AI generated images - no background/border wrapper, same as attachments */}
					{message.type === "image" && currentMessageImageUrls.length > 0 && (
						<div className={cn("mt-2", isUser ? "flex justify-end" : "flex justify-start")}>
							<div className="w-full max-w-2xl">
								{currentMessageImageUrls.length === 1 ? (
									<div className="flex justify-center">
										<div className="relative">
											{/* Message Actions for single image */}
											{isHovered && (
												<MessageActions
													messageId={message.id}
													messageType={message.type}
													content={message.content}
													imageUrls={currentMessageImageUrls}
													isUser={isUser}
													onDelete={onDelete}
													onUseAsReference={onUseAsReference}
													className={cn(
														"absolute top-1 z-10",
														// Desktop positioning
														isUser ? "sm:-left-2 sm:-translate-x-full" : "sm:-right-2 sm:translate-x-full",
														// Mobile positioning - show inside content area
														isUser ? "right-2 sm:right-auto" : "left-2 sm:left-auto",
													)}
												/>
											)}
											<button
												type="button"
												className="block rounded-xl transition-transform duration-200 hover:scale-[1.02] focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
												onClick={() => {
													if (isCurrentImageSuccessful && allImages.length > 0) {
														const imageIndex = allImages.findIndex((img) => img.src === currentMessageImageUrls[0]);
														setCurrentImageIndex(imageIndex >= 0 ? imageIndex : 0);
														setIsLightboxOpen(true);
													}
												}}
												aria-label={t("chat.clickToEnlarge")}
												disabled={!isCurrentImageSuccessful}
											>
												<img
													src={currentMessageImageUrls[0]}
													alt={t("chat.generatedOrUploaded")}
													className="h-auto w-full max-w-sm rounded-xl object-cover shadow-lg sm:max-w-md md:max-w-lg"
													loading="lazy"
												/>
											</button>
										</div>
									</div>
								) : (
									<div className="relative">
										{/* Message Actions for multiple images */}
										{isHovered && (
											<MessageActions
												messageId={message.id}
												messageType={message.type}
												content={message.content}
												imageUrls={currentMessageImageUrls}
												isUser={isUser}
												onDelete={onDelete}
												onUseAsReference={onUseAsReference}
												className={cn(
													"-top-2 absolute z-10",
													// Desktop positioning
													isUser ? "sm:-left-2 sm:-translate-x-full" : "sm:-right-2 sm:translate-x-full",
													// Mobile positioning - show inside content area
													isUser ? "right-2 sm:right-auto" : "left-2 sm:left-auto",
												)}
											/>
										)}
										<div className="grid grid-cols-1 xs:grid-cols-2 gap-2">
											{currentMessageImageUrls.map((imageUrl, index) => (
												<button
													key={`${message.id}-${imageUrl}-${index}`}
													type="button"
													className="block rounded-xl transition-transform duration-200 hover:scale-[1.02] focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
													onClick={() => {
														if (isCurrentImageSuccessful && allImages.length > 0) {
															const imageIndex = allImages.findIndex((img) => img.src === imageUrl);
															setCurrentImageIndex(imageIndex >= 0 ? imageIndex : 0);
															setIsLightboxOpen(true);
														}
													}}
													aria-label={t("chat.clickToEnlarge")}
													disabled={!isCurrentImageSuccessful}
												>
													<img
														src={imageUrl}
														alt={t("chat.generatedOrUploaded")}
														className="aspect-square h-auto w-full rounded-xl object-cover shadow-lg"
														loading="lazy"
													/>
												</button>
											))}
										</div>
									</div>
								)}
							</div>
						</div>
					)}

					{/* Image Preview for all images */}
					{allImages.length > 0 && (
						<ImagePreview
							open={isLightboxOpen}
							close={() => setIsLightboxOpen(false)}
							slides={allImages}
							index={currentImageIndex}
							onIndexChange={setCurrentImageIndex}
							plugins={{
								captions: false,
							}}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
