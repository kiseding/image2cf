import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { generateId, metaFields } from "../util";

const storage = ["base64", "disk", "r2"] as const;
export type Storage = (typeof storage)[number];

// Files table
export const files = sqliteTable("files", {
	id: text().$defaultFn(generateId).primaryKey(),
	userId: text().notNull(), // User ID who owns the file
	storage: text({ enum: storage }).notNull(), // Storage type
	url: text().notNull(), // URI or path / r2 object key
	...metaFields,
});
