import { Button } from "@/app/components/ui/button";
import { ImagePreview, type ImageSlide } from "@/app/components/ui/image-preview";
import { Textarea } from "@/app/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/app/components/ui/tooltip";
import { useToast } from "@/app/hooks/useToast";
import { cn } from "@/app/lib/utils";
import { getModelById } from "@/server/ai/provider";
import { Image, Send, SlidersHorizontal, X, ZoomIn } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImagePreferences } from "./ImagePreferences";

interface ChatInputProps {
	onSendMessage: (
		content: string,
		imageFiles?: File[],
		imageCount?: number,
		size?: { width?: number; height?: number },
	) => void;
	disabled?: boolean;
	currentProvider?: string;
	currentModel?: string;
	/** External image URLs to attach (from previous generations) */
	referenceImageUrls?: string[];
	onReferenceImagesChange?: (urls: string[]) => void;
}

async function urlToFile(url: string, filename: string): Promise<File> {
	const response = await fetch(url);
	const blob = await response.blob();
	const type = blob.type || "image/png";
	const ext = type.split("/")[1] || "png";
	return new File([blob], filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`, { type });
}

export function ChatInput({
	onSendMessage,
	disabled,
	currentProvider,
	currentModel,
	referenceImageUrls,
	onReferenceImagesChange,
}: ChatInputProps) {
	const { t } = useTranslation();
	const { toast } = useToast();
	const [message, setMessage] = useState("");
	const [selectedImages, setSelectedImages] = useState<File[]>([]);
	const [previewUrls, setPreviewUrls] = useState<string[]>([]);
	const [lightboxOpen, setLightboxOpen] = useState(false);
	const [lightboxIndex, setLightboxIndex] = useState(0);
	const [shouldFocusAfterEnable, setShouldFocusAfterEnable] = useState(false);
	const [imageCount, setImageCount] = useState(1);
	const [width, setWidth] = useState<number | undefined>(undefined);
	const [height, setHeight] = useState<number | undefined>(undefined);
	const [showPreferences, setShowPreferences] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const isComposingRef = useRef(false);
	const mergingRef = useRef(false);

	// Get current model capability and max images
	const { currentModelCapability, maxImages } = (() => {
		if (!currentProvider || !currentModel) return { currentModelCapability: null, maxImages: 1 };

		try {
			const model = getModelById(currentProvider, currentModel) as {
				ability: "t2i" | "i2i";
				maxInputImages?: number;
			};
			return {
				currentModelCapability: model.ability,
				maxImages: model.ability === "i2i" ? model.maxInputImages || 1 : 1,
			};
		} catch {
			// Relay models default to i2i for reference image support
			if (currentProvider.startsWith("relay:")) {
				return { currentModelCapability: "i2i" as const, maxImages: 3 };
			}
			return { currentModelCapability: null, maxImages: 1 };
		}
	})();

	// Determine upload restrictions based on model capability
	const canUploadImages = currentModelCapability && currentModelCapability !== "t2i";

	// Clear images when switching to t2i model or model that doesn't support images
	useEffect(() => {
		if (!canUploadImages && selectedImages.length > 0) {
			// Clean up preview URLs
			for (const url of previewUrls) {
				if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
			}
			setSelectedImages([]);
			setPreviewUrls([]);
			onReferenceImagesChange?.([]);

			// Show toast to inform user
			if (currentModelCapability === "t2i") {
				toast({
					title: t("chat.modelChanged"),
					description: t("chat.textToImageOnlyModel"),
					variant: "default",
				});
			}
		}
	}, [canUploadImages, currentModelCapability, selectedImages.length, previewUrls, toast, t, onReferenceImagesChange]);

	// Merge external reference image URLs (from previous generations) into selected images
	useEffect(() => {
		if (!referenceImageUrls || referenceImageUrls.length === 0 || mergingRef.current) return;
		if (!canUploadImages) {
			toast({
				title: t("chat.modelChanged"),
				description: t("chat.textToImageOnlyModel"),
				variant: "default",
			});
			onReferenceImagesChange?.([]);
			return;
		}

		const merge = async () => {
			mergingRef.current = true;
			try {
				const availableSlots = maxImages - selectedImages.length;
				if (availableSlots <= 0) {
					toast({
						title: t("chat.maxImagesReached"),
						description: t("chat.onlyAddedImages", { added: 0, selected: referenceImageUrls.length }),
						variant: "destructive",
					});
					onReferenceImagesChange?.([]);
					return;
				}

				const urlsToAdd = referenceImageUrls.slice(0, availableSlots);
				const files: File[] = [];
				const urls: string[] = [];
				for (let i = 0; i < urlsToAdd.length; i++) {
					const url = urlsToAdd[i]!;
					try {
						const file = await urlToFile(url, `ref-${Date.now()}-${i}`);
						files.push(file);
						urls.push(url);
					} catch (e) {
						console.error("Failed to load reference image:", e);
					}
				}
				if (files.length > 0) {
					setSelectedImages((prev) => [...prev, ...files]);
					setPreviewUrls((prev) => [...prev, ...urls]);
					toast({
						title: t("chat.referenceAdded"),
						description: t("chat.referenceAddedDesc", { count: files.length }),
					});
				}
			} finally {
				onReferenceImagesChange?.([]);
				mergingRef.current = false;
			}
		};
		merge();
	}, [referenceImageUrls, canUploadImages, maxImages, selectedImages.length, toast, t, onReferenceImagesChange]);

	// Monitor disabled state changes and restore focus when re-enabled
	useEffect(() => {
		if (!disabled && shouldFocusAfterEnable && textareaRef.current) {
			textareaRef.current.focus();
			setShouldFocusAfterEnable(false);
		}
	}, [disabled, shouldFocusAfterEnable]);
	const handleSend = () => {
		if ((!message.trim() && selectedImages.length === 0) || disabled) return;

		// Mark that we should focus after the input is re-enabled
		setShouldFocusAfterEnable(true);

		onSendMessage(message.trim(), selectedImages.length > 0 ? selectedImages : undefined, imageCount, { width, height });
		setMessage("");
		setSelectedImages([]);
		setPreviewUrls([]);

		// Reset textarea height
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
		}
	};

	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		// Ignore Enter key during IME composition (e.g., Chinese input method)
		if (e.key === "Enter" && !e.shiftKey && !isComposingRef.current) {
			e.preventDefault();
			handleSend();
		}
	};

	const handleCompositionStart = useCallback(() => {
		isComposingRef.current = true;
	}, []);

	const handleCompositionEnd = useCallback(() => {
		isComposingRef.current = false;
	}, []);

	const handleUploadClick = () => {
		fileInputRef.current?.click();
	};

	const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files || []);
		const imageFiles = files.filter((file) => file.type.startsWith("image/"));

		if (imageFiles.length === 0) {
			// Reset input
			if (fileInputRef.current) {
				fileInputRef.current.value = "";
			}
			return;
		}

		// Calculate available slots
		const availableSlots = maxImages - selectedImages.length;
		const filesToAdd = imageFiles.slice(0, availableSlots);

		// Show toast if user selected more files than available slots
		if (filesToAdd.length < imageFiles.length) {
			toast({
				title: t("chat.tooManyImagesSelected"),
				description: t("chat.onlyAddedImages", {
					added: filesToAdd.length,
					selected: imageFiles.length,
				}),
				variant: "destructive",
			});
		}

		// Update state only if there are files to add
		if (filesToAdd.length > 0) {
			// Generate preview URLs for new images
			const newUrls = [...previewUrls];
			filesToAdd.forEach((file, index) => {
				newUrls[selectedImages.length + index] = URL.createObjectURL(file);
			});

			setSelectedImages((prev) => [...prev, ...filesToAdd]);
			setPreviewUrls(newUrls);
		}

		// Reset input
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
	};

	const handleRemoveImage = (index: number) => {
		// Clean up preview URL only for blob URLs we created
		const url = previewUrls[index];
		if (url?.startsWith("blob:")) {
			URL.revokeObjectURL(url);
		}

		setSelectedImages((prev) => prev.filter((_, i) => i !== index));
		setPreviewUrls((prev) => prev.filter((_, i) => i !== index));
	};

	const handlePreviewImage = (index: number) => {
		setLightboxIndex(index);
		setLightboxOpen(true);
	};

	// Generate lightbox slides
	const lightboxSlides: ImageSlide[] = selectedImages
		.map((image, index) => ({
			src: previewUrls[index] || "",
			title: image.name,
		}))
		.filter((slide) => slide.src); // Filter out slides without valid src
	return (
		<div className="shrink-0 border-border/50 border-t bg-background/95 px-3 pt-2 pb-[max(0.35rem,env(safe-area-inset-bottom))] backdrop-blur-md md:px-6 md:pt-3 md:pb-3">
			<div className="mx-auto w-full max-w-4xl">
				{/* Input Area */}
				<div className="relative">
					{/* Hidden file input */}
					<input
						ref={fileInputRef}
						type="file"
						accept="image/*"
						onChange={handleImageSelect}
						className="hidden"
						multiple={maxImages > 1}
					/>

					{/* Image preview thumbnails - above the input */}
					{selectedImages.length > 0 && (
						<div className="mb-3 flex flex-wrap gap-2">
							{selectedImages.map((image, index) => (
								<div key={`${image.name}-${index}`} className="group relative">
									<button
										className="relative h-16 w-16 cursor-pointer overflow-hidden rounded-lg border border-border/50 bg-card/80 shadow-sm backdrop-blur-sm transition-all duration-200 hover:scale-105 hover:shadow-md"
										onClick={() => handlePreviewImage(index)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												handlePreviewImage(index);
											}
										}}
										type="button"
										title={image.name}
									>
										<img src={previewUrls[index]} alt={`Preview ${index + 1}`} className="h-full w-full object-cover" />
										{/* Hover overlay */}
										<div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
											<ZoomIn className="h-4 w-4 text-white" />
										</div>
									</button>
									{/* Remove button */}
									<Button
										variant="destructive"
										size="icon"
										onClick={(e) => {
											e.stopPropagation();
											handleRemoveImage(index);
										}}
										className="-right-1 -top-1 absolute h-5 w-5 rounded-full opacity-0 shadow-lg transition-opacity duration-200 group-hover:opacity-100"
									>
										<X className="h-3 w-3" />
									</Button>
								</div>
							))}
						</div>
					)}

					{/* Text input container */}
					<div className="relative rounded-xl border border-border/50 bg-card/80 shadow-sm transition-all duration-200 focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20">
						<Textarea
							ref={textareaRef}
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							onKeyDown={handleKeyDown}
							onCompositionStart={handleCompositionStart}
							onCompositionEnd={handleCompositionEnd}
							placeholder={t("chat.typeMessage")}
							disabled={disabled}
							className={cn(
								// Mobile: compact height so input sits near bottom; desktop a bit taller
								"max-h-40 min-h-[44px] resize-none border-0 bg-transparent px-3 pt-2.5 pb-12 text-base placeholder:text-muted-foreground/60 focus-visible:ring-0 md:max-h-60 md:min-h-[72px] md:pb-14 md:text-sm",
								"dark:!bg-transparent",
							)}
							rows={1}
							onInput={(e) => {
								const target = e.target as HTMLTextAreaElement;
								target.style.height = "auto";
								const max = window.matchMedia("(min-width: 768px)").matches ? 240 : 160;
								target.style.height = `${Math.min(target.scrollHeight, max)}px`;
							}}
						/>

						{/* Bottom buttons area */}
						<div className="absolute inset-x-2 bottom-2 flex items-center justify-between md:inset-x-3 md:bottom-3">
							{/* Left side - Preferences button */}
							<div className="relative flex items-center gap-2">
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant={showPreferences ? "default" : "outline"}
												size="icon"
												onClick={() => setShowPreferences(!showPreferences)}
												className="h-8 w-8 rounded-lg border-border/50 bg-background/80 backdrop-blur-sm transition-all duration-200 hover:scale-105 hover:bg-accent/80"
											>
												<SlidersHorizontal className="h-3.5 w-3.5" />
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											<p>图片偏好设置</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>

								{/* Preferences panel */}
								{showPreferences && (
									<div className="absolute bottom-12 left-0 z-50">
										<ImagePreferences
											imageCount={imageCount}
											width={width}
											height={height}
											onImageCountChange={setImageCount}
											onSizeChange={({ width: w, height: h }) => {
												setWidth(w);
												setHeight(h);
											}}
											currentProvider={currentProvider}
											currentModel={currentModel}
											onClose={() => setShowPreferences(false)}
										/>
									</div>
								)}
							</div>

							{/* Right side - Action buttons */}
							<div className="flex items-center gap-2">
								{/* Image upload button - always show but disable for t2i models */}
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger asChild>
											<div
												className={cn(
													"inline-block",
													(disabled || !canUploadImages || selectedImages.length >= maxImages) && "cursor-not-allowed",
												)}
											>
												<Button
													variant="outline"
													size="icon"
													onClick={handleUploadClick}
													disabled={disabled || !canUploadImages || selectedImages.length >= maxImages}
													className="h-8 w-8 rounded-lg border-border/50 bg-background/80 backdrop-blur-sm transition-all duration-200 hover:scale-105 hover:bg-accent/80 md:h-9 md:w-9"
												>
													<Image className="h-4 w-4" />
												</Button>
											</div>
										</TooltipTrigger>
										<TooltipContent>
											<p>
												{!canUploadImages
													? t("chat.textToImageModelNoUpload")
													: selectedImages.length >= maxImages
														? t("chat.maxImagesReached")
														: t("chat.uploadForImageToImage")}
											</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>

								{/* Send button */}
								<Button
									onClick={handleSend}
									disabled={(!message.trim() && selectedImages.length === 0) || disabled}
									size="icon"
									className="h-8 w-8 rounded-lg bg-gradient-to-r from-primary to-primary/90 transition-all duration-200 hover:scale-105 disabled:scale-100 disabled:opacity-50 md:h-9 md:w-9"
								>
									<Send className="h-4 w-4" />
								</Button>
							</div>
						</div>
					</div>
				</div>

				{/* Image preview lightbox */}
				<ImagePreview
					open={lightboxOpen}
					close={() => setLightboxOpen(false)}
					slides={lightboxSlides}
					index={lightboxIndex}
					onIndexChange={setLightboxIndex}
				/>
			</div>
		</div>
	);
}
