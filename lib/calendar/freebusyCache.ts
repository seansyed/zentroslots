/**
 * Wave E — freebusy cache.
 *
 * Backs the orchestrator's getExternalBusyForUser hot path. Without
 * this every slot grid load hammered Google/Microsoft for fresh
 * freebusy data; with this we satisfy most reads from Postgres
 * (~5-20ms) and only hit the provider when the cache is cold or
 * webhook-invalidated.
 *
 * Cache semantics:
 *   • Keyed by (connectionId, windowStart, windowEnd) — exact match.
 *   • TTL adaptive by window width:
 *       windows <= 2h  → 30s
 *       windows <= 24h → 60s
 *       windows >  24h → 120s
 *   • Webhook invalidation: receivers DELETE rows by connectionId,
 *     which makes the next read repopulate. Lower bound is "we never
 *     serve data older than the most recent webhook hit."
 *   • Stale-cache disaster guard: the orchestrator's pre-commit
 *     revalidation (lib/calendar/sync.ts revalidateBeforeBooking)
 *     bypasses the cache for the booking's own start..end window —
 *     even if the cache lies, the booking commit double-checks.
 *
 * Failure mode: any DB error in the cache layer falls through to a
 * fresh provider fetch. The cache is best-effort, not load-bearing.
 */
import { and, eq, lte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { freebusyCache } from "@/db/schema";

import type { BusyInterval, CalendarProvider } from "./types";

/** Window-width-adaptive TTL (ms). */
function ttlForWindow(windowStart: Date, windowEnd: Date): number {
  const widthMs = windowEnd.getTime() - windowStart.getTime();
  const hour = 60 * 60 * 1000;
  if (widthMs <= 2 * hour) return 30 * 1000;
  if (widthMs <= 24 * hour) return 60 * 1000;
  return 120 * 1000;
}

/**
 * Look up cached busy intervals. Returns `null` on miss / expired /
 * any DB error (caller falls through to a fresh provider fetch).
 *
 * NOTE: we deliberately don't `DELETE FROM ... WHERE expires_at <= NOW`
 * here on the hot path — the cleanup cron handles that. Expired rows
 * just get filtered out at read time.
 */
export async function getCachedBusy(args: {
  connectionId: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<BusyInterval[] | null> {
  try {
    const row = await db.query.freebusyCache.findFirst({
      where: and(
        eq(freebusyCache.connectionId, args.connectionId),
        eq(freebusyCache.windowStart, args.windowStart),
        eq(freebusyCache.windowEnd, args.windowEnd),
      ),
      columns: { busyIntervals: true, expiresAt: true },
    });
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    const parsed = row.busyIntervals as Array<{ start: string; end: string }>;
    return parsed.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (err) {
    console.error("[freebusyCache] get failed (falling through):", err);
    return null;
  }
}

/**
 * Persist a freebusy result for a window. We use an UPSERT pattern
 * via delete+insert in a single statement-batch because Drizzle's
 * Postgres ON CONFLICT requires a unique index that we don't have
 * here (cache key is composite + intentionally non-unique to allow
 * concurrent writers to both succeed without blocking each other).
 *
 * Best-effort — write failures don't propagate.
 */
export async function setCachedBusy(args: {
  connectionId: string;
  tenantId: string;
  userId: string;
  windowStart: Date;
  windowEnd: Date;
  busyIntervals: BusyInterval[];
}): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + ttlForWindow(args.windowStart, args.windowEnd));
    // Clear any prior cache entry for this exact window FIRST so
    // we don't grow an unbounded list of historical rows. Then
    // insert the new one. Both steps are non-fatal.
    await db
      .delete(freebusyCache)
      .where(
        and(
          eq(freebusyCache.connectionId, args.connectionId),
          eq(freebusyCache.windowStart, args.windowStart),
          eq(freebusyCache.windowEnd, args.windowEnd),
        ),
      );
    await db.insert(freebusyCache).values({
      connectionId: args.connectionId,
      tenantId: args.tenantId,
      userId: args.userId,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      busyIntervals: args.busyIntervals.map((b) => ({
        start: b.start.toISOString(),
        end: b.end.toISOString(),
      })),
      expiresAt,
    });
  } catch (err) {
    console.error("[freebusyCache] set failed (non-fatal):", err);
  }
}

/**
 * Invalidate every cache row for a connection. Called by the webhook
 * receivers on any change notification. ONE DELETE — no per-row
 * iteration, no global flush.
 */
export async function invalidateConnection(connectionId: string): Promise<number> {
  try {
    const result = await db
      .delete(freebusyCache)
      .where(eq(freebusyCache.connectionId, connectionId))
      .returning({ id: freebusyCache.id });
    return result.length;
  } catch (err) {
    console.error("[freebusyCache] invalidate failed (non-fatal):", err);
    return 0;
  }
}

/**
 * Bulk eviction of expired rows. Called by the cache-cleanup cron.
 * Bounded LIMIT keeps each run from monopolizing the connection pool.
 */
export async function cleanupExpired(limit = 5000): Promise<number> {
  try {
    const result = await db.execute<{ deleted: number }>(
      sql`WITH evicted AS (
            DELETE FROM freebusy_cache
             WHERE id IN (
               SELECT id FROM freebusy_cache
                WHERE expires_at <= NOW()
                LIMIT ${limit}
             )
             RETURNING 1
          )
          SELECT COUNT(*)::int AS deleted FROM evicted`,
    );
    const rows = result as unknown as Array<{ deleted: number }>;
    return rows[0]?.deleted ?? 0;
  } catch (err) {
    console.error("[freebusyCache] cleanupExpired failed (non-fatal):", err);
    return 0;
  }
}

/** Wave E — observability rollups. */
export type FreebusyCacheStats = {
  total: number;
  active: number;
  expired: number;
  perProvider: Array<{ provider: CalendarProvider; count: number }>;
};

export async function getCacheStats(tenantId?: string): Promise<FreebusyCacheStats> {
  try {
    const where = tenantId
      ? sql`WHERE c.tenant_id = ${tenantId}`
      : sql``;
    const result = await db.execute<{
      total: number;
      active: number;
      provider: string;
      count: number;
    }>(
      sql`SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE c.expires_at > NOW())::int AS active,
            cc.provider,
            COUNT(*)::int AS count
            FROM freebusy_cache c
            JOIN calendar_connections cc ON cc.id = c.connection_id
            ${where}
            GROUP BY cc.provider`,
    );
    const rows = result as unknown as Array<{ total: number; active: number; provider: string; count: number }>;
    if (rows.length === 0) {
      return { total: 0, active: 0, expired: 0, perProvider: [] };
    }
    const total = rows.reduce((sum, r) => sum + Number(r.count ?? 0), 0);
    const active = rows.reduce((sum, r) => sum + Number(r.active ?? 0), 0);
    return {
      total,
      active,
      expired: total - active,
      perProvider: rows.map((r) => ({ provider: r.provider as CalendarProvider, count: Number(r.count) })),
    };
  } catch (err) {
    console.error("[freebusyCache] getCacheStats failed:", err);
    return { total: 0, active: 0, expired: 0, perProvider: [] };
  }
}

// Re-export so callers that hit `lte` elsewhere don't lose the import.
void lte;
