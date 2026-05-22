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
export type ConnectionHealthSummary = {
  status: ConnectionStatus | "none";
  consecutiveFailures: number;
  lastSyncedAt: Date | null;
  lastErrorAt: Date | null;
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
};

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
      lastErrorAt: true,
    },
  });

  if (!row) {
    return {
      status: "none",
      consecutiveFailures: 0,
      lastSyncedAt: null,
      lastErrorAt: null,
      connected: false,
      needsReconnect: false,
    };
  }
  return {
    status: row.status as ConnectionStatus,
    consecutiveFailures: row.consecutiveFailures ?? 0,
    lastSyncedAt: row.lastSyncedAt ?? null,
    lastErrorAt: row.lastErrorAt ?? null,
    connected: row.status === "active",
    needsReconnect: row.status === "needs_reconnect",
  };
}

export async function getGoogleHealth(userId: string): Promise<ConnectionHealthSummary> {
  return getProviderHealth(userId, "google");
}

/** Wave C — same shape, but for the Microsoft connection. */
export async function getMicrosoftHealth(userId: string): Promise<ConnectionHealthSummary> {
  return getProviderHealth(userId, "microsoft");
}
