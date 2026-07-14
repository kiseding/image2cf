import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { Github, MessageSquare, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";

interface GlobalNavigationProps {
	className?: string;
}

export function GlobalNavigation({ className }: GlobalNavigationProps) {
	const location = useLocation();
	const navigate = useNavigate();
	const { t } = useTranslation();

	const navigationItems = [
		{
			id: "chat",
			label: t("navigation.chat"),
			icon: MessageSquare,
			href: "/chat",
		},
		{
			id: "settings",
			label: t("navigation.settings"),
			icon: Settings,
			href: "/settings",
		},
	];

	const isActive = (href: string) => {
		if (href === "/") return location.pathname === "/";
		return location.pathname === href || location.pathname.startsWith(`${href}/`);
	};

	const handleNavigation = (href: string) => (e: React.MouseEvent) => {
		e.preventDefault();
		navigate({ to: href, search: {} });
	};

	// Desktop-only left rail; mobile bottom bar removed — settings lives in chat sidebar
	return (
		<nav
			className={cn(
				"hidden border-border border-r bg-background/95 backdrop-blur-lg md:fixed md:top-0 md:left-0 md:z-40 md:flex md:h-full md:w-16 md:flex-col",
				className,
			)}
		>
			<div className="flex h-full flex-col items-center pt-2 pb-4">
				<a
					href="/"
					className="mb-2 flex h-14 w-14 items-center justify-center transition-all duration-200 hover:scale-105"
					onClick={handleNavigation("/chat")}
				>
					<img src="/logo.png" alt="Logo" className="h-12 w-12" />
				</a>

				<div className="flex flex-col gap-2">
					{navigationItems.map((item) => {
						const Icon = item.icon;
						const active = isActive(item.href);
						return (
							<Button
								key={item.id}
								variant="ghost"
								size="icon"
								title={item.label}
								className={cn(
									"h-10 w-10 transition-all duration-200 hover:scale-105",
									active
										? "bg-primary/10 text-primary hover:bg-primary/15"
										: "text-muted-foreground hover:bg-accent hover:text-foreground",
								)}
								onClick={handleNavigation(item.href)}
							>
								<Icon className="size-6" />
								{active && (
									<div className="-left-4 -translate-y-1/2 absolute top-1/2 h-6 w-1 rounded-full bg-primary" />
								)}
							</Button>
						);
					})}
				</div>

				<div className="mt-auto">
					<Button
						variant="ghost"
						size="icon"
						className="h-10 w-10 text-muted-foreground transition-all duration-200 hover:scale-105 hover:bg-accent hover:text-foreground"
						onClick={() => window.open("https://github.com/kiseding/image2cf", "_blank")}
					>
						<Github className="size-6" />
					</Button>
				</div>
			</div>
		</nav>
	);
}
