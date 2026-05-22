/**
 * @deprecated — Wave A consolidation.
 *
 * This module was the original Google Calendar client used by the
 * legacy /api/google/{connect,callback} routes. It is preserved as a
 * thin shim so any straggling imports keep linking, but every export
 * either delegates to the new orchestrator or fails fast with a clear
 * message.
 *
 * New code MUST import from:
 *   • lib/calendar/google.ts    — provider adapter (OAuth + Calendar API)
 *   • lib/calendar/sync.ts      — orchestrator (booking lifecycle hooks)
 *   • lib/calendar/connections.ts — connection state reads
 *
 * Why we kept the file instead of deleting it:
 *   • OAuth redirect URIs registered with Google Cloud Console may
 *     still point to /api/google/callback. The legacy ROUTE now
 *     delegates to the orchestrator, but external code importing
 *     `oauthClient` / `googleAuthUrl` from here would 500 if we
 *     removed the module. Shims protect against that.
 *   • Once all callers migrate, this file can be deleted in a future
 *     wave with no migration concerns.
 */
import { authUrl as canonicalAuthUrl, oauthClient as canonicalClient, exchangeCode } from "./calendar/google";
import { upsertGoogleConnection } from "./calendar/sync";
import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { eq } from "drizzle-orm";

/** @deprecated Use `oauthClient` from `lib/calendar/google`. */
export function oauthClient() {
  return canonicalClient();
}

/** @deprecated Use `authUrl(state)` from `lib/calendar/google`. */
export function googleAuthUrl(userId: string): string {
  return canonicalAuthUrl(userId);
}

/**
 * @deprecated Use the orchestrator: `exchangeCode` + `upsertGoogleConnection`.
 *
 * Functional shim — delegates fully to the new pipeline. Encrypts the
 * token (orchestrator owns crypto), persists to calendar_connections.
 * No longer writes the legacy plaintext column.
 *
 * Used by the legacy /api/google/callback route while we transition.
 */
export async function exchangeCodeAndStore(userId: string, code: string): Promise<void> {
  const tokens = await exchangeCode(code);
  // Resolve the user's tenant — required by the orchestrator. The
  // legacy route doesn't have it in scope.
  const user = await db.query.users.findFirst({
    where: (u, { eq }) => eq(u.id, userId),
    columns: { tenantId: true },
  });
  if (!user) throw new Error("User not found");
  // Re-export silence — drizzle's `eq` is referenced inside the query
  // builder; lint sometimes flags it as unused on this file.
  void tenants;
  void eq;

  await upsertGoogleConnection({
    tenantId: user.tenantId,
    userId,
    refreshTokenPlain: tokens.refreshToken,
    accessTokenPlain: tokens.accessToken,
    accessTokenExpiresAt: tokens.expiresAt,
    accountEmail: tokens.email,
    scopes: tokens.scope,
  });
}

/**
 * @deprecated Use `onBookingCreated` from `lib/calendar/sync`.
 *
 * Throws if called — the old direct-create path bypassed the
 * orchestrator's encryption + sync-log + retry contracts. Booking
 * lifecycle hooks live in the orchestrator now.
 */
export type CreatedEvent = {
  eventId: string;
  meetLink: string | null;
};

export async function createCalendarEventForStaff(): Promise<CreatedEvent | null> {
  throw new Error(
    "createCalendarEventForStaff is deprecated. " +
    "Use onBookingCreated() from lib/calendar/sync.ts instead."
  );
}
