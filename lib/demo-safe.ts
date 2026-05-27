/**
 * lib/demo-safe.ts — Demo tenant side-effect gates.
 *
 * Single source of truth for "is this tenant a non-production demo
 * workspace?" Used by:
 *   • lib/push/enqueue.ts — skip push enqueue for demo bookings
 *   • lib/communications/preferences.ts — gate scheduling emails
 *   • lib/calendar/sync.ts — skip external calendar sync
 *   • Stripe webhook — skip charge processing for demo bookings
 *   • Admin rollups — exclude demo from finance/intelligence KPIs
 *
 * Caching: the flag is read-mostly (set once at seed time, never
 * flipped in steady state), so we keep a 60s in-memory cache. A cold
 * miss costs one indexed SELECT; warm hits are free. Cache is
 * per-process — pm2 cluster mode (we run fork) keeps this trivial.
 *
 * Fail-open: if the lookup errors, we treat the tenant as
 * non-demo. That keeps real customers from being silently muted by
 * a transient DB blip; the worst case is a single email leaking from
 * a demo tenant during an outage, which we accept.
 *
 * Belt-and-suspenders: env-gated providers (no SMTP/RESEND/STRIPE keys)
 * already silently no-op in dev. This flag adds a second layer so demo
 * tenants stay quarantined even if real credentials get installed.
 */

import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";

type CacheEntry = { isDemo: boolean; expiresAt: number };
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/**
 * Returns true when the given tenant is flagged as a demo workspace.
 *
 * Never throws. Fail-open: on any DB error returns false (treats the
 * tenant as a real production tenant, so outbound side effects fire
 * normally). The seeded docs-demo tenants are the only rows that
 * should ever return true here.
 */
export async function isDemoTenant(tenantId: string | null | undefined): Promise<boolean> {
  if (!tenantId) return false;
  const now = Date.now();
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > now) return cached.isDemo;

  try {
    const row = await db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: { isDemo: true },
    });
    const isDemo = Boolean(row?.isDemo);
    cache.set(tenantId, { isDemo, expiresAt: now + CACHE_TTL_MS });
    return isDemo;
  } catch {
    return false;
  }
}

/**
 * Forget a cached entry. Call after flipping `is_demo` (e.g. from the
 * admin /admin/dev/simulation page) so the next request reflects the
 * new state immediately instead of waiting for the TTL.
 */
export function invalidateDemoCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

/**
 * Structured log helper — call this every time a side effect is
 * suppressed by the demo gate. Centralizes the event name so admin
 * dashboards can filter for "what side effects did we silently drop?"
 */
export function logDemoSuppression(args: {
  surface: "email" | "push" | "calendar" | "stripe" | "webhook";
  tenantId: string;
  context?: Record<string, unknown>;
}): void {
  try {
    console.warn(
      JSON.stringify({
        evt: "demo_side_effect_suppressed",
        surface: args.surface,
        tenant_id: args.tenantId,
        ts: new Date().toISOString(),
        ...(args.context ?? {}),
      }),
    );
  } catch {
    /* logging must never throw */
  }
}
