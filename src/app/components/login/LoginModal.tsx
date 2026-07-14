import { Button } from "@/app/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { useAuth } from "@/app/hooks/useAuth";
import { authClient } from "@/app/lib/auth-client";
import { useUIStore } from "@/app/stores";
import { AlertCircle, Eye, EyeOff, Lock, User } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface LoginModalProps {
	/** When true, modal cannot be dismissed until logged in */
	forceOpen?: boolean;
}

export function LoginModal({ forceOpen = false }: LoginModalProps) {
	const { isLoginModalOpen, closeLoginModal, openLoginModal } = useUIStore();
	const { isLogin, user } = useAuth();
	const { t } = useTranslation();
	const open = forceOpen || isLoginModalOpen;

	const [showPassword, setShowPassword] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [formData, setFormData] = useState({
		username: "",
		password: "",
	});

	const resetAllState = () => {
		setFormData({ username: "", password: "" });
		setShowPassword(false);
		setError(null);
		setIsLoading(false);
	};

	useEffect(() => {
		if (isLogin && user && isLoginModalOpen) {
			handleClose();
		}
	}, [isLogin, user, isLoginModalOpen]);

	const handleInputChange = (field: string, value: string) => {
		setFormData((prev) => ({
			...prev,
			[field]: value,
		}));
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsLoading(true);
		setError(null);

		try {
			const response = await authClient.signIn.username({
				username: formData.username.trim(),
				password: formData.password,
			});

			if (response.error) {
				const errorCode = response.error.code;
				switch (errorCode) {
					case "INVALID_USERNAME_OR_PASSWORD":
					case "INVALID_EMAIL_OR_PASSWORD":
						setError(t("auth.invalidUsernameOrPassword"));
						break;
					case "USER_BANNED":
					case "FORBIDDEN":
						setError(t("auth.userBanned"));
						break;
					default:
						setError(response.error.message || t("auth.loginFailed"));
						break;
				}
				return;
			}

			window.location.reload();
		} catch (error: any) {
			console.error("Authentication error:", error);
			setError(error.message || t("auth.networkError"));
		} finally {
			setIsLoading(false);
		}
	};

	const handleClose = (nextOpen?: boolean) => {
		if (forceOpen && !isLogin) {
			openLoginModal();
			return;
		}
		if (nextOpen === false || nextOpen === undefined) {
			closeLoginModal();
			resetAllState();
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent
				className="sm:max-w-md"
				hideClose={forceOpen && !isLogin}
				onPointerDownOutside={(e) => {
					if (forceOpen && !isLogin) e.preventDefault();
				}}
				onEscapeKeyDown={(e) => {
					if (forceOpen && !isLogin) e.preventDefault();
				}}
				onInteractOutside={(e) => {
					if (forceOpen && !isLogin) e.preventDefault();
				}}
			>
				<DialogHeader className="space-y-3">
					<DialogTitle className="text-center font-bold text-2xl">{t("auth.welcomeBack")}</DialogTitle>
					<DialogDescription className="text-center text-muted-foreground">
						{t("auth.loginDescription")}
					</DialogDescription>
				</DialogHeader>

				{error && (
					<div className="fade-in flex animate-in items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-600 text-sm duration-200">
						<AlertCircle className="h-4 w-4 flex-shrink-0" />
						<span>{error}</span>
					</div>
				)}

				<form onSubmit={handleSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="username">{t("auth.username")}</Label>
						<div className="relative">
							<User className="-translate-y-1/2 absolute top-1/2 left-3 h-4 w-4 text-muted-foreground" />
							<Input
								id="username"
								type="text"
								autoComplete="username"
								placeholder={t("auth.enterUsername")}
								value={formData.username}
								onChange={(e) => handleInputChange("username", e.target.value)}
								className="pl-10"
								required
							/>
						</div>
					</div>

					<div className="space-y-2">
						<Label htmlFor="password">{t("auth.password")}</Label>
						<div className="relative">
							<Lock className="-translate-y-1/2 absolute top-1/2 left-3 h-4 w-4 text-muted-foreground" />
							<Input
								id="password"
								type={showPassword ? "text" : "password"}
								autoComplete="current-password"
								placeholder={t("auth.enterPassword")}
								value={formData.password}
								onChange={(e) => handleInputChange("password", e.target.value)}
								className="pr-10 pl-10"
								required
							/>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="-translate-y-1/2 absolute top-1/2 right-1 h-8 w-8 p-0"
								onClick={() => setShowPassword(!showPassword)}
							>
								{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
							</Button>
						</div>
					</div>

					<Button type="submit" className="w-full" size="lg" disabled={isLoading}>
						{isLoading ? (
							<div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
						) : (
							t("auth.login")
						)}
					</Button>

					<p className="text-center text-muted-foreground text-xs">{t("auth.noRegistration")}</p>
				</form>
			</DialogContent>
		</Dialog>
	);
}
