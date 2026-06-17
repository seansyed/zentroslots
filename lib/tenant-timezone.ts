/**
 * getTenantTimezone — the canonical BUSINESS timezone for a tenant.
 *
 * Single source of truth for booking time semantics:
 *   • interpreting operator-entered wall-clock booking times, and
 *   • displaying booking times on operator surfaces (web + mobile).
 *
 * Resolution order:
 *   1. tenants.timezone (set at signup from the owner's browser tz).
 *   2. If that's still the UTC default, the earliest admin's real (non-UTC)
 *      tz — covers tenants created before tenants.timezone existed.
 *   3. "UTC" as a last resort (genuinely unknown).
 *
 * Cached per server instance (tenant tz changes ~never) with a short TTL so a
 * settings change is picked up without a redeploy. Never throws.
 */
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";

const TTL_MS = 60_000;
const cache = new Map<string, { tz: string; at: number }>();

export function isRealTimezone(tz: string | null | undefined): tz is string {
  return typeof tz === "string" && tz.trim().length > 0 && tz.trim() !== "UTC";
}

/** Pick the first real (non-empty, non-UTC) timezone, else "UTC". */
export function preferTimezone(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    if (isRealTimezone(c)) return c.trim();
  }
  return "UTC";
}

export async function getTenantTimezone(tenantId: string): Promise<string> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tz;

  let tz = "UTC";
  try {
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: { timezone: true },
    });
    if (isRealTimezone(tenant?.timezone)) {
      tz = tenant!.timezone;
    } else {
      // tenant tz still the UTC default — derive from the earliest admin.
      const owner = await db.query.users.findFirst({
        where: and(eq(users.tenantId, tenantId), eq(users.role, "admin")),
        columns: { timezone: true },
        orderBy: [asc(users.createdAt)],
      });
      if (isRealTimezone(owner?.timezone)) tz = owner!.timezone;
    }
  } catch {
    tz = "UTC";
  }

  cache.set(tenantId, { tz, at: Date.now() });
  return tz;
}

/** Drop a tenant's cached tz (call after a settings update changes it). */
export function invalidateTenantTimezone(tenantId: string): void {
  cache.delete(tenantId);
}
