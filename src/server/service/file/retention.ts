import type { DrizzleDb } from "@/server/db";

/** Default object retention in R2 (days). Links in D1 stay forever. */
export const DEFAULT_R2_RETENTION_DAYS = 30;

export function resolveRetentionDays(env?: { R2_RETENTION_DAYS?: string | number }): number {
	const raw = env?.R2_RETENTION_DAYS ?? (typeof process !== "undefined" ? process.env.R2_RETENTION_DAYS : undefined);
	const n = Number(raw);
	if (Number.isFinite(n) && n >= 1 && n <= 3650) return Math.floor(n);
	return DEFAULT_R2_RETENTION_DAYS;
}

function parseR2Key(url: string): string | null {
	if (!url?.startsWith("r2://")) return null;
	return url.replace(/^r2:\/\//, "");
}

/**
 * Delete R2 objects older than retentionDays.
 * D1 `files` rows and preview links are kept permanently; only object bytes are removed.
 */
export async function purgeExpiredR2Objects(params: {
	R2: R2Bucket;
	db?: DrizzleDb;
	retentionDays?: number;
	/** Max objects to scan per run (pagination) */
	maxScan?: number;
}): Promise<{ scanned: number; deleted: number; retentionDays: number; cutoffIso: string }> {
	const retentionDays = params.retentionDays ?? DEFAULT_R2_RETENTION_DAYS;
	const maxScan = params.maxScan ?? 1000;
	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	const cutoffIso = new Date(cutoff).toISOString();

	let scanned = 0;
	let deleted = 0;
	let cursor: string | undefined;
	let truncated = true;

	while (truncated && scanned < maxScan) {
		const listed = await params.R2.list({
			prefix: "users/",
			limit: Math.min(100, maxScan - scanned),
			...(cursor ? { cursor } : {}),
		});

		for (const obj of listed.objects) {
			scanned++;
			const uploaded = obj.uploaded?.getTime?.() ?? 0;
			// Prefer customMetadata.storedAt if present
			const metaStored = obj.customMetadata?.storedAt;
			const storedAt = metaStored ? Date.parse(metaStored) : uploaded;
			if (storedAt && storedAt < cutoff) {
				await params.R2.delete(obj.key);
				deleted++;
			}
		}

		truncated = !!listed.truncated;
		cursor = truncated && "cursor" in listed ? (listed as { cursor?: string }).cursor : undefined;
		if (!cursor) break;
	}

	// Optional: mark D1 rows that no longer have objects (does not delete rows)
	if (params.db && deleted > 0) {
		// Lightweight pass: nothing required for permanent links; preview will 410 when missing.
	}

	return { scanned, deleted, retentionDays, cutoffIso };
}

/** Check if a single R2-backed file is past retention (for debug). */
export function isPastRetention(createdAtIso: string | null | undefined, retentionDays: number): boolean {
	if (!createdAtIso) return false;
	const t = Date.parse(createdAtIso);
	if (!Number.isFinite(t)) return false;
	return Date.now() - t > retentionDays * 24 * 60 * 60 * 1000;
}

export async function fileObjectExists(R2: R2Bucket | undefined, fileUrl: string): Promise<boolean | null> {
	if (!R2) return null;
	const key = parseR2Key(fileUrl);
	if (!key) return null;
	const head = await R2.head(key);
	return !!head;
}
