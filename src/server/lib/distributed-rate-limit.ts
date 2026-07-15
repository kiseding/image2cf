export async function distributedRateLimit(
	db: D1Database,
	key: string,
	limit: number,
	windowMs: number,
): Promise<{ ok: boolean; remaining: number }> {
	const now = Date.now();
	const resetAt = now + windowMs;
	await db
		.prepare(
			`INSERT INTO rate_limits (key, count, reset_at)
			 VALUES (?, 1, ?)
			 ON CONFLICT(key) DO UPDATE SET
			   count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
			   reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END`,
		)
		.bind(key, resetAt, now, now)
		.run();
	const row = await db.prepare(`SELECT count FROM rate_limits WHERE key = ?`).bind(key).first<{ count: number }>();
	const count = Number(row?.count || 1);
	return { ok: count <= limit, remaining: Math.max(0, limit - count) };
}

export async function cleanupRateLimits(db: D1Database): Promise<void> {
	await db.prepare(`DELETE FROM rate_limits WHERE reset_at <= ?`).bind(Date.now()).run();
}
