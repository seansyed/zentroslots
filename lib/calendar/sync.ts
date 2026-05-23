/**
 * Provider-agnostic calendar sync orchestrator.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  OWNERSHIP MODEL — READ THIS BEFORE EDITING
 * ═══════════════════════════════════════════════════════════════════
 *
 * Calendar ownership in ZentroMeet is PER STAFF, not per workspace.
 * Every function in this module is keyed by `userId` — never by
 * `tenantId`. There is no such thing as a "workspace calendar."
 *
 * The architecture stack:
 *
 *   Workspace ─ enables which providers staff MAY connect
 *               (tenants.enabled_integrations — migration 0035)
 *      ↓
 *   Staff ──── owns the actual OAuth tokens, calendar id, busy
 *               events, and meeting-creation responsibility
 *               (calendarConnections — migration 0019, keyed by
 *               (userId, provider))
 *      ↓
 *   Engine ── reads ONLY from per-staff calendars when computing
 *               available slots for a booking. See
 *               getExternalBusyForUser() below, called from
 *               lib/availability.ts.
 *
 * Consequences:
 *   • Booking availability NEVER reads from the workspace level.
 *   • The legacy `users.google_refresh_token` column is preserved
 *     for backward compatibility ONLY — new reads should derive
 *     "Google connected" state from calendarConnections, never
 *     from that legacy column.
 *   • Workspace-level integration disablement (migration 0035)
 *     blocks NEW connect attempts but leaves existing connections
 *     functional. Busy events still flow into slot generation
 *     until the staff member explicitly disconnects.
 *
 * Future routing (round-robin, pooled, collective scheduling, etc.)
 * will pick A STAFF MEMBER first, then resolve THAT staff member's
 * calendar through this module. The routing layer never needs to
 * know which provider the chosen staff happens to use.
 *
 * ═══════════════════════════════════════════════════════════════════
 *
 * Booking-lifecycle entry points:
 *   onBookingCreated(booking, staff)        → create external event
 *   onBookingRescheduled(booking, staff)    → patch start/end
 *   onBookingCancelled(booking, staff)      → delete event
 *   getExternalBusyForUser(userId, range)   → freebusy for collision check
 *
 * Connection management:
 *   getActiveConnection(userId, provider)
 *   markNeedsReconnect(connectionId, error)
 *   markActive(connectionId, accountEmail?)
 *   disconnect(connectionId)
 *   upsertGoogleConnection(...)             ← called by OAuth callback
 *
 * Every operation that talks to a provider is wrapped in writeSyncLog():
 *   - success → 'ok' row with latency
 *   - auth failure → 'failed' row + status flip to 'needs_reconnect'
 *   - not_found → 'ok' row (idempotent delete/update)
 *   - transient/rate_limit → 'failed' row, status untouched
 *
 * NEVER throws to the caller. Booking routes get a structured result
 * they can ignore on failure (booking still commits). This is the
 * "additive" rule: a failing sync NEVER blocks a booking action.
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookings,
  calendarConnections,
  calendarSyncLogs,
  webhookChannels,
  type User,
} from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getCachedBusy, invalidateConnection, setCachedBusy } from "./freebusyCache";
import {
  stopCalendarWatch as googleStopWatch,
  watchCalendar as googleWatchCalendar,
} from "./webhooks/google";
import {
  renewSubscription as microsoftRenewSubscription,
  subscribeCalendar as microsoftSubscribeCalendar,
  unsubscribe as microsoftUnsubscribe,
} from "./webhooks/microsoft";
import { randomUUID, randomBytes } from "node:crypto";

import {
  type BusyInterval,
  type CalendarProvider,
  type ErrorClass,
  type ExternalEventDraft,
  type ExternalEventResult,
  type SyncKind,
} from "./types";
import {
  classifyError as googleClassifyError,
  createEvent as googleCreateEvent,
  deleteEvent as googleDeleteEvent,
  errorMessage as googleErrorMessage,
  getBusy as googleGetBusy,
  updateEvent as googleUpdateEvent,
} from "./google";
import {
  classifyError as microsoftClassifyError,
  createEvent as microsoftCreateEvent,
  deleteEvent as microsoftDeleteEvent,
  describeError as microsoftDescribeError,
  errorMessage as microsoftErrorMessage,
  getBusy as microsoftGetBusy,
  refreshAccessToken as microsoftRefreshAccessToken,
  updateEvent as microsoftUpdateEvent,
} from "./microsoft";
import {
  classifyError as zoomClassifyError,
  createEvent as zoomCreateEvent,
  deleteEvent as zoomDeleteEvent,
  describeError as zoomDescribeError,
  errorMessage as zoomErrorMessage,
  refreshAccessToken as zoomRefreshAccessToken,
  updateEvent as zoomUpdateEvent,
} from "./zoom";
import { notifyReconnectRequired } from "./notifyReconnect";

// ─── Retry policy ──────────────────────────────────────────────────────
// Wave A — retry-with-backoff for transient + rate_limit failures.
// Idempotency is guaranteed by:
//   • createEvent: stable Google requestId (organizer + startMs)
//   • updateEvent: PATCH is idempotent server-side
//   • deleteEvent: 404 already treated as success
//   • freebusy: pure read
// So retrying is always safe. Hard caps protect against retry storms.
const RETRY_DELAYS_MS = [250, 1000, 2500]; // 3 retries → 4 total attempts
const FREEBUSY_RETRY_DELAYS_MS = [200, 600]; // 2 retries → 3 total attempts
                                              // (cheaper read; tighter budget)
const RETRYABLE_CLASSES: readonly ErrorClass[] = ["transient", "rate_limit"];

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ─── Provider-aware error helpers ──────────────────────────────────────
// Both adapters expose `classifyError` and `errorMessage` with identical
// signatures but each understands its own provider's quirks (Google's
// `invalid_grant` vs. Microsoft's `AADSTS70008`, etc). We pick the
// right one based on which adapter raised the error.

function classifyError(provider: CalendarProvider, err: unknown): ErrorClass {
  if (provider === "google") return googleClassifyError(err);
  if (provider === "microsoft") return microsoftClassifyError(err);
  return zoomClassifyError(err);
}

function errorMessage(provider: CalendarProvider, err: unknown): string {
  if (provider === "google") return googleErrorMessage(err);
  if (provider === "microsoft") return microsoftErrorMessage(err);
  return zoomErrorMessage(err);
}

/**
 * Wave C.1 — turn an error into a human-readable description for
 * `connection.last_error` + the reconnect email body. Microsoft has
 * a rich AADSTS catalog we can mine for actionable copy; Wave D adds
 * a parallel Zoom translator. Google's errors are already digestible
 * so we just return the raw message.
 */
function describeError(provider: CalendarProvider, err: unknown): string {
  if (provider === "microsoft") return microsoftDescribeError(err);
  if (provider === "zoom") return zoomDescribeError(err);
  return errorMessage(provider, err);
}

/**
 * Wave C.1 — honor server Retry-After hints when retrying rate-limit
 * failures. Graph 429 responses carry `retry-after` (seconds); we
 * sleep at least that long before the next attempt. Falls back to the
 * configured backoff for transient (non-rate-limit) retries.
 *
 * Clamped to [50ms, 60s] so a bogus header can neither vanish the
 * delay nor pin the worker indefinitely.
 */
function retryDelayForAttempt(
  cls: ErrorClass,
  err: unknown,
  defaultMs: number,
): number {
  if (cls !== "rate_limit") return defaultMs;
  const hint = (err as { retryAfterSec?: number })?.retryAfterSec;
  if (typeof hint === "number" && hint > 0) {
    return Math.min(60_000, Math.max(50, hint * 1000));
  }
  return defaultMs;
}

// ─── Microsoft access-token cache ──────────────────────────────────────
// Microsoft tokens are bearer tokens with a ~1h lifetime. Refreshing on
// every call is correct but slow (an extra round-trip to login.micro
// soft.com on each Graph operation). To keep the freebusy hot path
// reasonable we cache the access token on the calendar_connections row
// itself (already has accessTokenEncrypted + accessTokenExpiresAt
// columns from migration 0019). The cache logic:
//
//   1. Read the row. If accessTokenEncrypted is present AND
//      accessTokenExpiresAt is > 60s from now, use it directly.
//   2. Otherwise refresh: decrypt the refresh token, call
//      refreshAccessToken(), encrypt + persist BOTH new tokens
//      (Microsoft rolling-refresh rotates the refresh token too).
//   3. Return the access token.
//
// The 60s safety margin protects against clock skew + in-flight calls
// that might take a few seconds to reach Graph after our local check.
//
// Failure handling is BEST EFFORT: if the persist step fails we still
// return the fresh token so the current operation succeeds; the next
// call just refreshes again (slightly more load on login endpoint,
// but no functional break).
const TOKEN_REFRESH_SAFETY_MS = 60_000;

