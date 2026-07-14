import { Bot, Network, Settings2, Users } from "lucide-react";
import type { SettingsSection } from "../-components/SettingsNavigation";

/**
 * Settings navigation sections configuration
 * Used by both desktop and mobile views
 * Note: The title field will be replaced with i18n keys at runtime
 */
export const settingsSections: SettingsSection[] = [
	{
		id: "common",
		title: "settings.sections.common", // i18n key
		icon: Settings2,
		path: "/settings/common",
	},
	{
		id: "provider",
		title: "settings.sections.provider", // i18n key
		icon: Bot,
		path: "/settings/provider",
	},
	{
		id: "relay",
		title: "settings.sections.relay", // i18n key
		icon: Network,
		path: "/settings/relay",
	},
	{
		id: "users",
		title: "settings.sections.users", // i18n key
		icon: Users,
		path: "/settings/users",
	},
];

/**
 * Get the default settings section
 */
export const getDefaultSection = () => settingsSections[0]!;

/**
 * Find a settings section by ID
 */
export const findSectionById = (sectionId: string) => settingsSections.find((section) => section.id === sectionId);

/**
 * Validate if a section ID exists in the configuration
 */
export const isValidSectionId = (sectionId: string) => settingsSections.some((section) => section.id === sectionId);
