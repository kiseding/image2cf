#!/usr/bin/env node
/**
 * Inject CLOUDFLARE_D1_DATABASE_ID into wrangler.toml for local deploy.
 * Does not commit changes — run before pnpm deploy when not using Actions.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "wrangler.toml");
const id = process.env.CLOUDFLARE_D1_DATABASE_ID;

if (!id) {
	console.error("Set CLOUDFLARE_D1_DATABASE_ID before deploy.");
	process.exit(1);
}

let text = fs.readFileSync(file, "utf8");
if (!/database_id\s*=/.test(text)) {
	console.error("wrangler.toml missing database_id field");
	process.exit(1);
}
text = text.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${id}"`);
fs.writeFileSync(file, text);
console.log("Injected CLOUDFLARE_D1_DATABASE_ID into wrangler.toml");
