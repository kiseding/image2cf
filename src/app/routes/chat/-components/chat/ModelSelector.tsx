import ProviderIcon from "@/app/components/icon/ProviderIcon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { Skeleton } from "@/app/components/ui/skeleton";
import { useAiService } from "@/app/hooks/useService";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

interface ModelSelectorProps {
	currentProvider: string;
	currentModel: string;
	onModelChange: (provider: string, model: string) => void;
	isNewChat?: boolean;
}

export function ModelSelector({ currentProvider, currentModel, onModelChange, isNewChat = false }: ModelSelectorProps) {
	const aiService = useAiService();
	const navigate = useNavigate();
	const { t } = useTranslation();

	const { data: providers, isLoading, error } = aiService.getEnabledAiProvidersWithModels.swr(
		"ai-providers-with-models",
	);

	const flatModels = useMemo(() => {
		const list: { providerId: string; providerName: string; modelId: string; modelName: string }[] = [];
		for (const p of providers || []) {
			if (!p?.enabled) continue;
			for (const m of p.models || []) {
				// models from API are already enabled-filtered; treat missing enabled as true
				if (m.enabled === false) continue;
				list.push({
					providerId: p.id,
					providerName: p.name,
					modelId: m.id,
					modelName: m.name || m.id,
				});
			}
		}
		return list;
	}, [providers]);

	// Auto-pick first model for new chat when parent didn't set one
	useEffect(() => {
		if (isLoading || error) return;
		if (!isNewChat) return;
		if (currentProvider && currentModel) return;
		const first = flatModels[0];
		if (first) onModelChange(first.providerId, first.modelId);
	}, [isLoading, error, isNewChat, currentProvider, currentModel, flatModels, onModelChange]);

	const provider = providers?.find((p) => p.id === currentProvider);
	const model = provider?.models.find((m) => m.id === currentModel);
	const displayName = model?.name || currentModel || t("chat.selectModel", "选择模型");

	const currentValue =
		currentProvider && currentModel ? `${currentProvider}|||${currentModel}` : flatModels[0]
			? `${flatModels[0].providerId}|||${flatModels[0].modelId}`
			: "";

	const handleValueChange = (value: string) => {
		const sep = value.indexOf("|||");
		if (sep === -1) return;
		const p = value.slice(0, sep);
		const m = value.slice(sep + 3);
		if (p && m) onModelChange(p, m);
	};

	if (isLoading) {
		return (
			<div className="flex items-center gap-2">
				<Skeleton className="h-4 w-4" />
				<Skeleton className="h-4 w-20" />
			</div>
		);
	}

	if (error) {
		return (
			<button
				type="button"
				className="text-destructive text-xs underline"
				onClick={() => window.location.reload()}
			>
				{t("chat.modelLoadFailed", "模型加载失败，点击重试")}
			</button>
		);
	}

	if (!flatModels.length) {
		return (
			<button
				type="button"
				className="text-primary text-xs underline"
				onClick={() => navigate({ to: "/settings/relay", search: {} })}
			>
				{t("chat.configureRelay", "请先配置中转站/模型")}
			</button>
		);
	}

	return (
		<Select value={currentValue} onValueChange={handleValueChange}>
			<SelectTrigger className="h-7 max-w-[50vw] gap-2 border-primary/20 bg-primary/10 px-3 text-primary hover:bg-primary/20 sm:max-w-xs">
				<SelectValue placeholder={displayName} />
			</SelectTrigger>
			<SelectContent className="max-h-72 [&>*[data-slot=select-scroll-down-button]]:hidden [&>*[data-slot=select-scroll-up-button]]:hidden">
				<div className="max-h-72 overflow-y-auto pr-1 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/50 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-2">
					{(providers || []).map((p) => {
						if (!p.enabled || !p.models?.length) return null;
						return (
							<div key={p.id}>
								<div className="flex items-center gap-2 px-2 py-1.5 font-medium text-muted-foreground text-sm">
									{p.id.startsWith("relay:") ? (
										<span className="flex h-4 w-4 items-center justify-center rounded bg-primary/15 font-bold text-[10px] text-primary">
											R
										</span>
									) : (
										<ProviderIcon provider={p.id} type="mono" className="h-4 w-4" />
									)}
									<span className="truncate">{p.name}</span>
								</div>
								{p.models.map((m) => (
									<SelectItem key={`${p.id}|||${m.id}`} value={`${p.id}|||${m.id}`} className="pl-8">
										{m.name || m.id}
									</SelectItem>
								))}
							</div>
						);
					})}
				</div>
			</SelectContent>
		</Select>
	);
}
