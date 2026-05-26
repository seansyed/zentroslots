/**
 * Super-admin analytics cache — in-process LRU + TTL.
 *
 * Every section on the super-admin dashboard runs its own query
 * batch. With 12 sections × N visits per minute we'd thrash the DB
 * for read-only aggregations that change slowly. This cache holds
 * computed results for a short TTL (90s default) so a refresh of
 * the dashboard only hits the DB once per window.
 *
 * Scope decisions:
 *   • In-process. Single PM2 fork-mode worker today; cluster-mode
 *     would need Redis or an equivalent. Documented in
 *     docs/SUPER_ADMIN_OPERATIONS.md.
 *   • Bounded — max 200 entries, evict-LRU when full.
 *   • Per-key independent TTL. Some metrics (MRR) can live longer
 *     than others (active activity feed).
 *   • Never throws. Cache miss returns null; callers compute from DB.
 *
 * Concurrency:
 *   Multiple concurrent dashboard hits during a cache miss → all
 *   trigger DB queries. We deliberately do NOT add a single-flight
 *   layer because Drizzle queries are cheap and the admin surface
 *   is low-traffic (< 10 super-admins). A single-flight wrapper can
 *   land later under SA-10 if needed.
 */

type Entry<T> = { value: T; expiresAt: number };

const store = new Map<string, Entry<unknown>>();
const MAX_ENTRIES = 200;

/** Get a cached value. Returns null on miss / expiry. */
export function cacheGet<T>(key: string): T | null {
  const e = store.get(key);
  if (!e) return null;
  if (e.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }
  return e.value as T;
}

/** Set a cached value with explicit TTL in ms. */
export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  // LRU eviction when bounded — drop oldest 20 to avoid evicting per
  // every insert.
  if (store.size >= MAX_ENTRIES) {
    const entries = [...store.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [k] of entries.slice(0, 20)) store.delete(k);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Memoize an async producer: cache-or-compute. The producer is
 *  awaited inside; failures NEVER cache so the next call retries.
 *  Default TTL: 90 seconds — short enough that ops decisions are
 *  fresh, long enough to absorb a tab-refresh storm. */
export async function memoize<T>(
  key: string,
  producer: () => Promise<T>,
  ttlMs = 90_000,
): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await producer();
  cacheSet(key, value, ttlMs);
  return value;
}

/** Test-only helper. Clears the cache. Never call from production. */
export function __clearAnalyticsCache(): void {
  store.clear();
}

/** Returns lightweight stats for observability/health surfaces. */
export function cacheStats(): { size: number; max: number } {
  return { size: store.size, max: MAX_ENTRIES };
}
