/**
 * Single source of truth for "is this user's calendar connected?" reads.
 *
 * Replaces direct reads of `users.google_refresh_token` (the legacy
 * plaintext column being phased out in Wave A). Every page / API that
 * needs to display calendar-connected state should call through here.
 *
 * Why a dedicated module:
 *   • The orchestrator (lib/calendar/sync.ts) is large and surfaces
 *     write helpers; consumers should not need to import it just to
 *     ask "is google connected for this user."
 *   • Cheap correlated SQL — EXISTS + ANY-status check folds into a
 *     single round-trip from the caller's existing query.
 *   • Keeps the closed `CalendarProvider` union in one place so the
 *     orchestrator-vs-page split doesn't drift.
 *
 * The functions here are READ-ONLY. All mutations live in
 * lib/calendar/sync.ts.
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { calendarConnections } from "@/db/schema";

import type { CalendarProvider, ConnectionStatus } from "./types";

/**
 * Returns true iff the user has an ACTIVE row in calendar_connections
 * for the given provider. needs_reconnect / disconnected rows return
 * false — callers display "connect" or "reconnect" CTAs accordingly.
 */
export async function isProviderConnected(
  userId: string,
  provider: CalendarProvider,
): Promise<boolean> {
  const row = await db.query.calendarConnections.findFirst({
    where: and(
      eq(calendarConnections.userId, userId),
      eq(calendarConnections.provider, provider),
      eq(calendarConnections.status, "active"),
    ),
    columns: { id: true },
  });
  return Boolean(row);
}

/** Convenience shorthand — Google. */
export async function isGoogleConnected(userId: string): Promise<boolean> {
  return isProviderConnected(userId, "google");
}

/** Convenience shorthand — Microsoft (Wave C). */
export async function isMicrosoftConnected(userId: string): Promise<boolean> {
  return isProviderConnected(userId, "microsoft");
}

/** Convenience shorthand — Zoom (Wave D). */
export async function isZoomConnected(userId: string): Promise<boolean> {
  return isProviderConnected(userId, "zoom");
}

/**
 * Wave C — true if the user has any active provider connection.
 * Useful for the "your calendar is connected" trust signal on the
 * dashboard, where we don't care WHICH provider the staff chose.
 */
export async function isAnyCalendarConnected(userId: string): Promise<boolean> {
  const row = await db.query.calendarConnections.findFirst({
    where: and(
      eq(calendarConnections.userId, userId),
      eq(calendarConnections.status, "active"),
    ),
    columns: { id: true },
  });
  return Boolean(row);
}

/**
 * Returns the broader connection state for a user — used by the
 * dashboard reconnect banner + future health-check cron. Falls back
 * to "none" when no row exists.
 */
/**
 * Wave C.1 — `health` is a derived, UI-friendly classification on top
 * of `status` + `consecutiveFailures` + `lastErrorAt`. Distinct from
 * `status` because we want to surface "degraded" separately even when
 * the connection is still technically `active` (e.g. a few transient
 * Graph failures but the next call succeeded — admins should see this
 * before it turns into a hard reconnect).
 *
 * Derivation:
 *   - status === 'disconnected'        → 'disconnected'
 *   - status === 'needs_reconnect'     → 'needs_reconnect'
 *   - status === 'active' + 0 failures → 'healthy'
 *   - status === 'active' + 1-3 fails  → 'degraded' (transient pattern)
 *   - status === 'active' + 4+ fails   → 'degraded' (worse pattern; the
 *                                        next auth-class failure flips
 *                                        to needs_reconnect)
 *   - no row                            → 'none'
 *
 * The 4-failure threshold matches the orchestrator's retry exhaustion
 * pattern (3 retries → 4 total attempts) — if every retry burned
 * without producing an auth flip, the connection is operationally
 * unreliable even though credentials still work.
 */
export type ConnectionHealth =
  | "healthy"
  | "degraded"
  | "needs_reconnect"
  | "disconnected"
  | "none";

export type ConnectionHealthSummary = {
  status: ConnectionStatus | "none";
  consecutiveFailures: number;
  lastSyncedAt: Date | null;
  lastErrorAt: Date | null;
  /** Optional message stored on the connection row — surfaces in the
   *  dashboard banner + reconnect email. Wave C.1: actionable copy
   *  for Microsoft (AADSTS-translated) instead of raw error text. */
  lastError: string | null;
  /**
   * True iff status === "active". Pages that just want a connected/
   * not-connected boolean use this instead of `isGoogleConnected(...)`
   * when they already have the full health summary in hand — saves a
   * second round-trip.
   */
  connected: boolean;
  /** True iff status is 'needs_reconnect' — the only status that
   *  warrants a customer-visible reconnect prompt. */
  needsReconnect: boolean;
  /** Wave C.1 — UI-friendly derived state. */
  health: ConnectionHealth;
};

