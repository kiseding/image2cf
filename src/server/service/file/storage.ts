import { type Storage, files } from "@/server/db/schemas";
import { inBrowser } from "@/server/lib/env";
import { base64ToDataURI, fetchUrlToDataURI } from "@/server/lib/util";
import { and, eq } from "drizzle-orm";
import { getContext } from "../context";

function resolveStorageMode(): Storage {
	if (inBrowser) return "base64";
	const envMode = (process.env.FILE_STORAGE as Storage | undefined) || undefined;
	if (envMode === "r2" || envMode === "base64" || envMode === "disk") return envMode;
	// Auto: prefer R2 when binding is available
	try {
		const { R2 } = getContext();
		if (R2) return "r2";
	} catch {
		/* context not ready */
	}
	return "base64";
}

function parseDataUri(dataUri: string): { mime: string; bytes: Uint8Array; ext: string } {
	const [meta, b64] = dataUri.split(",");
	if (!b64 || !meta) throw new Error("Invalid DataURI");
	const mimeMatch = meta.match(/data:([^;]+)/);
	const mime = mimeMatch?.[1] || "image/png";
	const ext = (mime.split("/")[1] || "png").replace("+xml", "");
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return { mime, bytes, ext };
}

function objectKey(userId: string, ext: string) {
	const id = crypto.randomUUID();
	return `users/${userId}/${id}.${ext}`;
}

async function toBytes(fileData: string): Promise<{ mime: string; bytes: Uint8Array; ext: string }> {
	if (fileData.startsWith("data:")) {
		return parseDataUri(fileData);
	}
	if (/^https?:\/\//i.test(fileData)) {
		const resp = await fetch(fileData);
		if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
		const mime = resp.headers.get("content-type") || "image/png";
		const ext = (mime.split("/")[1] || "png").split(";")[0] || "png";
		const buf = new Uint8Array(await resp.arrayBuffer());
		return { mime, bytes: buf, ext };
	}
	// raw base64
	const normalized = fileData.startsWith("data:") ? fileData : `data:image/png;base64,${fileData}`;
	return parseDataUri(normalized);
}

const storageHandlers: Record<
	Storage,
	{
		save: (fileData: string, userId: string) => Promise<string>;
		get: (file: typeof files.$inferSelect, userId: string) => Promise<string | null>;
	}
> = {
	base64: {
		save: async (fileData) => fileData,
		get: async (file) => file.url,
	},
	disk: {
		save: async (fileData) => fileData,
		get: async () => null,
	},
	r2: {
		save: async (fileData, userId) => {
			const { R2 } = getContext();
			if (!R2) throw new Error("R2 binding is not configured");
			const { mime, bytes, ext } = await toBytes(fileData);
			const key = objectKey(userId, ext);
			const storedAt = new Date().toISOString();
			await R2.put(key, bytes, {
				httpMetadata: {
					contentType: mime,
					// Cache object responses aggressively; link stays valid even after purge returns 410
					cacheControl: "private, max-age=31536000",
				},
				customMetadata: {
					userId,
					storedAt,
					// Object bytes retained ~30d; D1 link (file id) is permanent
					retentionDays: "30",
				},
			});
			// Store as r2://object-key — permanent DB pointer; object may expire
			return `r2://${key}`;
		},
		get: async (file) => file.url,
	},
};

/** D1 practical limit for inline data URI when not using R2 */
const MAX_INLINE_DATA_URI_CHARS = 800_000;