// Exported (Phase 17I) so the calendar_events orchestrator can reuse
// the same token cache + rolling-refresh logic without duplicating it.
// Still private-by-convention to anything outside the calendar/* layer.
export async function getMicrosoftAccessToken(
  conn: typeof calendarConnections.$inferSelect,
): Promise<string | null> {
  // Fast path: usable cached access token.
  if (
    conn.accessTokenEncrypted &&
    conn.accessTokenExpiresAt &&
    conn.accessTokenExpiresAt.getTime() - Date.now() > TOKEN_REFRESH_SAFETY_MS
  ) {
    const cached = safeDecrypt(conn.accessTokenEncrypted);
    if (cached) return cached;
    // Fall through to refresh if the cache is corrupt.
  }

  const refreshToken = safeDecrypt(conn.refreshTokenEncrypted);
  if (!refreshToken) return null;

  const refreshed = await microsoftRefreshAccessToken(refreshToken);

  // Persist the new pair. Microsoft rolling-refresh means the refresh
  // token itself may have rotated — we MUST store the new one or the
  // chain breaks 24h later.
  try {
    const newRefreshEnc = encryptSecret(refreshed.refreshToken)!;
    const newAccessEnc = encryptSecret(refreshed.accessToken);
    await db
      .update(calendarConnections)
      .set({
        refreshTokenEncrypted: newRefreshEnc,
        accessTokenEncrypted: newAccessEnc,
        accessTokenExpiresAt: refreshed.expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(calendarConnections.id, conn.id));
  } catch (e) {
    console.error("[calendar/sync] microsoft token persist failed (non-fatal):", e);
  }

  return refreshed.accessToken;
}

/**
 * Wave D — Zoom access-token cache. Same shape as the Microsoft helper
 * above: read the cached access token, refresh if expired (with a 60s
 * safety margin), persist the new pair (Zoom uses rolling refresh too).
 *
 * Zoom access tokens live ~1h; refresh tokens have a 15-year lifetime
 * but rotate on every refresh call, so persisting the new refresh
 * token is non-negotiable. A persist failure is logged but doesn't
 * fail the current call — we just refresh again next time.
 */
// Exported (Phase 17I-2B) so the calendar_events orchestrator can
// reuse the same Zoom token cache + rolling-refresh logic when an
// internal meeting selects videoProvider="zoom".
export async function getZoomAccessToken(
  conn: typeof calendarConnections.$inferSelect,
): Promise<string | null> {
  if (
    conn.accessTokenEncrypted &&
    conn.accessTokenExpiresAt &&
    conn.accessTokenExpiresAt.getTime() - Date.now() > TOKEN_REFRESH_SAFETY_MS
  ) {
    const cached = safeDecrypt(conn.accessTokenEncrypted);
    if (cached) return cached;
  }

  const refreshToken = safeDecrypt(conn.refreshTokenEncrypted);
  if (!refreshToken) return null;

  const refreshed = await zoomRefreshAccessToken(refreshToken);

  try {
    const newRefreshEnc = encryptSecret(refreshed.refreshToken)!;
    const newAccessEnc = encryptSecret(refreshed.accessToken);
    await db
      .update(calendarConnections)
      .set({
        refreshTokenEncrypted: newRefreshEnc,
        accessTokenEncrypted: newAccessEnc,
        accessTokenExpiresAt: refreshed.expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(calendarConnections.id, conn.id));
  } catch (e) {
    console.error("[calendar/sync] zoom token persist failed (non-fatal):", e);
  }

  return refreshed.accessToken;
}

// ─── Public result type ────────────────────────────────────────────────

export type SyncResult =
  | { status: "ok"; provider: CalendarProvider; eventId?: string; meetLink?: string | null }
  | { status: "skipped"; reason: string }
  | { status: "failed"; errorClass: ErrorClass; message: string };

// ─── Connection management ─────────────────────────────────────────────

export async function getActiveConnection(
  userId: string,
  provider: CalendarProvider
): Promise<typeof calendarConnections.$inferSelect | null> {
  const row = await db.query.calendarConnections.findFirst({
    where: and(
      eq(calendarConnections.userId, userId),
      eq(calendarConnections.provider, provider)
    ),
  });
  if (!row) return null;
  if (row.status === "disconnected") return null;
  return row;
}

/**
 * Wave C — return all non-disconnected connections for a user across
 * every provider. Used by `getExternalBusyForUser` so a staff member
 * with both a Google and a Microsoft calendar gets busy-time from
 * both subtracted from their bookable window. Returns active +
 * needs_reconnect rows; the freebusy code path skips needs_reconnect
 * defensively but they're still returned here for callers (e.g. UI)
 * that want to display the full set.
 */
export async function getAllNonDisconnectedConnections(
  userId: string,
): Promise<(typeof calendarConnections.$inferSelect)[]> {
  return await db.query.calendarConnections.findMany({
    where: and(
      eq(calendarConnections.userId, userId),
      inArray(calendarConnections.status, ["active", "needs_reconnect"] as const),
    ),
  });
}

/**
 * Wave C — pick the connection to USE for a booking write (create /
 * update / delete) on the CALENDAR side.
 *
 * Wave D — explicit restriction: only calendar-host providers (google,
 * microsoft) can be returned here. Zoom is meeting-only and is never
 * a viable target for calendar event CRUD; `pickMeetingProvider` below
 * handles the side-car meeting selection independently.
 *
 * Priority order:
 *   1. If the booking already has an externalEventProvider, honor it —
 *      this ensures a reschedule talks to the SAME provider that
 *      created the event originally, never accidentally switching
 *      providers mid-lifecycle.
 *   2. Otherwise prefer the provider matching the service's
 *      `videoProvider` hint where the hint corresponds to a calendar
 *      host (google_meet → google, teams → microsoft). `zoom` doesn't
 *      pin a calendar provider — falls through to step 3.
 *   3. Fall back to the first active CALENDAR-HOST connection found,
 *      preferring google for backward-compat with pre-Wave-C bookings.
 *
 * Returns null if the user has no usable active calendar connection.
 */
export async function pickConnectionForWrite(args: {
  userId: string;
  /** existing booking column — set on reschedule/cancel */
  existingProvider?: CalendarProvider | null;
  /** service-level video hint — set on create */
  videoProviderHint?: string | null;
}): Promise<typeof calendarConnections.$inferSelect | null> {
  // Honor existing provider locked-in by a prior create — but ignore
  // it if it's somehow zoom (would be a bug; zoom should never have
  // been written here in the first place).
  if (args.existingProvider && args.existingProvider !== "zoom") {
    return await getActiveConnection(args.userId, args.existingProvider);
  }
  // Resolve preferred CALENDAR provider from video hint. Zoom hint
  // doesn't pin a calendar — staff can use Zoom with EITHER Google or
  // Microsoft for the calendar event.
  let preferred: CalendarProvider | null = null;
  if (args.videoProviderHint === "google_meet") preferred = "google";
  else if (args.videoProviderHint === "teams") preferred = "microsoft";
  if (preferred) {
    const match = await getActiveConnection(args.userId, preferred);
    if (match && match.status === "active") return match;
  }
  // Fall back to ANY active CALENDAR-HOST connection. Zoom is
  // explicitly excluded.
  const google = await getActiveConnection(args.userId, "google");
  if (google && google.status === "active") return google;
  const microsoft = await getActiveConnection(args.userId, "microsoft");
  if (microsoft && microsoft.status === "active") return microsoft;
  return null;
}

/**
 * Wave D — pick the side-car MEETING provider for a booking.
 *
 * Today this only ever returns the user's Zoom connection (or null).
 * For Google Meet / Teams bookings the meeting URL is embedded in the
 * calendar event itself, so there's no side-car to dispatch — those
 * paths return null here and the orchestrator uses the calendar
 * provider's bundled videoConference flag instead.
 *
 *   • videoProviderHint = "zoom" → look up the user's active Zoom
 *     connection. Returns null if they don't have one (orchestrator
 *     falls back to "host will share the link" trust copy from
 *     Wave A).
 *   • Any other hint → null. Embedded meeting providers don't need
 *     a side-car.
 */
export async function pickMeetingProvider(args: {
  userId: string;
  videoProviderHint?: string | null;
}): Promise<typeof calendarConnections.$inferSelect | null> {
  if (args.videoProviderHint !== "zoom") return null;
  const zoom = await getActiveConnection(args.userId, "zoom");
  return zoom && zoom.status === "active" ? zoom : null;
}

/** Look up by tenant + connection id, with tenant-isolation enforced.
 *  Never returns a row that belongs to a different tenant. */
export async function getConnectionForTenant(
  tenantId: string,
  connectionId: string
): Promise<typeof calendarConnections.$inferSelect | null> {
  const row = await db.query.calendarConnections.findFirst({
    where: and(
      eq(calendarConnections.id, connectionId),
      eq(calendarConnections.tenantId, tenantId)
    ),
  });
  return row ?? null;
}

/** Mark a connection as needing reconnect (auth failure). Records the
 *  error message so the dashboard can show "Token revoked — reconnect".
 *
 *  Wave A: also triggers an at-most-once-per-24h email to the staff
 *  member so they learn about the broken connection before the next
 *  booking arrives. Email send is fire-and-forget; the state transition
 *  is the source of truth either way.
 */
export async function markNeedsReconnect(
  connectionId: string,
  message: string
): Promise<void> {
  await db
    .update(calendarConnections)
    .set({
      status: "needs_reconnect",
      lastError: message.slice(0, 500),
      lastErrorAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(calendarConnections.id, connectionId));

  // Fire-and-forget. Dedupe-aware (24h window via
  // last_reconnect_email_at). Never throws.
  void notifyReconnectRequired({
    connectionId,
    reason: message.slice(0, 200),
  });
}

/** Mark a connection as healthy. Used opportunistically after a
 *  successful sync — clears any stale error and resets the
 *  consecutive-failures counter (Wave A health foundation).
 */
export async function markActive(
  connectionId: string,
  accountEmail?: string | null
): Promise<void> {
  await db
    .update(calendarConnections)
    .set({
      status: "active",
      lastError: null,
      lastErrorAt: null,
      lastSyncedAt: new Date(),
      consecutiveFailures: 0,
      ...(accountEmail ? { accountEmail } : {}),
      updatedAt: new Date(),
    })
    .where(eq(calendarConnections.id, connectionId));
}

/** Increment the consecutive-failures counter on a connection.
 *  Used by runWithLog + getExternalBusyForUser when an attempt fails
 *  without being a permanent auth break. Future health-check cron
 *  will surface high counts as "degraded" before they break entirely.
 */
async function incrementFailureCount(connectionId: string): Promise<void> {
  await db
    .update(calendarConnections)
    .set({
      consecutiveFailures: sql`${calendarConnections.consecutiveFailures} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(calendarConnections.id, connectionId));
}

/** Soft-disconnect: status flips, refresh token is wiped so it can't be
 *  used even if the row is read by accident. Audit-trail row preserved. */
export async function disconnect(connectionId: string): Promise<void> {
  await db
    .update(calendarConnections)
    .set({
      status: "disconnected",
      refreshTokenEncrypted: "",
      accessTokenEncrypted: null,
      accessTokenExpiresAt: null,
      lastError: null,
      lastErrorAt: null,
      updatedAt: new Date(),
    })
    .where(eq(calendarConnections.id, connectionId));
}

/**
 * Upsert a Google connection after a successful OAuth exchange. If an
 * active or needs_reconnect row exists for this user+provider, it gets
 * updated in place; otherwise a fresh row is created. Tokens are
 * encrypted here — callers pass plaintext.
 *
 * Also clears legacy users.google_* columns of stale "expired" status so
 * the old IntegrationsClient stops nagging the user.
 */
export async function upsertGoogleConnection(args: {
  tenantId: string;
  userId: string;
  refreshTokenPlain: string;
  accessTokenPlain: string | null;
  accessTokenExpiresAt: Date | null;
  accountEmail: string | null;
  scopes: string[];
  calendarId?: string;
}): Promise<string> {
  const refreshEnc = encryptSecret(args.refreshTokenPlain)!;
  const accessEnc = encryptSecret(args.accessTokenPlain);

  const existing = await db.query.calendarConnections.findFirst({
    where: and(
      eq(calendarConnections.userId, args.userId),
      eq(calendarConnections.provider, "google")
    ),
  });

  let connectionId: string;
  if (existing) {
    await db
      .update(calendarConnections)
      .set({
        tenantId: args.tenantId, // re-affirm in case user moved tenants
        status: "active",
        refreshTokenEncrypted: refreshEnc,
        accessTokenEncrypted: accessEnc,
        accessTokenExpiresAt: args.accessTokenExpiresAt,
        accountEmail: args.accountEmail,
        scopes: args.scopes,
        calendarId: args.calendarId ?? existing.calendarId ?? "primary",
        lastError: null,
        lastErrorAt: null,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(calendarConnections.id, existing.id));
    connectionId = existing.id;
  } else {
    const [row] = await db
      .insert(calendarConnections)
      .values({
        tenantId: args.tenantId,
        userId: args.userId,
        provider: "google",
        status: "active",
        refreshTokenEncrypted: refreshEnc,
        accessTokenEncrypted: accessEnc,
        accessTokenExpiresAt: args.accessTokenExpiresAt,
        accountEmail: args.accountEmail,
        scopes: args.scopes,
        calendarId: args.calendarId ?? "primary",
        lastSyncedAt: new Date(),
      })
      .returning({ id: calendarConnections.id });
    connectionId = row.id;
  }

  // Wave A — stopped dual-writing the plaintext refresh token to
  // users.google_refresh_token. Reads of "is Google connected" now
  // flow through lib/calendar/connections.ts which queries the
  // encrypted source of truth (calendar_connections). Legacy
  // plaintext column is left in place but is NEVER written; migration
  // 0044 NULLs it for users with an active encrypted row, and a
  // future migration can drop the column entirely.

  await writeSyncLog({
    tenantId: args.tenantId,
    connectionId,
    userId: args.userId,
    provider: "google",
    kind: "connect",
    status: "ok",
  });

  // Wave E — subscribe to push channel fire-and-forget. The renewal
  // cron picks up any failure and retries; we don't make OAuth slower
  // for the success-path user. setImmediate so the OAuth callback
  // returns before the watch call begins.
  setImmediate(() => {
    subscribeConnectionWebhook(connectionId).catch((e) =>
      console.error("[calendar/sync] post-upsert subscribe failed:", e),
    );
  });

  return connectionId;
}

/**
 * Wave C — upsert a Microsoft connection after a successful OAuth
 * exchange. Same shape as `upsertGoogleConnection` so the callback
 * route can be a near-mirror; only the persisted `provider` value
 * and the absence of legacy-column dual-writes differ.
 *
 * Microsoft tokens require explicit accessTokenEncrypted caching
 * (Google's SDK manages this internally; for Graph we own it). So
 * we ALWAYS persist the access token alongside the refresh token —
 * the orchestrator's `getMicrosoftAccessToken` honors the cache to
 * skip refresh round-trips on the freebusy hot path.
 */
export async function upsertMicrosoftConnection(args: {
  tenantId: string;
  userId: string;
  refreshTokenPlain: string;
  accessTokenPlain: string | null;
  accessTokenExpiresAt: Date | null;
  accountEmail: string | null;
  scopes: string[];
  /** Microsoft's calendar identifier — we use the canonical "primary"
   *  alias which Graph resolves to the user's default calendar. */
  calendarId?: string;
}): Promise<string> {
  const refreshEnc = encryptSecret(args.refreshTokenPlain)!;
  const accessEnc = encryptSecret(args.accessTokenPlain);

  const existing = await db.query.calendarConnections.findFirst({
    where: and(
      eq(calendarConnections.userId, args.userId),
      eq(calendarConnections.provider, "microsoft"),
    ),
  });

  let connectionId: string;
  if (existing) {
    await db
      .update(calendarConnections)
      .set({
        tenantId: args.tenantId,
        status: "active",
        refreshTokenEncrypted: refreshEnc,
        accessTokenEncrypted: accessEnc,
        accessTokenExpiresAt: args.accessTokenExpiresAt,
        accountEmail: args.accountEmail,
        scopes: args.scopes,
        calendarId: args.calendarId ?? existing.calendarId ?? "primary",
        lastError: null,
        lastErrorAt: null,
        lastSyncedAt: new Date(),
        consecutiveFailures: 0,
        updatedAt: new Date(),
      })
      .where(eq(calendarConnections.id, existing.id));
    connectionId = existing.id;
  } else {
    const [row] = await db
      .insert(calendarConnections)
      .values({
        tenantId: args.tenantId,
        userId: args.userId,
        provider: "microsoft",
        status: "active",
        refreshTokenEncrypted: refreshEnc,
        accessTokenEncrypted: accessEnc,
        accessTokenExpiresAt: args.accessTokenExpiresAt,
        accountEmail: args.accountEmail,
        scopes: args.scopes,
        calendarId: args.calendarId ?? "primary",
        lastSyncedAt: new Date(),
      })
      .returning({ id: calendarConnections.id });
    connectionId = row.id;
  }

  await writeSyncLog({
    tenantId: args.tenantId,
    connectionId,
    userId: args.userId,
    provider: "microsoft",
    kind: "connect",
    status: "ok",
  });

  // Wave E — subscribe to Graph notifications fire-and-forget.
  setImmediate(() => {
    subscribeConnectionWebhook(connectionId).catch((e) =>
      console.error("[calendar/sync] post-upsert subscribe failed:", e),
    );
  });

  return connectionId;
}

/**
 * Wave D — upsert a Zoom connection after a successful OAuth exchange.
 * Same shape as the Google/Microsoft upserts; only the persisted
 * `provider` value and the absence of a calendarId concept differ
 * (Zoom doesn't have multiple calendars — meetings are owned by the
 * authenticated user).
 *
 * Like Microsoft, Zoom uses rolling refresh tokens so we ALWAYS
 * persist the access token + expiry on insert; the orchestrator's
 * `getZoomAccessToken` honors the cache to avoid an extra round-trip
 * to Zoom's token endpoint on every Zoom meeting CRUD call.
 */
export async function upsertZoomConnection(args: {
  tenantId: string;
  userId: string;
  refreshTokenPlain: string;
  accessTokenPlain: string | null;
  accessTokenExpiresAt: Date | null;
  accountEmail: string | null;
  scopes: string[];
}): Promise<string> {
  const refreshEnc = encryptSecret(args.refreshTokenPlain)!;
  const accessEnc = encryptSecret(args.accessTokenPlain);

  const existing = await db.query.calendarConnections.findFirst({
    where: and(
      eq(calendarConnections.userId, args.userId),
      eq(calendarConnections.provider, "zoom"),
    ),
  });

  let connectionId: string;
  if (existing) {
    await db
      .update(calendarConnections)
      .set({
        tenantId: args.tenantId,
        status: "active",
        refreshTokenEncrypted: refreshEnc,
        accessTokenEncrypted: accessEnc,
        accessTokenExpiresAt: args.accessTokenExpiresAt,
        accountEmail: args.accountEmail,
        scopes: args.scopes,
        // Zoom doesn't have a calendar id concept — we still need to
        // satisfy the NOT NULL constraint on the column, so set the
        // canonical "primary" string used by Google. It's not read
        // anywhere in the Zoom code path.
        calendarId: existing.calendarId ?? "primary",
        lastError: null,
        lastErrorAt: null,
        lastSyncedAt: new Date(),
        consecutiveFailures: 0,
        updatedAt: new Date(),
      })
      .where(eq(calendarConnections.id, existing.id));
    connectionId = existing.id;
  } else {
    const [row] = await db
      .insert(calendarConnections)
      .values({
        tenantId: args.tenantId,
        userId: args.userId,
        provider: "zoom",
        status: "active",
        refreshTokenEncrypted: refreshEnc,
        accessTokenEncrypted: accessEnc,
        accessTokenExpiresAt: args.accessTokenExpiresAt,
        accountEmail: args.accountEmail,
        scopes: args.scopes,
        calendarId: "primary",
        lastSyncedAt: new Date(),
      })
      .returning({ id: calendarConnections.id });
    connectionId = row.id;
  }

  await writeSyncLog({
    tenantId: args.tenantId,
    connectionId,
    userId: args.userId,
    provider: "zoom",
    kind: "connect",
    status: "ok",
  });

  return connectionId;
}

// ─── Booking lifecycle ─────────────────────────────────────────────────

export async function onBookingCreated(args: {
  booking: typeof bookings.$inferSelect;
  staff: User;
  serviceName: string;
  videoConference: boolean;
  /** Wave C — service-level video hint used to pick the provider.
   *  Optional for backward compat with callers that only set
   *  `videoConference`. */
  videoProviderHint?: string | null;
}): Promise<SyncResult> {
  // Wave D — pick the CALENDAR host (google or microsoft); zoom never
  // returned here. The result.provider will be whichever of those
  // owns the calendar event for this booking.
  const conn = await pickConnectionForWrite({
    userId: args.staff.id,
    videoProviderHint: args.videoProviderHint ?? null,
  });

  // Wave D — independently pick the SIDE-CAR meeting provider. Today
  // only Zoom, only when videoProviderHint === "zoom". Other video
  // hints embed the meeting URL in the calendar provider's API call,
  // so meetingConn is null for those.
  const meetingConn = await pickMeetingProvider({
    userId: args.staff.id,
    videoProviderHint: args.videoProviderHint ?? null,
  });

  // If neither a calendar host NOR a meeting side-car is available,
  // the orchestrator has nothing to do.
  if (!conn && !meetingConn) {
    return { status: "skipped", reason: "no_connection" };
  }

  // ── Side-car meeting first (Zoom) ──────────────────────────────
  // We create the Zoom meeting BEFORE the calendar event so the
  // calendar event description can include the Zoom join URL. If
  // the Zoom create fails, we still try to create the calendar
  // event without the URL — better to have a calendar event the
  // host can manually add a link to than no event at all.
  let meetingResult: { provider: CalendarProvider; eventId: string; meetLink: string | null } | null =
    null;
  if (meetingConn && args.videoConference) {
    try {
      const sideCarOp = async (): Promise<ExternalEventResult> => {
        const accessToken = await getZoomAccessToken(meetingConn);
        if (!accessToken) {
          await markNeedsReconnect(meetingConn.id, "Zoom token refresh failed");
          throw makeAuthError("token_refresh_failed");
        }
        return zoomCreateEvent({
          accessToken,
          draft: buildDraft({
            booking: args.booking,
            staff: args.staff,
            serviceName: args.serviceName,
            videoConference: true,
          }),
        });
      };
      const sideCar = await runWithLog({
        tenantId: args.booking.tenantId,
        connectionId: meetingConn.id,
        provider: "zoom",
        userId: args.staff.id,
        bookingId: args.booking.id,
        kind: "create",
        op: sideCarOp,
        // No onOk here — we persist meetingProvider* alongside the
        // calendar event id below in a single bookings.update.
      });
      if (sideCar.status === "ok" && sideCar.eventId) {
        meetingResult = {
          provider: "zoom",
          eventId: sideCar.eventId,
          meetLink: sideCar.meetLink ?? null,
        };
      }
    } catch (e) {
      // runWithLog never throws — defense in depth.
      console.error("[calendar/sync] zoom side-car create failed (non-fatal):", e);
    }
  }

  // ── Calendar event (existing path) ─────────────────────────────
  // If we have a meeting URL from the side-car, inject it into the
  // calendar event's description AND set videoConference=false so
  // the calendar provider doesn't auto-create its own Meet/Teams link
  // on top (which would give the customer two different URLs).
  if (!conn) {
    // No calendar host but Zoom succeeded: persist the meeting-only
    // state on the booking and return.
    if (meetingResult) {
      await db
        .update(bookings)
        .set({
          meetingProvider: meetingResult.provider,
          meetingProviderEventId: meetingResult.eventId,
          meetLink: meetingResult.meetLink,
        })
        .where(eq(bookings.id, args.booking.id));
      return {
        status: "ok",
        provider: meetingResult.provider,
        eventId: meetingResult.eventId,
        meetLink: meetingResult.meetLink,
      };
    }
    return { status: "skipped", reason: "no_connection" };
  }
  if (conn.status !== "active") {
    return { status: "skipped", reason: `connection_${conn.status}` };
  }
  const provider = conn.provider as CalendarProvider;

  const sideCarLink = meetingResult?.meetLink ?? null;
  const draft = buildDraft({
    booking: args.booking,
    staff: args.staff,
    serviceName: args.serviceName,
    // If a side-car meeting URL exists, the calendar provider must
    // NOT auto-create its own — that would double up. Otherwise
    // honor the caller's videoConference flag (Meet / Teams cases).
    videoConference: meetingResult ? false : args.videoConference,
    sideCarMeetingUrl: sideCarLink,
  });

  // Provider-specific call wrapped inside runWithLog so retries +
  // logging + status flip all behave identically across providers.
  const op = async (): Promise<ExternalEventResult> => {
    if (provider === "google") {
      const refreshToken = safeDecrypt(conn.refreshTokenEncrypted);
      if (!refreshToken) {
        await markNeedsReconnect(conn.id, "Stored credential could not be decrypted");
        throw makeAuthError("decrypt_failed");
      }
      return googleCreateEvent({
        refreshToken,
        calendarId: conn.calendarId,
        draft,
      });
    }
    // microsoft
    const accessToken = await getMicrosoftAccessToken(conn);
    if (!accessToken) {
      await markNeedsReconnect(conn.id, "Microsoft token refresh failed");
      throw makeAuthError("token_refresh_failed");
    }
    return microsoftCreateEvent({ accessToken, draft });
  };

  return await runWithLog({
    tenantId: args.booking.tenantId,
    connectionId: conn.id,
    provider,
    userId: args.staff.id,
    bookingId: args.booking.id,
    kind: "create",
    op,
    onOk: async (result) => {
      // Persist the provider event id on the booking so future updates
      // can target it. Wave D — also persist the side-car meeting ids
      // when present so reschedule/cancel can update/delete the Zoom
      // meeting independently of the calendar event.
      //
      // meetLink precedence: side-car Zoom URL wins if present;
      // otherwise the calendar provider's bundled Meet/Teams URL.
      const finalMeetLink = meetingResult?.meetLink ?? result.meetLink ?? null;
      await db
        .update(bookings)
        .set({
          googleEventId: provider === "google" ? result.eventId : null,
          externalEventId: result.eventId,
          externalEventProvider: provider,
          meetingProvider: meetingResult?.provider ?? null,
          meetingProviderEventId: meetingResult?.eventId ?? null,
          meetLink: finalMeetLink,
        })
        .where(eq(bookings.id, args.booking.id));
      await markActive(conn.id);
    },
  });
}

export async function onBookingRescheduled(args: {
  booking: typeof bookings.$inferSelect;
  staff: User;
  serviceName: string;
}): Promise<SyncResult> {
  // Wave C — reschedule must hit the SAME provider that created the
  // event. Honor externalEventProvider; fall back to "google" for
  // pre-Wave-C bookings where the column is null.
  const lockedProvider = (args.booking.externalEventProvider as CalendarProvider | null) ?? null;
  const conn = await pickConnectionForWrite({
    userId: args.staff.id,
    existingProvider: lockedProvider ?? "google",
  });
  // Wave D — side-car meeting update runs INDEPENDENTLY of the
  // calendar event update. A booking might have only a side-car
  // meeting (no calendar event), only a calendar event (no side-car),
  // or both. We try whichever applies.
  await updateSideCarMeeting(args);

  if (!conn) {
    // No calendar event to update — side-car update may have run
    // above. Report ok if there was a side-car meeting; skipped
    // otherwise.
    return args.booking.meetingProvider
      ? { status: "ok", provider: args.booking.meetingProvider as CalendarProvider, eventId: args.booking.meetingProviderEventId ?? "" }
      : { status: "skipped", reason: "no_connection" };
  }
  if (conn.status !== "active") {
    return { status: "skipped", reason: `connection_${conn.status}` };
  }
  const provider = conn.provider as CalendarProvider;

  // External event id may live in either column (legacy googleEventId
  // or new externalEventId). Try new first, fall back to legacy.
  const eventId = args.booking.externalEventId ?? args.booking.googleEventId;
  if (!eventId) {
    return { status: "skipped", reason: "no_external_event" };
  }

  const op = async (): Promise<ExternalEventResult> => {
    const summary = `${args.serviceName} with ${args.booking.clientName}`;
    if (provider === "google") {
      const refreshToken = safeDecrypt(conn.refreshTokenEncrypted);
      if (!refreshToken) {
        await markNeedsReconnect(conn.id, "Stored credential could not be decrypted");
        throw makeAuthError("decrypt_failed");
      }
      await googleUpdateEvent({
        refreshToken,
        calendarId: conn.calendarId,
        eventId,
        startAt: args.booking.startAt,
        endAt: args.booking.endAt,
        summary,
      });
      return { eventId, meetLink: null };
    }
    // microsoft — PATCH /me/events/{id}. Teams meeting URL stays
    // attached to the event server-side; we don't touch isOnlineMeeting.
    const accessToken = await getMicrosoftAccessToken(conn);
    if (!accessToken) {
      await markNeedsReconnect(conn.id, "Microsoft token refresh failed");
      throw makeAuthError("token_refresh_failed");
    }
    await microsoftUpdateEvent({
      accessToken,
      eventId,
      startAt: args.booking.startAt,
      endAt: args.booking.endAt,
      summary,
    });
    return { eventId, meetLink: null };
  };

  return await runWithLog({
    tenantId: args.booking.tenantId,
    connectionId: conn.id,
    provider,
    userId: args.staff.id,
    bookingId: args.booking.id,
    kind: "update",
    op,
    onOk: async () => {
      await markActive(conn.id);
    },
  });
}

/**
 * Wave D — update the side-car meeting (today: Zoom) when a booking
 * is rescheduled. Reads `meetingProvider` + `meetingProviderEventId`
 * off the booking row; if either is missing the booking has no
 * side-car, nothing to do.
 *
 * Never throws. The Zoom join URL is stable across PATCH so the
 * customer's existing email link keeps working — we only update the
 * start time + duration so the meeting card in the Zoom app reflects
 * the new schedule.
 */
async function updateSideCarMeeting(args: {
  booking: typeof bookings.$inferSelect;
  staff: User;
  serviceName: string;
}): Promise<void> {
  const meetingProvider = args.booking.meetingProvider as CalendarProvider | null;
  const meetingEventId = args.booking.meetingProviderEventId;
  if (!meetingProvider || !meetingEventId) return;
  if (meetingProvider !== "zoom") return; // only provider supported today

  const meetingConn = await getActiveConnection(args.staff.id, "zoom");
  if (!meetingConn || meetingConn.status !== "active") return;

  try {
    await runWithLog({
      tenantId: args.booking.tenantId,
      connectionId: meetingConn.id,
      provider: "zoom",
      userId: args.staff.id,
      bookingId: args.booking.id,
      kind: "update",
      op: async () => {
        const accessToken = await getZoomAccessToken(meetingConn);
        if (!accessToken) {
          await markNeedsReconnect(meetingConn.id, "Zoom token refresh failed");
          throw makeAuthError("token_refresh_failed");
        }
        await zoomUpdateEvent({
          accessToken,
          eventId: meetingEventId,
          startAt: args.booking.startAt,
          endAt: args.booking.endAt,
          summary: `${args.serviceName} with ${args.booking.clientName}`,
        });
        return { eventId: meetingEventId, meetLink: null };
      },
    });
  } catch (e) {
    console.error("[calendar/sync] zoom side-car update failed (non-fatal):", e);
  }
}

export async function onBookingCancelled(args: {
  booking: typeof bookings.$inferSelect;
  staff: User;
}): Promise<SyncResult> {
  // Wave D — delete the side-car meeting FIRST, then the calendar
  // event. Order doesn't strictly matter because both are idempotent
  // (404 = success), but doing side-car first means if the calendar
  // delete fails we've still cleaned up the Zoom resource and won't
  // leave a phantom meeting on the staff's Zoom dashboard.
  await deleteSideCarMeeting(args);

  // Same provider-locking logic as reschedule — cancel must talk to
  // the provider that owns the event.
  const lockedProvider = (args.booking.externalEventProvider as CalendarProvider | null) ?? null;
  const conn = await pickConnectionForWrite({
    userId: args.staff.id,
    existingProvider: lockedProvider ?? "google",
  });
  if (!conn) {
    return args.booking.meetingProvider
      ? { status: "ok", provider: args.booking.meetingProvider as CalendarProvider, eventId: args.booking.meetingProviderEventId ?? "" }
      : { status: "skipped", reason: "no_connection" };
  }
  if (conn.status !== "active") {
    return { status: "skipped", reason: `connection_${conn.status}` };
  }
  const provider = conn.provider as CalendarProvider;

  const eventId = args.booking.externalEventId ?? args.booking.googleEventId;
  if (!eventId) return { status: "skipped", reason: "no_external_event" };

  const op = async (): Promise<ExternalEventResult> => {
    if (provider === "google") {
      const refreshToken = safeDecrypt(conn.refreshTokenEncrypted);
      if (!refreshToken) {
        await markNeedsReconnect(conn.id, "Stored credential could not be decrypted");
        throw makeAuthError("decrypt_failed");
      }
      await googleDeleteEvent({
        refreshToken,
        calendarId: conn.calendarId,
        eventId,
      });
      return { eventId, meetLink: null };
    }
    const accessToken = await getMicrosoftAccessToken(conn);
    if (!accessToken) {
      await markNeedsReconnect(conn.id, "Microsoft token refresh failed");
      throw makeAuthError("token_refresh_failed");
    }
    await microsoftDeleteEvent({ accessToken, eventId });
    return { eventId, meetLink: null };
  };

  return await runWithLog({
    tenantId: args.booking.tenantId,
    connectionId: conn.id,
    provider,
    userId: args.staff.id,
    bookingId: args.booking.id,
    kind: "delete",
    op,
    onOk: async () => {
      // Clear the external id + side-car ids on the booking — both
      // resources are gone server-side. Keep meetLink for archival
      // (it's already invalid; clearing it would make historical
      // exports lose the original URL).
      await db
        .update(bookings)
        .set({
          googleEventId: null,
          externalEventId: null,
          externalEventProvider: null,
          meetingProvider: null,
          meetingProviderEventId: null,
        })
        .where(eq(bookings.id, args.booking.id));
      await markActive(conn.id);
    },
  });
}

/**
 * Wave D — delete the side-car meeting (today: Zoom) on cancel.
 * Symmetric to `updateSideCarMeeting`. 404 treated as success by the
 * Zoom adapter's deleteEvent — idempotent contract.
 *
 * Never throws. If Zoom delete fails we log + move on; the calendar
 * delete still runs and the user can clean up the phantom meeting
 * manually if needed.
 */
async function deleteSideCarMeeting(args: {
  booking: typeof bookings.$inferSelect;
  staff: User;
}): Promise<void> {
  const meetingProvider = args.booking.meetingProvider as CalendarProvider | null;
  const meetingEventId = args.booking.meetingProviderEventId;
  if (!meetingProvider || !meetingEventId) return;
  if (meetingProvider !== "zoom") return;

  const meetingConn = await getActiveConnection(args.staff.id, "zoom");
  if (!meetingConn || meetingConn.status !== "active") return;

  try {
    await runWithLog({
      tenantId: args.booking.tenantId,
      connectionId: meetingConn.id,
      provider: "zoom",
      userId: args.staff.id,
      bookingId: args.booking.id,
      kind: "delete",
      op: async () => {
        const accessToken = await getZoomAccessToken(meetingConn);
        if (!accessToken) {
          await markNeedsReconnect(meetingConn.id, "Zoom token refresh failed");
          throw makeAuthError("token_refresh_failed");
        }
        await zoomDeleteEvent({ accessToken, eventId: meetingEventId });
        return { eventId: meetingEventId, meetLink: null };
      },
    });
  } catch (e) {
    console.error("[calendar/sync] zoom side-car delete failed (non-fatal):", e);
  }
}

/**
 * Synthesize a fake "auth" error so the decrypt/refresh-failure paths
 * inside the `op` closures get classified consistently when they
 * bubble up to `runWithLog`. The orchestrator will still flip the
 * connection to needs_reconnect — these helpers above just trigger it
 * via the standard error-classification pipeline.
 */
function makeAuthError(reason: string): Error {
  const e = new Error(reason);
  (e as { status?: number }).status = 401;
  return e;
}

/**
 * Fetch external busy intervals for a user in a window.
 *
 * Wave C — aggregates busy time across ALL of the staff's active
 * provider connections. A staff member with both a Google and a
 * Microsoft account gets the UNION of their busy intervals subtracted
 * from bookable availability; we never let an event on one calendar
 * silently allow a double-book on the other.
 *
 * Used by lib/availability.ts to subtract conflicts before returning
 * available slots. Returns [] for users with no active connections or
 * when every provider fails — fallback behavior preserves pre-feature
 * availability rather than failing closed.
 *
 * Each provider runs INDEPENDENTLY: a freebusy failure on Microsoft
 * doesn't block Google's results and vice versa. Failures are logged
 * per-provider via writeSyncLog so admins can diagnose which side is
 * broken.
 */
export async function getExternalBusyForUser(
  userId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<BusyInterval[]> {
  // Only consider ACTIVE connections — a needs_reconnect connection
  // is by definition unable to fetch fresh busy data, and we don't
  // want to hammer the API just to log more failures.
  const conns = await db.query.calendarConnections.findMany({
    where: and(
      eq(calendarConnections.userId, userId),
      eq(calendarConnections.status, "active"),
    ),
  });
  if (conns.length === 0) return [];

  const results = await Promise.all(
    conns.map((conn) => readBusyForConnection(conn, windowStart, windowEnd)),
  );
  return results.flat();
}

/**
 * Read busy intervals from a single provider connection. Owns its own
 * retry loop + sync-log writes. Returns [] on failure (caller's fault
 * tolerance is "use whatever we can get, drop the rest").
 */
async function readBusyForConnection(
  conn: typeof calendarConnections.$inferSelect,
  windowStart: Date,
  windowEnd: Date,
  options?: { bypassCache?: boolean },
): Promise<BusyInterval[]> {
  const provider = conn.provider as CalendarProvider;

  // Wave D — Zoom has no freebusy API; skip silently. The staff
  // member's busy time comes from their calendar host (Google or
  // Microsoft), which is queried independently in the same Promise.all.
  if (provider === "zoom") return [];

  // Wave E — consult the cache before the provider. Pre-commit
  // revalidation passes `bypassCache: true` to force a fresh fetch.
  if (!options?.bypassCache) {
    const cached = await getCachedBusy({
      connectionId: conn.id,
      windowStart,
      windowEnd,
    });
    if (cached) return cached;
  }

  const startedAt = Date.now();
  let lastErr: unknown = null;
  let lastCls: ErrorClass = "unknown";
  let lastMsg = "";

  // Wave A retry budget on the freebusy hot path — tighter than
  // event-mutation retries because slot-grid latency is user-visible.
  for (let attempt = 0; attempt <= FREEBUSY_RETRY_DELAYS_MS.length; attempt++) {
    try {
      let busy: BusyInterval[];
      if (provider === "google") {
        const refreshToken = safeDecrypt(conn.refreshTokenEncrypted);
        if (!refreshToken) {
          await markNeedsReconnect(conn.id, "Stored credential could not be decrypted");
          return [];
        }
        busy = await googleGetBusy({
          refreshToken,
          calendarId: conn.calendarId,
          windowStart,
          windowEnd,
        });
      } else {
        // microsoft
        const accessToken = await getMicrosoftAccessToken(conn);
        if (!accessToken) {
          await markNeedsReconnect(conn.id, "Microsoft token refresh failed");
          return [];
        }
        busy = await microsoftGetBusy({
          accessToken,
          accountEmail: conn.accountEmail ?? "",
          windowStart,
          windowEnd,
        });
      }
      await writeSyncLog({
        tenantId: conn.tenantId,
        connectionId: conn.id,
        userId: conn.userId,
        provider,
        kind: "freebusy",
        status: "ok",
        latencyMs: Date.now() - startedAt,
        retryCount: attempt,
      });
      await markActive(conn.id);
      // Wave E — populate cache on every successful fetch. Skip when
      // the caller explicitly bypassed (pre-commit revalidation
      // doesn't want to poison the cache with a sub-window result).
      if (!options?.bypassCache) {
        void setCachedBusy({
          connectionId: conn.id,
          tenantId: conn.tenantId,
          userId: conn.userId,
          windowStart,
          windowEnd,
          busyIntervals: busy,
        });
      }
      return busy;
    } catch (err) {
      lastErr = err;
      lastCls = classifyError(provider, err);
      lastMsg = errorMessage(provider, err);
      const canRetry =
        RETRYABLE_CLASSES.includes(lastCls) && attempt < FREEBUSY_RETRY_DELAYS_MS.length;
      if (canRetry) {
        // Wave C.1 — honor Retry-After hints on freebusy too. Graph
        // throttles at the same tenant level whether we're reading or
        // writing, so respecting the hint here protects all callers
        // including the booking POST that fires later in the request.
        const delay = retryDelayForAttempt(lastCls, err, FREEBUSY_RETRY_DELAYS_MS[attempt]);
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  await writeSyncLog({
    tenantId: conn.tenantId,
    connectionId: conn.id,
    userId: conn.userId,
    provider,
    kind: "freebusy",
    status: "failed",
    errorClass: lastCls,
    errorMessage: lastMsg,
    latencyMs: Date.now() - startedAt,
    retryCount: FREEBUSY_RETRY_DELAYS_MS.length,
  });
  if (lastCls === "auth") {
    await markNeedsReconnect(conn.id, describeError(provider, lastErr));
  } else await incrementFailureCount(conn.id);
  void lastErr;
  return [];
}

// ─── Internals ─────────────────────────────────────────────────────────

function buildDraft(args: {
  booking: typeof bookings.$inferSelect;
  staff: User;
  serviceName: string;
  videoConference: boolean;
  /** Wave D — when set, the calendar event description gets a
   *  "Join: <url>" line so the staff member can click straight from
   *  their Outlook / Google Calendar entry. Passed for Zoom side-car
   *  bookings; null for Meet / Teams where the URL is embedded
   *  natively in the event. */
  sideCarMeetingUrl?: string | null;
}): ExternalEventDraft {
  const baseDescription = args.booking.notes ?? "";
  // Prepend the meeting URL to the description body — most calendar
  // apps render URLs as clickable links inside the description, and
  // putting it FIRST makes it visually unmissable.
  const description = args.sideCarMeetingUrl
    ? `Join: ${args.sideCarMeetingUrl}${baseDescription ? `\n\n${baseDescription}` : ""}`
    : baseDescription;
  return {
    summary: `${args.serviceName} with ${args.booking.clientName}`,
    description,
    startAt: args.booking.startAt,
    endAt: args.booking.endAt,
    organizerEmail: args.staff.email,
    organizerName: args.staff.name,
    attendeeEmail: args.booking.clientEmail,
    attendeeName: args.booking.clientName,
    videoConference: args.videoConference,
  };
}

function safeDecrypt(envelope: string | null | undefined): string | null {
  if (!envelope) return null;
  // Legacy backfill stored plaintext refresh tokens with no envelope —
  // those are explicitly marked 'needs_reconnect' in the migration and
  // should never reach this code path on an 'active' row, but guard
  // anyway. Real envelopes always start with the version prefix.
  if (!envelope.startsWith("v1:")) return null;
  try {
    return decryptSecret(envelope);
  } catch {
    return null;
  }
}

/**
 * Wraps a provider call with timing + sync-log insertion + retry +
 * automatic status flip on auth failure. NEVER throws.
 *
 * Wave A retry policy:
 *   - transient (5xx) and rate_limit (429): retried up to 3 times with
 *     exponential backoff (250ms / 1000ms / 2500ms). Idempotency keys
 *     and PATCH semantics make every retry safe.
 *   - auth (401/403): no retry; token won't fix itself. Flip status to
 *     needs_reconnect + fire dedupe-aware staff email.
 *   - not_found (404/410): no retry; idempotent success (delete/update
 *     on a deleted event already converges).
 *   - config / unknown: no retry; caller's bug or unexpected shape.
 *
 * The final retry count is recorded in the sync log so admins can
 * tell "succeeded after 2 retries" from "succeeded on first try."
 */
async function runWithLog(args: {
  tenantId: string;
  connectionId: string;
  /** Wave C — provider tag drives both the sync-log row's `provider`
   *  column AND which adapter's classifyError/errorMessage we use. */
  provider: CalendarProvider;
  userId: string;
  bookingId?: string;
  kind: SyncKind;
  op: () => Promise<ExternalEventResult>;
  onOk?: (result: ExternalEventResult) => Promise<void>;
}): Promise<SyncResult> {
  const startedAt = Date.now();
  let lastErr: unknown = null;
  let lastCls: ErrorClass = "unknown";
  let lastMsg = "";

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await args.op();
      await args.onOk?.(result);
      await writeSyncLog({
        tenantId: args.tenantId,
        connectionId: args.connectionId,
        userId: args.userId,
        bookingId: args.bookingId,
        provider: args.provider,
        kind: args.kind,
        status: "ok",
        externalEventId: result.eventId || undefined,
        latencyMs: Date.now() - startedAt,
        retryCount: attempt,
      });
      return {
        status: "ok",
        provider: args.provider,
        eventId: result.eventId,
        meetLink: result.meetLink,
      };
    } catch (err) {
      lastErr = err;
      lastCls = classifyError(args.provider, err);
      lastMsg = errorMessage(args.provider, err);

      // Retryable? If so, sleep then loop. Wave C.1 — honor any
      // server-supplied Retry-After hint on rate-limit failures.
      const canRetry =
        RETRYABLE_CLASSES.includes(lastCls) && attempt < RETRY_DELAYS_MS.length;
      if (canRetry) {
        const delay = retryDelayForAttempt(lastCls, err, RETRY_DELAYS_MS[attempt]);
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  // Final outcome path (failed or terminal-success-like not_found).
  await writeSyncLog({
    tenantId: args.tenantId,
    connectionId: args.connectionId,
    userId: args.userId,
    bookingId: args.bookingId,
    provider: args.provider,
    kind: args.kind,
    status: lastCls === "not_found" ? "ok" : "failed",
    errorClass: lastCls === "not_found" ? undefined : lastCls,
    errorMessage: lastCls === "not_found" ? undefined : lastMsg,
    latencyMs: Date.now() - startedAt,
    retryCount: RETRY_DELAYS_MS.length,
  });
  if (lastCls === "auth") {
    // Wave C.1 — pass the human-readable description (actionable copy
    // mined from AADSTS / Graph error codes) as the reconnect reason
    // so the dashboard banner + email body both communicate clearly.
    await markNeedsReconnect(args.connectionId, describeError(args.provider, lastErr));
  } else if (lastCls !== "not_found") {
    await incrementFailureCount(args.connectionId);
  }
  if (lastCls === "not_found") {
    return { status: "ok", provider: args.provider, eventId: "" };
  }
  void lastErr;
  return { status: "failed", errorClass: lastCls, message: lastMsg };
}

async function writeSyncLog(row: {
  tenantId: string;
  connectionId?: string | null;
  userId?: string | null;
  bookingId?: string | null;
  provider: CalendarProvider;
  kind: SyncKind;
  status: "ok" | "failed" | "skipped";
  errorClass?: ErrorClass;
  errorMessage?: string;
  externalEventId?: string;
  latencyMs?: number;
  /** Wave A — number of retries attempted before this outcome.
   *  0 = first-attempt success or single-attempt failure. */
  retryCount?: number;
}): Promise<void> {
  try {
    await db.insert(calendarSyncLogs).values({
      tenantId: row.tenantId,
      connectionId: row.connectionId ?? null,
      userId: row.userId ?? null,
      bookingId: row.bookingId ?? null,
      provider: row.provider,
      kind: row.kind,
      status: row.status,
      errorClass: row.errorClass ?? null,
      errorMessage: row.errorMessage ?? null,
      externalEventId: row.externalEventId ?? null,
      latencyMs: row.latencyMs ?? null,
      retryCount: row.retryCount ?? 0,
    });
  } catch (e) {
    // Never throw from sync logging — defense in depth.
    console.error("[calendar/sync] log insert failed:", e);
  }
}

// ─── Sync log readers (for admin UI) ───────────────────────────────────

export async function recentSyncLogs(args: {
  tenantId: string;
  connectionId?: string;
  limit?: number;
}): Promise<(typeof calendarSyncLogs.$inferSelect)[]> {
  const conds = [eq(calendarSyncLogs.tenantId, args.tenantId)];
  if (args.connectionId) conds.push(eq(calendarSyncLogs.connectionId, args.connectionId));
  return await db
    .select()
    .from(calendarSyncLogs)
    .where(and(...conds))
    .orderBy(desc(calendarSyncLogs.createdAt))
    .limit(args.limit ?? 50);
}

/**
 * Hide a no-longer-needed log row from the UI. Pure helper — no DB hit.
 * (Currently unused; reserved for future "dismiss" UI.)
 */
export function isLogStillRelevant(
  log: typeof calendarSyncLogs.$inferSelect,
  maxAgeDays = 30
): boolean {
  const ageMs = Date.now() - log.createdAt.getTime();
  return ageMs < maxAgeDays * 24 * 60 * 60 * 1000;
}

// Re-exports for callers that prefer a single import.
export { gte, lt }; // (used by future date-filter helpers)

// ─── Wave E — pre-commit revalidation ──────────────────────────────────
/**
 * `revalidateBeforeBooking` — closes the tiny race window between the
 * slot grid load (cached freebusy read) and the booking insert.
 *
 * Scenario it guards against:
 *   1. Customer loads the slot grid at T=0; cache says 2pm is free.
 *   2. Staff manually creates an event at 2pm in their Google Calendar
 *      at T=20s. Cache TTL hasn't expired yet.
 *   3. Customer clicks "Book 2pm" at T=30s.
 *   4. Without this guard, we'd insert the booking and only discover
 *      the conflict when the calendar sync hook tries to push the
 *      event minutes later.
 *
 * This function does ONE fresh provider freebusy read against a TIGHT
 * window (just the booking's start..end +/- 1 minute of slack) and
 * returns true if the slot is still free.
 *
 * Bounded behaviors:
 *   • Cache bypass so we always hit the provider.
 *   • Tight window — Graph/Google freebusy on a 2-minute window is
 *     fast (typically <300ms).
 *   • Bounded timeout (3s) — falls back to "permit booking" on
 *     timeout. Failing closed here would break booking flows during
 *     any provider hiccup; the existing post-insert calendar sync
 *     hook + Wave A reconnect emails are the catch-net.
 *   • Tolerates zero connections (returns true — no calendar host
 *     means no external busy to check).
 */
export type RevalidationResult =
  | { ok: true; reason?: "no_connections" | "no_conflict" }
  | { ok: false; reason: "conflict"; conflictWith?: BusyInterval };

export async function revalidateBeforeBooking(args: {
  userId: string;
  startAt: Date;
  endAt: Date;
  /** Optional override for the freshness timeout (ms). Default 3000. */
  timeoutMs?: number;
}): Promise<RevalidationResult> {
  const timeoutMs = args.timeoutMs ?? 3000;
  // Pull only ACTIVE calendar-host connections. Zoom doesn't have
  // freebusy and microsoft/google rows in needs_reconnect can't
  // produce fresh data; both are skipped via the same filter
  // getExternalBusyForUser uses.
  const conns = await db.query.calendarConnections.findMany({
    where: and(
      eq(calendarConnections.userId, args.userId),
      eq(calendarConnections.status, "active"),
    ),
  });
  if (conns.length === 0) {
    return { ok: true, reason: "no_connections" };
  }

  // Slack ±1 min on each side so we catch events that touch the
  // booking boundary even with a tiny clock skew.
  const slack = 60_000;
  const windowStart = new Date(args.startAt.getTime() - slack);
  const windowEnd = new Date(args.endAt.getTime() + slack);

  const work = Promise.all(
    conns
      .filter((c) => c.provider !== "zoom")
      .map((c) => readBusyForConnection(c, windowStart, windowEnd, { bypassCache: true })),
  );
  const timeout = new Promise<BusyInterval[][]>((resolve) =>
    setTimeout(() => resolve([]), timeoutMs),
  );

  // First-to-finish: actual work OR timeout. On timeout we got [] →
  // no busy → permit. Fail-OPEN by design (see docstring).
  const results = await Promise.race([work, timeout]);
  const allBusy = results.flat();

  // Strict overlap check: any busy interval that overlaps the booking
  // window at all is a conflict. Touching boundaries (end === start)
  // are NOT conflicts.
  for (const b of allBusy) {
    if (b.start.getTime() < args.endAt.getTime() && b.end.getTime() > args.startAt.getTime()) {
      return { ok: false, reason: "conflict", conflictWith: b };
    }
  }
  return { ok: true, reason: "no_conflict" };
}

// ─── Wave E — webhook subscription management ──────────────────────────
/**
 * Subscribe a connection to its provider's push channel. Idempotent:
 * if a row already exists in webhook_channels we leave it alone (the
 * renewal cron handles extension separately).
 *
 * Called fire-and-forget from upsertGoogle/MicrosoftConnection. Never
 * throws — a subscribe failure is logged and the renewal cron will
 * retry next pass.
 *
 * Zoom connections are skipped: Zoom doesn't have a calendar-changes
 * webhook for booking sync purposes.
 */
export async function subscribeConnectionWebhook(connectionId: string): Promise<void> {
  try {
    const conn = await db.query.calendarConnections.findFirst({
      where: eq(calendarConnections.id, connectionId),
    });
    if (!conn || conn.status !== "active") return;
    if (conn.provider !== "google" && conn.provider !== "microsoft") return;

    // Already subscribed? Leave the existing channel alone.
    const existing = await db.query.webhookChannels.findFirst({
      where: eq(webhookChannels.connectionId, connectionId),
    });
    if (existing && existing.expiresAt.getTime() > Date.now() + 6 * 60 * 60 * 1000) {
      return; // healthy channel with >6h left, no work needed
    }

    const appBase = (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
    const clientState = randomBytes(32).toString("hex");

    if (conn.provider === "google") {
      const refreshToken = safeDecrypt(conn.refreshTokenEncrypted);
      if (!refreshToken) return;
      const channelId = randomUUID();
      const res = await googleWatchCalendar({
        refreshToken,
        calendarId: conn.calendarId,
        address: `${appBase}/api/webhooks/google/calendar`,
        channelId,
        token: clientState,
      });
      // Stop any prior channel before storing the new one (fire-and-
      // forget cleanup — Google handles stale channel cleanup itself
      // after expiry, but stopping explicitly prevents duplicate
      // notifications during the overlap).
      if (existing) {
        void googleStopWatch({
          refreshToken,
          channelId: existing.externalChannelId,
          resourceId: existing.externalResourceId ?? "",
        }).catch(() => undefined);
        await db.delete(webhookChannels).where(eq(webhookChannels.id, existing.id));
      }
      await db.insert(webhookChannels).values({
        tenantId: conn.tenantId,
        connectionId: conn.id,
        userId: conn.userId,
        provider: "google",
        externalChannelId: res.channelId,
        externalResourceId: res.resourceId,
        clientState,
        expiresAt: res.expiresAt,
      });
    } else {
      // microsoft
      const accessToken = await getMicrosoftAccessToken(conn);
      if (!accessToken) return;
      const res = await microsoftSubscribeCalendar({
        accessToken,
        notificationUrl: `${appBase}/api/webhooks/microsoft/calendar`,
        clientState,
      });
      if (existing) {
        void microsoftUnsubscribe({
          accessToken,
          subscriptionId: existing.externalChannelId,
        }).catch(() => undefined);
        await db.delete(webhookChannels).where(eq(webhookChannels.id, existing.id));
      }
      await db.insert(webhookChannels).values({
        tenantId: conn.tenantId,
        connectionId: conn.id,
        userId: conn.userId,
        provider: "microsoft",
        externalChannelId: res.subscriptionId,
        externalResourceId: null,
        clientState,
        expiresAt: res.expiresAt,
      });
    }
  } catch (err) {
    // Best-effort. The renewal cron will pick up the failed state
    // on its next pass and retry.
    console.error("[calendar/sync] subscribeConnectionWebhook failed:", err);
  }
}

/**
 * Renew an existing channel. Used by the renewal cron when a channel
 * is within 6h of expiry.
 *   • Google: there's no extension API — we have to stop + watch again.
 *   • Microsoft: PATCH /subscriptions/{id} extends expirationDateTime
 *     in place, keeping the same id.
 */
export async function renewConnectionWebhook(channelId: string): Promise<boolean> {
  try {
    const channel = await db.query.webhookChannels.findFirst({
      where: eq(webhookChannels.id, channelId),
    });
    if (!channel) return false;
    const conn = await db.query.calendarConnections.findFirst({
      where: eq(calendarConnections.id, channel.connectionId),
    });
    if (!conn || conn.status !== "active") return false;

    if (channel.provider === "google") {
      // Stop + re-subscribe in one go via subscribeConnectionWebhook,
      // which handles the cleanup of the old row.
      await subscribeConnectionWebhook(channel.connectionId);
      return true;
    }
    // microsoft — extend in place
    const accessToken = await getMicrosoftAccessToken(conn);
    if (!accessToken) return false;
    const newExpiry = await microsoftRenewSubscription({
      accessToken,
      subscriptionId: channel.externalChannelId,
    });
    await db
      .update(webhookChannels)
      .set({ expiresAt: newExpiry, lastRenewedAt: new Date(), updatedAt: new Date() })
      .where(eq(webhookChannels.id, channel.id));
    return true;
  } catch (err) {
    console.error("[calendar/sync] renewConnectionWebhook failed:", err);
    return false;
  }
}

/**
 * Wave E observability — invalidate cache by connection id. Re-export
 * for callers (e.g. health endpoint) that want to force a refresh
 * without going through the webhook receiver.
 */
export { invalidateConnection as invalidateFreebusyCache };
