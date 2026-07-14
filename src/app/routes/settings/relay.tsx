import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { Switch } from "@/app/components/ui/switch";
import { Textarea } from "@/app/components/ui/textarea";
import { useToast } from "@/app/hooks/useToast";
import { useRelayService } from "@/app/hooks/useService";
import { SettingsPageLayout } from "@/app/routes/settings/-components/SettingsPageLayout";
import { RELAY_PROTOCOL_GUIDE, type RelayProtocol } from "@/server/ai/provider/relay-presets";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, LucideNetwork, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { mutate } from "swr";

export const Route = createFileRoute("/settings/relay")({
	component: RelaySettingsPage,
});

type RelayModelForm = {
	id: string;
	name: string;
	ability: "t2i" | "i2i";
	maxInputImages: number;
};

type RelayForm = {
	name: string;
	type: RelayProtocol;
	baseURL: string;
	apiKey: string;
	enabled: boolean;
	models: RelayModelForm[];
};

const emptyForm: RelayForm = {
	name: "",
	type: "openai",
	baseURL: "",
	apiKey: "",
	enabled: true,
	models: [{ id: "", name: "", ability: "i2i", maxInputImages: 1 }],
};

function RelaySettingsPage() {
	const { t } = useTranslation();
	const { toast } = useToast();
	const relayService = useRelayService();
	const { data: relays, isLoading, mutate: mutateRelays } = relayService.listRelays.swr("relay-list");

	const [dialogOpen, setDialogOpen] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState<RelayForm>(emptyForm);
	const [saving, setSaving] = useState(false);
	const [probing, setProbing] = useState(false);
	const [bulkText, setBulkText] = useState("");
	const [showBulk, setShowBulk] = useState(false);

	const protocolGuide = useMemo(() => RELAY_PROTOCOL_GUIDE[form.type], [form.type]);

	const openCreate = () => {
		setEditingId(null);
		setForm(emptyForm);
		setBulkText("");
		setShowBulk(false);
		setDialogOpen(true);
	};

	const openEdit = async (id: string) => {
		try {
			const detail = await relayService.getRelayById({ id });
			setEditingId(id);
			setForm({
				name: detail.name,
				type: detail.type as RelayProtocol,
				baseURL: detail.baseURL,
				apiKey: detail.apiKey,
				enabled: detail.enabled,
				models: (detail.models as RelayModelForm[]).length
					? (detail.models as RelayModelForm[])
					: emptyForm.models,
			});
			setBulkText("");
			setShowBulk(false);
			setDialogOpen(true);
		} catch (e: any) {
			toast({ title: t("common.error"), description: e.message, variant: "destructive" });
		}
	};

	const handleSave = async () => {
		if (!form.name.trim() || !form.baseURL.trim() || !form.apiKey.trim()) {
			toast({ title: t("common.error"), description: t("settings.relay.fillRequired"), variant: "destructive" });
			return;
		}
		const models = form.models.filter((m) => m.id.trim() && m.name.trim());
		if (models.length === 0) {
			toast({ title: t("common.error"), description: t("settings.relay.needModel"), variant: "destructive" });
			return;
		}

		setSaving(true);
		try {
			if (editingId) {
				await relayService.updateRelay({
					id: editingId,
					name: form.name,
					type: form.type,
					baseURL: form.baseURL,
					apiKey: form.apiKey,
					enabled: form.enabled,
					models,
				});
			} else {
				await relayService.createRelay({
					name: form.name,
					type: form.type,
					baseURL: form.baseURL,
					apiKey: form.apiKey,
					enabled: form.enabled,
					models,
				});
			}
			await mutateRelays();
			await mutate("ai-providers-with-models");
			setDialogOpen(false);
			toast({ title: t("common.success"), description: t("settings.relay.saved") });
		} catch (e: any) {
			toast({ title: t("common.error"), description: e.message, variant: "destructive" });
		} finally {
			setSaving(false);
		}
	};

	const handleDelete = async (id: string) => {
		if (!confirm(t("settings.relay.confirmDelete"))) return;
		try {
			await relayService.deleteRelay({ id });
			await mutateRelays();
			await mutate("ai-providers-with-models");
			toast({ title: t("common.success"), description: t("settings.relay.deleted") });
		} catch (e: any) {
			toast({ title: t("common.error"), description: e.message, variant: "destructive" });
		}
	};

	const handleToggle = async (id: string, enabled: boolean) => {
		try {
			await relayService.updateRelay({ id, enabled });
			await mutateRelays();
			await mutate("ai-providers-with-models");
		} catch (e: any) {
			toast({ title: t("common.error"), description: e.message, variant: "destructive" });
		}
	};

	const updateModel = (index: number, patch: Partial<RelayModelForm>) => {
		setForm((prev) => ({
			...prev,
			models: prev.models.map((m, i) => (i === index ? { ...m, ...patch } : m)),
		}));
	};

	const handleProbe = async (importModels: boolean) => {
		if (!form.baseURL.trim() || !form.apiKey.trim()) {
			toast({ title: t("common.error"), description: t("settings.relay.fillRequired"), variant: "destructive" });
			return;
		}
		setProbing(true);
		try {
			const result = await relayService.probeRelay({
				type: form.type,
				baseURL: form.baseURL,
				apiKey: form.apiKey,
			});
			if (!result.ok) {
				toast({
					title: t("settings.relay.probeFailed"),
					description: result.message,
					variant: "destructive",
				});
				return;
			}
			if (importModels && result.models?.length) {
				const existing = new Map(form.models.filter((m) => m.id).map((m) => [m.id, m]));
				for (const m of result.models) {
					if (!existing.has(m.id)) {
						existing.set(m.id, {
							id: m.id,
							name: m.name,
							ability: (m.ability as "t2i" | "i2i") || "t2i",
							maxInputImages: m.maxInputImages || 1,
						});
					}
				}
				setForm((p) => ({
					...p,
					models: Array.from(existing.values()),
					baseURL: result.baseURL || p.baseURL,
				}));
				toast({
					title: t("settings.relay.probeOk"),
					description: t("settings.relay.importedModels", { count: result.models.length }),
				});
			} else {
				if (result.baseURL) setForm((p) => ({ ...p, baseURL: result.baseURL }));
				toast({ title: t("settings.relay.probeOk"), description: result.message });
			}
		} catch (e: any) {
			toast({ title: t("settings.relay.probeFailed"), description: e.message, variant: "destructive" });
		} finally {
			setProbing(false);
		}
	};

	const applyBulkModels = () => {
		const lines = bulkText
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		if (!lines.length) return;
		const next: RelayModelForm[] = [];
		const seen = new Set<string>();
		for (const line of lines) {
			const [idPart, namePart] = line.split(/[|,=\t]/).map((s) => s.trim());
			const id = idPart || "";
			if (!id || seen.has(id)) continue;
			seen.add(id);
			next.push({
				id,
				name: namePart || id,
				ability: /edit|i2i|img2img|kontext|image/i.test(id) ? "i2i" : "t2i",
				maxInputImages: /edit|i2i|img2img|kontext|image/i.test(id) ? 3 : 1,
			});
		}
		if (!next.length) return;
		setForm((p) => {
			const map = new Map(p.models.filter((m) => m.id).map((m) => [m.id, m]));
			for (const m of next) map.set(m.id, m);
			return { ...p, models: Array.from(map.values()) };
		});
		setShowBulk(false);
		toast({ title: t("common.success"), description: t("settings.relay.importedModels", { count: next.length }) });
	};

	return (
		<SettingsPageLayout>
			<div className="space-y-5 p-6">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="space-y-2">
						<p className="font-medium text-sm">{t("settings.relay.formTitle")}</p>
						<p className="max-w-2xl text-muted-foreground text-sm">{t("settings.relay.genericHint")}</p>
						<ol className="list-decimal space-y-1 pl-5 text-muted-foreground text-xs">
							<li>{t("settings.relay.step1")}</li>
							<li>{t("settings.relay.step2")}</li>
							<li>{t("settings.relay.step3")}</li>
							<li>{t("settings.relay.step4")}</li>
						</ol>
					</div>
					<Button onClick={openCreate} size="sm">
						<Plus className="mr-1 h-4 w-4" />
						{t("settings.relay.add")}
					</Button>
				</div>

				{isLoading ? (
					<div className="text-muted-foreground text-sm">{t("common.loading")}</div>
				) : !relays?.length ? (
					<div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-16 text-muted-foreground">
						<LucideNetwork className="mb-3 h-10 w-10 opacity-40" />
						<p>{t("settings.relay.empty")}</p>
						<p className="mt-1 text-xs">{t("settings.relay.emptyHint")}</p>
					</div>
				) : (
					<div className="space-y-3">
						{relays.map((relay) => (
							<div
								key={relay.id}
								className="flex flex-col gap-3 rounded-xl border bg-card/60 p-4 sm:flex-row sm:items-center sm:justify-between"
							>
								<div className="min-w-0 space-y-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium">{relay.name}</span>
										<Badge variant="secondary">{relay.type === "openai" ? "OpenAI" : "Google"}</Badge>
										{!relay.enabled && <Badge variant="outline">{t("settings.provider.disabled")}</Badge>}
									</div>
									<p className="truncate font-mono text-muted-foreground text-xs">{relay.baseURL}</p>
									<p className="text-muted-foreground text-xs">
										{t("settings.relay.modelCount", { count: relay.models?.length || 0 })} · API Key: {relay.apiKey}
									</p>
								</div>
								<div className="flex items-center gap-2">
									<Switch checked={relay.enabled} onCheckedChange={(v) => handleToggle(relay.id, v)} />
									<Button variant="outline" size="sm" onClick={() => openEdit(relay.id)}>
										{t("common.edit")}
									</Button>
									<Button variant="ghost" size="icon" onClick={() => handleDelete(relay.id)}>
										<Trash2 className="h-4 w-4 text-destructive" />
									</Button>
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
					<DialogHeader>
						<DialogTitle>{editingId ? t("settings.relay.edit") : t("settings.relay.add")}</DialogTitle>
					</DialogHeader>
					<div className="space-y-4">
						<div className="space-y-2">
							<Label>{t("settings.relay.protocol")}</Label>
							<Select
								value={form.type}
								onValueChange={(v) => setForm((p) => ({ ...p, type: v as RelayProtocol }))}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="openai">{RELAY_PROTOCOL_GUIDE.openai.label}</SelectItem>
									<SelectItem value="google">{RELAY_PROTOCOL_GUIDE.google.label}</SelectItem>
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">{protocolGuide.authHint}</p>
						</div>

						<div className="space-y-2">
							<Label>{t("settings.relay.name")}</Label>
							<Input
								value={form.name}
								onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
								placeholder={t("settings.relay.namePlaceholder")}
							/>
						</div>

						<div className="space-y-2">
							<Label>{t("settings.relay.baseURL")}</Label>
							<Input
								value={form.baseURL}
								onChange={(e) => setForm((p) => ({ ...p, baseURL: e.target.value }))}
								placeholder={protocolGuide.basePlaceholder}
							/>
							<p className="text-muted-foreground text-xs">{protocolGuide.baseHint}</p>
						</div>

						<div className="space-y-2">
							<Label>API Key</Label>
							<Input
								type="password"
								value={form.apiKey}
								onChange={(e) => setForm((p) => ({ ...p, apiKey: e.target.value }))}
								placeholder="sk-..."
							/>
						</div>

						<div className="flex flex-wrap gap-2">
							<Button type="button" variant="outline" size="sm" disabled={probing} onClick={() => handleProbe(false)}>
								{probing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
								{t("settings.relay.testConnection")}
							</Button>
							<Button type="button" variant="outline" size="sm" disabled={probing} onClick={() => handleProbe(true)}>
								{probing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
								{t("settings.relay.fetchModels")}
							</Button>
							<Button type="button" variant="ghost" size="sm" onClick={() => setShowBulk((v) => !v)}>
								{t("settings.relay.bulkImport")}
							</Button>
						</div>

						{showBulk && (
							<div className="space-y-2 rounded-lg border p-3">
								<Label className="text-xs">{t("settings.relay.bulkHint")}</Label>
								<Textarea
									value={bulkText}
									onChange={(e) => setBulkText(e.target.value)}
									placeholder={"gpt-image-1|GPT Image 1\ndall-e-3\nflux-kontext-pro"}
									rows={5}
									className="font-mono text-xs"
								/>
								<Button type="button" size="sm" onClick={applyBulkModels}>
									{t("settings.relay.applyBulk")}
								</Button>
							</div>
						)}

						<div className="flex items-center justify-between">
							<Label>{t("settings.provider.enabled")}</Label>
							<Switch checked={form.enabled} onCheckedChange={(v) => setForm((p) => ({ ...p, enabled: v }))} />
						</div>

						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<Label>{t("settings.relay.models")}</Label>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() =>
										setForm((p) => ({
											...p,
											models: [...p.models, { id: "", name: "", ability: "i2i", maxInputImages: 1 }],
										}))
									}
								>
									<Plus className="mr-1 h-3 w-3" />
									{t("settings.relay.addModel")}
								</Button>
							</div>
							{form.models.map((model, index) => (
								<div key={index} className="space-y-2 rounded-lg border p-3">
									<div className="grid grid-cols-2 gap-2">
										<div className="space-y-1">
											<Label className="text-xs">Model ID</Label>
											<Input
												value={model.id}
												onChange={(e) => updateModel(index, { id: e.target.value })}
												placeholder="gpt-image-1"
											/>
										</div>
										<div className="space-y-1">
											<Label className="text-xs">{t("settings.relay.modelName")}</Label>
											<Input
												value={model.name}
												onChange={(e) => updateModel(index, { name: e.target.value })}
												placeholder="GPT Image 1"
											/>
										</div>
									</div>
									<div className="grid grid-cols-2 gap-2">
										<div className="space-y-1">
											<Label className="text-xs">{t("settings.relay.ability")}</Label>
											<Select
												value={model.ability}
												onValueChange={(v) => updateModel(index, { ability: v as "t2i" | "i2i" })}
											>
												<SelectTrigger>
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="t2i">T2I · 文生图</SelectItem>
													<SelectItem value="i2i">I2I · 图生图</SelectItem>
												</SelectContent>
											</Select>
										</div>
										<div className="space-y-1">
											<Label className="text-xs">{t("settings.relay.maxImages")}</Label>
											<Input
												type="number"
												min={1}
												max={10}
												value={model.maxInputImages}
												onChange={(e) => updateModel(index, { maxInputImages: Number(e.target.value) || 1 })}
											/>
										</div>
									</div>
									{form.models.length > 1 && (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="text-destructive"
											onClick={() =>
												setForm((p) => ({
													...p,
													models: p.models.filter((_, i) => i !== index),
												}))
											}
										>
											<Trash2 className="mr-1 h-3 w-3" />
											{t("common.delete")}
										</Button>
									)}
								</div>
							))}
						</div>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setDialogOpen(false)}>
							{t("common.cancel")}
						</Button>
						<Button onClick={handleSave} disabled={saving}>
							{saving ? t("common.loading") : t("common.save")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</SettingsPageLayout>
	);
}