export const saveFiles = async (fileDatas: string[], userId: string) => {
	const { db } = getContext();

	if (!fileDatas?.length) {
		return [];
	}

	const mode = resolveStorageMode();

	const values = await Promise.all(
		fileDatas.map(async (file) => {
			let storage: Storage = mode;
			let url = file;
			const { R2 } = getContext();
			const useR2 = mode === "r2" || !!R2;

			if (useR2 && (mode === "r2" || file.startsWith("data:") || /^https?:\/\//i.test(file))) {
				// Prefer R2 for binary payloads and remote images when available
				if (mode === "r2" || file.startsWith("data:") || /^https?:\/\//i.test(file)) {
					try {
						storage = "r2";
						url = await storageHandlers.r2.save(file, userId);
					} catch (e) {
						if (file.startsWith("data:") && file.length > MAX_INLINE_DATA_URI_CHARS) {
							throw e;
						}
						// Fall back to base64/url string storage for small payloads
						storage = "base64";
						url = await storageHandlers.base64.save(file, userId);
					}
				}
			} else if (file.startsWith("data:") && file.length > MAX_INLINE_DATA_URI_CHARS) {
				throw new Error(
					`Image data too large for database storage (${Math.round(file.length / 1024)}KB). Enable R2 (FILE_STORAGE=r2).`,
				);
			} else {
				url = await storageHandlers[storage].save(file, userId);
			}

			return {
				userId,
				storage,
				url,
			};
		}),
	);

	const filesSave = await db.insert(files).values(values).returning();
	return filesSave.map((f) => f.id);
};

export const getFileMetadata = async (fileId: string, userId: string) => {
	const { db } = getContext();

	const file = await db.query.files.findFirst({
		where: and(eq(files.id, fileId), eq(files.userId, userId)),
	});
	if (!file) {
		return null;
	}

	const accessUrl = await storageHandlers[file.storage as Storage].get(file, userId);
	if (!accessUrl) {
		return null;
	}

	// r2://key is not a valid WHATWG URL with hostname; synthesize protocol
	let protocol: string;
	if (accessUrl.startsWith("r2://")) {
		protocol = "r2:";
	} else {
		try {
			protocol = new URL(accessUrl).protocol;
		} catch {
			protocol = "unknown:";
		}
	}

	return {
		file,
		protocol,
		accessUrl,
	};
};

export const getR2Object = async (r2Url: string) => {
	const { R2 } = getContext();
	if (!R2) return null;
	const key = r2Url.replace(/^r2:\/\//, "");
	return await R2.get(key);
};

/**
 * Get file base64 data URL
 */
export const getFileData = async (fileId: string, userId: string) => {
	const metadata = await getFileMetadata(fileId, userId);
	if (!metadata) {
		return null;
	}

	if (inBrowser) {
		return await storageHandlers.base64.get(metadata.file, userId);
	}

	switch (metadata.protocol) {
		case "data:":
			return metadata.accessUrl;
		case "r2:": {
			const obj = await getR2Object(metadata.accessUrl);
			if (!obj) return null;
			const buf = new Uint8Array(await obj.arrayBuffer());
			const mime = obj.httpMetadata?.contentType || "image/png";
			const ext = mime.split("/")[1] || "png";
			// convert to base64
			let binary = "";
			for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]!);
			return base64ToDataURI(btoa(binary), ext);
		}
		case "file:": {
			const fs = await import("node:fs/promises");
			const fileSuffix = metadata.accessUrl.split(".").pop();
			return base64ToDataURI(await fs.readFile(metadata.accessUrl, "base64"), fileSuffix);
		}
		default:
			return await fetchUrlToDataURI(metadata.accessUrl);
	}
};

export const getFileUrl = async (fileId: string, userId: string) => {
	const metadata = await getFileMetadata(fileId, userId);
	if (!metadata) {
		return null;
	}

	if (inBrowser) {
		return await storageHandlers.base64.get(metadata.file, userId);
	}

	return `/api/files/preview/${metadata.file.id}`;
};

export function getActiveStorageMode(): Storage {
	return resolveStorageMode();
}

function r2KeyFromUrl(url: string): string | null {
	if (!url?.startsWith("r2://")) return null;
	return url.replace(/^r2:\/\//, "");
}

/**
 * Delete stored files (R2 objects + D1 rows). Safe to call with empty/unknown ids.
 * Returns how many D1 rows and R2 objects were removed.
 */
export async function deleteStoredFiles(
	fileIds: string[],
	userId?: string,
): Promise<{ dbDeleted: number; r2Deleted: number }> {
	const { db, R2 } = getContext();
	const ids = [...new Set((fileIds || []).filter(Boolean))];
	if (!ids.length) return { dbDeleted: 0, r2Deleted: 0 };

	let r2Deleted = 0;
	let dbDeleted = 0;

	for (const id of ids) {
		const row = await db.query.files.findFirst({
			where: userId ? and(eq(files.id, id), eq(files.userId, userId)) : eq(files.id, id),
		});
		if (!row) continue;

		if (row.storage === "r2" || row.url.startsWith("r2://")) {
			const key = r2KeyFromUrl(row.url);
			if (key && R2) {
				try {
					await R2.delete(key);
					r2Deleted++;
				} catch (e) {
					console.error("[storage] R2 delete failed", key, e);
				}
			}
		}

		await db.delete(files).where(eq(files.id, id));
		dbDeleted++;
	}

	return { dbDeleted, r2Deleted };
}


