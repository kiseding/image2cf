/**
 * Simple isolate-local fixed window rate limiter.
 * Good enough for Workers (per isolate); not a global distributed limiter.
 */
type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, limit: number, windowMs: number): {
	ok: boolean;
	remaining: number;
	retryAfterMs: number;
} {
	const now = Date.now();
	let b = buckets.get(key);
	if (!b || now >= b.resetAt) {
		b = { count: 0, resetAt: now + windowMs };
		buckets.set(key, b);
	}
	b.count += 1;
	// opportunistic cleanup
	if (buckets.size > 5000) {
		for (const [k, v] of buckets) {
			if (now >= v.resetAt) buckets.delete(k);
		}
	}
	const remaining = Math.max(0, limit - b.count);
	return {
		ok: b.count <= limit,
		remaining,
		retryAfterMs: Math.max(0, b.resetAt - now),
	};
}
