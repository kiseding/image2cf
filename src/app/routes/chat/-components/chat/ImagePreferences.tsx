import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Slider } from "@/app/components/ui/slider";
import { getModelById } from "@/server/ai/provider";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export type ImageSizePrefs = {
	width?: number;
	height?: number;
};

interface ImagePreferencesProps {
	imageCount: number;
	width?: number;
	height?: number;
	onImageCountChange: (count: number) => void;
	onSizeChange: (size: ImageSizePrefs) => void;
	currentProvider?: string;
	currentModel?: string;
	/** Default size from relay model config */
	defaultWidth?: number;
	defaultHeight?: number;
	onClose: () => void;
}

export function ImagePreferences({
	imageCount,
	width,
	height,
	onImageCountChange,
	onSizeChange,
	currentProvider,
	currentModel,
	defaultWidth,
	defaultHeight,
	onClose,
}: ImagePreferencesProps) {
	const { t } = useTranslation();
	const panelRef = useRef<HTMLDivElement>(null);

	const modelDefaults = (() => {
		if (!currentProvider || !currentModel) return { w: defaultWidth || 1024, h: defaultHeight || 1024 };
		try {
			const model = getModelById(currentProvider, currentModel) as any;
			return {
				w: model.defaultWidth || defaultWidth || 1024,
				h: model.defaultHeight || defaultHeight || 1024,
			};
		} catch {
			return { w: defaultWidth || 1024, h: defaultHeight || 1024 };
		}
	})();

	const w = width ?? modelDefaults.w;
	const h = height ?? modelDefaults.h;

	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
				onClose();
			}
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [onClose]);

	const setW = (v: number) => {
		const n = Math.min(4096, Math.max(64, Math.round(v) || 1024));
		onSizeChange({ width: n, height: h });
	};
	const setH = (v: number) => {
		const n = Math.min(4096, Math.max(64, Math.round(v) || 1024));
		onSizeChange({ width: w, height: n });
	};

	return (
		<div
			ref={panelRef}
			className="w-72 rounded-lg border border-border/50 bg-background/95 p-3 shadow-lg backdrop-blur-md"
		>
			<div className="space-y-4">
				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<span className="text-muted-foreground text-sm">{t("chat.imageCount")}</span>
						<span className="rounded bg-muted px-2 py-1 font-mono text-xs">{imageCount}</span>
					</div>
					<Slider
						value={[imageCount]}
						onValueChange={(value: number[]) => onImageCountChange(value[0] || 1)}
						max={4}
						min={1}
						step={1}
						className="w-full"
					/>
				</div>

				<div className="space-y-2">
					<span className="text-muted-foreground text-sm">{t("chat.imageSize")}</span>
					<div className="grid grid-cols-2 gap-2">
						<div className="space-y-1">
							<Label className="text-xs">{t("chat.width")}</Label>
							<Input
								type="number"
								min={64}
								max={4096}
								step={64}
								value={w}
								onChange={(e) => setW(Number(e.target.value))}
								className="h-8 font-mono text-xs"
							/>
						</div>
						<div className="space-y-1">
							<Label className="text-xs">{t("chat.height")}</Label>
							<Input
								type="number"
								min={64}
								max={4096}
								step={64}
								value={h}
								onChange={(e) => setH(Number(e.target.value))}
								className="h-8 font-mono text-xs"
							/>
						</div>
					</div>
					<div className="flex flex-wrap gap-1">
						{[
							[1024, 1024],
							[1280, 720],
							[720, 1280],
							[1536, 1024],
							[1024, 1536],
						].map(([pw, ph]) => (
							<button
								key={`${pw}x${ph}`}
								type="button"
								className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] hover:bg-muted"
								onClick={() => onSizeChange({ width: pw, height: ph })}
							>
								{pw}×{ph}
							</button>
						))}
					</div>
					<p className="text-[10px] text-muted-foreground">{t("chat.imageSizeHint")}</p>
				</div>
			</div>
		</div>
	);
}
