import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { generateId, metaFields } from "../util";

// User-defined relay stations (OpenAI / Google compatible proxies)
export const userRelays = sqliteTable("user_relays", {
	id: text().$defaultFn(generateId).primaryKey(),
	userId: text().notNull(),
	name: text().notNull(),
	// openai: OpenAI-compatible; google: Google GenAI compatible
	type: text({ enum: ["openai", "google"] })
		.default("openai")
		.notNull(),
	baseURL: text().notNull(),
	apiKey: text().notNull(),
	// JSON array: { id, name, ability?: "t2i"|"i2i", maxInputImages?: number, supportedAspectRatios?: string[] }[]
	models: text({ mode: "json" }).notNull(),
	// OpenAI-compatible API style: auto | images | responses
	apiMode: text({ enum: ["auto", "images", "responses"] })
		.default("auto")
		.notNull(),
	enabled: integer({ mode: "boolean" }).default(true).notNull(),
	...metaFields,
});
