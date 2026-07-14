import ProviderIcon from "@/app/components/icon/ProviderIcon";
import { ModelSelector } from "./ModelSelector";

interface ModelBadgeProps {
	currentProvider: string;
	currentModel: string;
	onModelChange: (provider: string, model: string) => void;
	isNewChat?: boolean;
}

export function ModelBadge({ currentProvider, currentModel, onModelChange, isNewChat = false }: ModelBadgeProps) {
	const isRelay = currentProvider?.startsWith("relay:");

	return (
		<div className="flex min-w-0 items-center gap-2">
			{currentProvider && !isRelay && (
				<ProviderIcon provider={currentProvider} type="mono" className="h-6 w-6 shrink-0" />
			)}
			{isRelay && (
				<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/15 font-bold text-[11px] text-primary">
					R
				</span>
			)}
			<ModelSelector
				currentProvider={currentProvider}
				currentModel={currentModel}
				onModelChange={onModelChange}
				isNewChat={isNewChat}
			/>
		</div>
	);
}
