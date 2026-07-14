import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { useAuth } from "@/app/hooks/useAuth";
import { useAdminService } from "@/app/hooks/useService";
import { useToast } from "@/app/hooks/useToast";
import { SettingsPageLayout } from "@/app/routes/settings/-components/SettingsPageLayout";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/settings/users")({
	component: UsersSettingsPage,
});

const emptyForm = {
	username: "",
	password: "",
	role: "user" as "admin" | "user",
};

function UsersSettingsPage() {
	const { t } = useTranslation();
	const { toast } = useToast();
	const { user, isLogin } = useAuth();
	const navigate = useNavigate();
	const adminService = useAdminService();

	const { data: me, isLoading: meLoading } = adminService.getMe.swr(isLogin ? "admin-me" : null);
	const isAdmin = me?.role === "admin";

	const { data: users, isLoading, mutate } = adminService.listUsers.swr(isAdmin ? "admin-users" : null);

	const [dialogOpen, setDialogOpen] = useState(false);
	const [form, setForm] = useState(emptyForm);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!meLoading && me && me.role !== "admin") {
			navigate({ to: "/settings/common" });
		}
	}, [me, meLoading, navigate]);

	if (meLoading || !isAdmin) {
		return (
			<SettingsPageLayout>
				<div className="p-6 text-muted-foreground text-sm">{t("common.loading")}</div>
			</SettingsPageLayout>
		);
	}

	const handleCreate = async () => {
		if (!form.username.trim() || !form.password.trim()) {
			toast({ title: t("common.error"), description: t("settings.users.fillRequired"), variant: "destructive" });
			return;
		}
		setSaving(true);
		try {
			await adminService.createUser({
				username: form.username.trim(),
				password: form.password,
				role: form.role,
			});
			await mutate();
			setDialogOpen(false);
			setForm(emptyForm);
			toast({ title: t("common.success"), description: t("settings.users.created") });
		} catch (e: any) {
			toast({ title: t("common.error"), description: e.message, variant: "destructive" });
		} finally {
			setSaving(false);
		}
	};

	const handleToggleBan = async (id: string, banned: boolean) => {
		try {
			await adminService.updateUser({ id, banned: !banned });
			await mutate();
		} catch (e: any) {
			toast({ title: t("common.error"), description: e.message, variant: "destructive" });
		}
	};

	const handleRoleChange = async (id: string, role: "admin" | "user") => {
		try {
			await adminService.updateUser({ id, role });
			await mutate();
		} catch (e: any) {
			toast({ title: t("common.error"), description: e.message, variant: "destructive" });
		}
	};

	const handleResetPassword = async (id: string) => {
		const password = prompt(t("settings.users.enterNewPassword"));
		if (!password) return;
		if (password.length < 6) {
			toast({ title: t("common.error"), description: t("auth.passwordTooShort"), variant: "destructive" });
			return;
		}
		try {
			await adminService.updateUser({ id, password });
			toast({ title: t("common.success"), description: t("settings.users.passwordUpdated") });
		} catch (e: any) {
			toast({ title: t("common.error"), description: e.message, variant: "destructive" });
		}
	};

	const handleDelete = async (id: string) => {
		if (!confirm(t("settings.users.confirmDelete"))) return;
		try {
			await adminService.deleteUser({ id });
			await mutate();
			toast({ title: t("common.success"), description: t("settings.users.deleted") });
		} catch (e: any) {
			toast({ title: t("common.error"), description: e.message, variant: "destructive" });
		}
	};

	return (
		<SettingsPageLayout>
			<div className="space-y-4 p-6">
				<div className="flex items-center justify-between">
					<p className="text-muted-foreground text-sm">{t("settings.users.hint")}</p>
					<Button size="sm" onClick={() => setDialogOpen(true)}>
						<Plus className="mr-1 h-4 w-4" />
						{t("settings.users.add")}
					</Button>
				</div>

				{isLoading ? (
					<div className="text-muted-foreground text-sm">{t("common.loading")}</div>
				) : !users?.length ? (
					<div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-16 text-muted-foreground">
						<Users className="mb-3 h-10 w-10 opacity-40" />
						<p>{t("settings.users.empty")}</p>
					</div>
				) : (
					<div className="space-y-3">
						{users.map((u) => (
							<div
								key={u.id}
								className="flex flex-col gap-3 rounded-xl border bg-card/60 p-4 sm:flex-row sm:items-center sm:justify-between"
							>
								<div className="min-w-0 space-y-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium">{u.username || u.name}</span>
										<Badge variant={u.role === "admin" ? "default" : "secondary"}>
											{u.role === "admin" ? t("settings.users.roleAdmin") : t("settings.users.roleUser")}
										</Badge>
										{u.banned && <Badge variant="destructive">{t("settings.users.banned")}</Badge>}
										{u.id === user?.id && <Badge variant="outline">{t("settings.users.you")}</Badge>}
									</div>
									{u.name && u.name !== u.username && (
										<p className="truncate text-muted-foreground text-xs">{u.name}</p>
									)}
								</div>
								<div className="flex flex-wrap items-center gap-2">
									<Select
										value={u.role}
										onValueChange={(v) => handleRoleChange(u.id, v as "admin" | "user")}
										disabled={u.id === user?.id}
									>
										<SelectTrigger className="w-28">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="user">{t("settings.users.roleUser")}</SelectItem>
											<SelectItem value="admin">{t("settings.users.roleAdmin")}</SelectItem>
										</SelectContent>
									</Select>
									<Button variant="outline" size="sm" onClick={() => handleResetPassword(u.id)}>
										{t("settings.users.resetPassword")}
									</Button>
									<Button
										variant="outline"
										size="sm"
										onClick={() => handleToggleBan(u.id, u.banned)}
										disabled={u.id === user?.id}
									>
										{u.banned ? t("settings.users.unban") : t("settings.users.ban")}
									</Button>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => handleDelete(u.id)}
										disabled={u.id === user?.id}
									>
										<Trash2 className="h-4 w-4 text-destructive" />
									</Button>
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("settings.users.add")}</DialogTitle>
					</DialogHeader>
					<div className="space-y-4">
						<div className="space-y-2">
							<Label>{t("auth.username")}</Label>
							<Input
								value={form.username}
								onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))}
								placeholder={t("auth.enterUsername")}
								autoComplete="off"
							/>
						</div>
						<div className="space-y-2">
							<Label>{t("auth.password")}</Label>
							<Input
								type="password"
								value={form.password}
								onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
								placeholder={t("auth.enterPassword")}
							/>
						</div>
						<div className="space-y-2">
							<Label>{t("settings.users.role")}</Label>
							<Select
								value={form.role}
								onValueChange={(v) => setForm((p) => ({ ...p, role: v as "admin" | "user" }))}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="user">{t("settings.users.roleUser")}</SelectItem>
									<SelectItem value="admin">{t("settings.users.roleAdmin")}</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setDialogOpen(false)}>
							{t("common.cancel")}
						</Button>
						<Button onClick={handleCreate} disabled={saving}>
							{saving ? t("common.loading") : t("common.create")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</SettingsPageLayout>
	);
}
