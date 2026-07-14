import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { generateId, metaFields } from "../util";

// User-defined relay stations (OpenAI / Google compatible proxies)
export const userRelays = sqliteTable("user_relays", {
	id: text().$defaultFn(generateId).primaryKey(),
	userId: text().notNull(),
	name: text().notNull(),
	// openai: OpenAI-compatible paths; google: Google GenAI compatible
	type: text({ enum: ["openai", "google"] })
		.default("openai")
		.notNull(),
	baseURL: text().notNull(),
	apiKey: text().notNull(),
	// JSON array: { id, name, maxInputImages?: number }[]  (no t2i/i2i ability)
	models: text({ mode: "json" }).notNull(),
	// OpenAI path style: auto | images | responses | endpoints
	// endpoints = use custom t2i/i2i/edit paths below
	apiMode: text({ enum: ["auto", "images", "responses", "endpoints"] })
		.default("endpoints")
		.notNull(),
	// JSON: { t2i, i2i, edit } relative API paths (OpenAI-compatible)
	// e.g. { "t2i": "/images/generations", "i2i": "/images/edits", "edit": "/images/edits" }
	endpoints: text({ mode: "json" }),
	enabled: integer({ mode: "boolean" }).default(true).notNull(),
	...metaFields,
});