/**
 * Wave C.1 — derive the UI-friendly health classification from raw
 * connection columns. Pure function; safe at module scope; no DB hit.
 */
function deriveHealth(
  status: ConnectionStatus | "none",
  consecutiveFailures: number,
): ConnectionHealth {
  if (status === "none") return "none";
  if (status === "disconnected") return "disconnected";
  if (status === "needs_reconnect") return "needs_reconnect";
  // status === 'active' from here
  if (consecutiveFailures > 0) return "degraded";
  return "healthy";
}

export async function getProviderHealth(
  userId: string,
  provider: CalendarProvider,
): Promise<ConnectionHealthSummary> {
  const row = await db.query.calendarConnections.findFirst({
    where: and(
      eq(calendarConnections.userId, userId),
      eq(calendarConnections.provider, provider),
    ),
    columns: {
      status: true,
      consecutiveFailures: true,
      lastSyncedAt: true,
      lastError: true,
      lastErrorAt: true,
    },
  });

  if (!row) {
    return {
      status: "none",
      consecutiveFailures: 0,
      lastSyncedAt: null,
      lastError: null,
      lastErrorAt: null,
      connected: false,
      needsReconnect: false,
      health: "none",
    };
  }
  const status = row.status as ConnectionStatus;
  const consecutiveFailures = row.consecutiveFailures ?? 0;
  return {
    status,
    consecutiveFailures,
    lastSyncedAt: row.lastSyncedAt ?? null,
    lastError: row.lastError ?? null,
    lastErrorAt: row.lastErrorAt ?? null,
    connected: status === "active",
    needsReconnect: status === "needs_reconnect",
    health: deriveHealth(status, consecutiveFailures),
  };
}

export async function getGoogleHealth(userId: string): Promise<ConnectionHealthSummary> {
  return getProviderHealth(userId, "google");
}

/** Wave C — same shape, but for the Microsoft connection. */
export async function getMicrosoftHealth(userId: string): Promise<ConnectionHealthSummary> {
  return getProviderHealth(userId, "microsoft");
}

/**
 * Wave C.1 — per-provider aggregate health snapshot for a tenant.
 * Used by the calendar settings page header chips + the future
 * enterprise admin dashboard. ONE query, returns counts only.
 *
 * Intentionally NOT a per-staff fan-out — for that the dashboard
 * already paginates the full connection list. This is the rollup.
 */
export type TenantProviderSummary = {
  provider: CalendarProvider;
  totalConnections: number;
  healthy: number;
  degraded: number;
  needsReconnect: number;
  disconnected: number;
};

export async function getTenantProviderSummary(
  tenantId: string,
  provider: CalendarProvider,
): Promise<TenantProviderSummary> {
  const rows = await db
    .select({
      status: calendarConnections.status,
      consecutiveFailures: calendarConnections.consecutiveFailures,
    })
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.tenantId, tenantId),
        eq(calendarConnections.provider, provider),
      ),
    );

  const summary: TenantProviderSummary = {
    provider,
    totalConnections: rows.length,
    healthy: 0,
    degraded: 0,
    needsReconnect: 0,
    disconnected: 0,
  };
  for (const r of rows) {
    const status = r.status as ConnectionStatus;
    const health = deriveHealth(status, r.consecutiveFailures ?? 0);
    if (health === "healthy") summary.healthy++;
    else if (health === "degraded") summary.degraded++;
    else if (health === "needs_reconnect") summary.needsReconnect++;
    else if (health === "disconnected") summary.disconnected++;
  }
  return summary;
}

/** All providers, one round-trip. Foundation for the future
 *  enterprise admin overview without committing to any UI shape yet. */
export async function getTenantCalendarSummary(
  tenantId: string,
): Promise<TenantProviderSummary[]> {
  const rows = await db
    .select({
      provider: calendarConnections.provider,
      status: calendarConnections.status,
      consecutiveFailures: calendarConnections.consecutiveFailures,
    })
    .from(calendarConnections)
    .where(eq(calendarConnections.tenantId, tenantId));

  const buckets = new Map<CalendarProvider, TenantProviderSummary>();
  for (const r of rows) {
    const provider = r.provider as CalendarProvider;
    if (!buckets.has(provider)) {
      buckets.set(provider, {
        provider,
        totalConnections: 0,
        healthy: 0,
        degraded: 0,
        needsReconnect: 0,
        disconnected: 0,
      });
    }
    const b = buckets.get(provider)!;
    b.totalConnections++;
    const status = r.status as ConnectionStatus;
    const health = deriveHealth(status, r.consecutiveFailures ?? 0);
    if (health === "healthy") b.healthy++;
    else if (health === "degraded") b.degraded++;
    else if (health === "needs_reconnect") b.needsReconnect++;
    else if (health === "disconnected") b.disconnected++;
  }
  return Array.from(buckets.values()).sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
}
