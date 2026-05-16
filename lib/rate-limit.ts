/**
 * Tiny in-memory token bucket. Single-instance MVP-grade.
 * When/if we scale to multiple instances, swap the storage for Redis;
 * the function signature stays the same.
 */

type Bucket = { tokens: number; refilledAt: number };

const buckets = new Map<string, Bucket>();

export type RateLimitResult = { ok: true } | { ok: false; retryAfterMs: number };

export function rateLimit(opts: {
  key: string;             // e.g. `login:1.2.3.4`
  capacity: number;        // max tokens
  refillTokens: number;    // tokens added per window
  windowMs: number;        // window length
}): RateLimitResult {
  const { key, capacity, refillTokens, windowMs } = opts;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: capacity, refilledAt: now };
    buckets.set(key, b);
  }

  // Refill
  const elapsed = now - b.refilledAt;
  if (elapsed >= windowMs) {
    const periods = Math.floor(elapsed / windowMs);
    b.tokens = Math.min(capacity, b.tokens + periods * refillTokens);
    b.refilledAt = b.refilledAt + periods * windowMs;
  }

  if (b.tokens <= 0) {
    return { ok: false, retryAfterMs: windowMs - (now - b.refilledAt) };
  }
  b.tokens -= 1;
  return { ok: true };
}

// Periodic cleanup so the Map doesn't grow without bound on a long-lived
// dev server. Cheap, runs once per 15 min, no-op on fresh process.
const CLEANUP_INTERVAL_MS = 15 * 60_000;
let _cleanupStarted = false;
function startCleanup() {
  if (_cleanupStarted) return;
  _cleanupStarted = true;
  setInterval(() => {
    const cutoff = Date.now() - CLEANUP_INTERVAL_MS * 2;
    for (const [k, b] of buckets) {
      if (b.refilledAt < cutoff && b.tokens >= 1) buckets.delete(k);
    }
  }, CLEANUP_INTERVAL_MS).unref?.();
}
startCleanup();
