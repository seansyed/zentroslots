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
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookings,
  calendarConnections,
  calendarSyncLogs,
  type User,
} from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

import {
  type BusyInterval,
  type CalendarProvider,
  type ErrorClass,
  type ExternalEventDraft,
  type ExternalEventResult,
  type SyncKind,
} from "./types";
import {
  classifyError,
  createEvent as googleCreateEvent,
  deleteEvent as googleDeleteEvent,
  errorMessage,
  getBusy as googleGetBusy,
  updateEvent as googleUpdateEvent,
} from "./google";
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

  return connectionId;
}

// ─── Booking lifecycle ─────────────────────────────────────────────────

export async function onBookingCreated(args: {
  booking: typeof bookings.$inferSelect;
  staff: User;
  serviceName: string;
  videoConference: boolean;
}): Promise<SyncResult> {
  const conn = await getActiveConnection(args.staff.id, "google");
  if (!conn || conn.status !== "active") {
    return { status: "skipped", reason: conn ? `connection_${conn.status}` : "no_connection" };
  }

  const refreshToken = safeDecrypt(conn.refreshTokenEncrypted);
  if (!refreshToken) {
    // Legacy plaintext or malformed envelope — flip to reconnect.
    await markNeedsReconnect(conn.id, "Stored credential could not be decrypted");
    await writeSyncLog({
      tenantId: args.booking.tenantId, connectionId: conn.id, userId: args.staff.id,
      bookingId: args.booking.id, provider: "google", kind: "create",
      status: "failed", errorClass: "auth", errorMessage: "decrypt_failed",
    });
    return { status: "failed", errorClass: "auth", message: "decrypt_failed" };
  }

  const draft = buildDraft({
    booking: args.booking,
    staff: args.staff,
    serviceName: args.serviceName,
    videoConference: args.videoConference,
  });

  return await runWithLog({
    tenantId: args.booking.tenantId,
    connectionId: conn.id,
    userId: args.staff.id,
    bookingId: args.booking.id,
    kind: "create",
    op: () =>
      googleCreateEvent({
        refreshToken,
        calendarId: conn.calendarId,
        draft,
      }),
    onOk: async (result) => {
      // Persist the provider event id on the booking so future updates
      // can target it. Keep googleEventId populated for backward compat.
      await db
        .update(bookings)
        .set({
          googleEventId: result.eventId,
          externalEventId: result.eventId,
          externalEventProvider: "google",
          meetLink: result.meetLink,
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
  const conn = await getActiveConnection(args.staff.id, "google");
  if (!conn || conn.status !== "active") {
    return { status: "skipped", reason: conn ? `connection_${conn.status}` : "no_connection" };
  }

  // External event id may live in either column (legacy googleEventId
  // or new externalEventId). Try new first, fall back to legacy.
  const eventId = args.booking.externalEventId ?? args.booking.googleEventId;
  if (!eventId) {
    return { status: "skipped", reason: "no_external_event" };
  }

  const refreshToken = safeDecrypt(conn.refreshTokenEncrypted);
  if (!refreshToken) {
    await markNeedsReconnect(conn.id, "Stored credential could not be decrypted");
    return { status: "failed", errorClass: "auth", message: "decrypt_failed" };
  }

  return await runWithLog({
    tenantId: args.booking.tenantId,
    connectionId: conn.id,
    userId: args.staff.id,
    bookingId: args.booking.id,
    kind: "update",
    op: async () => {
      await googleUpdateEvent({
        refreshToken,
        calendarId: conn.calendarId,
        eventId,
        startAt: args.booking.startAt,
        endAt: args.booking.endAt,
        summary: `${args.serviceName} with ${args.booking.clientName}`,
      });
      return { eventId, meetLink: null } satisfies ExternalEventResult;
    },
    onOk: async () => {
      await markActive(conn.id);
    },
  });
}

export async function onBookingCancelled(args: {
  booking: typeof bookings.$inferSelect;
  staff: User;
}): Promise<SyncResult> {
  const conn = await getActiveConnection(args.staff.id, "google");
  if (!conn || conn.status !== "active") {
    return { status: "skipped", reason: conn ? `connection_${conn.status}` : "no_connection" };
  }

  const eventId = args.booking.externalEventId ?? args.booking.googleEventId;
  if (!eventId) return { status: "skipped", reason: "no_external_event" };

  const refreshToken = safeDecrypt(conn.refreshTokenEncrypted);
  if (!refreshToken) {
    await markNeedsReconnect(conn.id, "Stored credential could not be decrypted");
    return { status: "failed", errorClass: "auth", message: "decrypt_failed" };
  }

  return await runWithLog({
    tenantId: args.booking.tenantId,
    connectionId: conn.id,
    userId: args.staff.id,
    bookingId: args.booking.id,
    kind: "delete",
    op: async () => {
      await googleDeleteEvent({
        refreshToken,
        calendarId: conn.calendarId,
        eventId,
      });
      return { eventId, meetLink: null } satisfies ExternalEventResult;
    },
    onOk: async () => {
      // Clear the external id on the booking — it's gone server-side.
      await db
        .update(bookings)
        .set({
          googleEventId: null,
          externalEventId: null,
          externalEventProvider: null,
        })
        .where(eq(bookings.id, args.booking.id));
      await markActive(conn.id);
    },
  });
}

/**
 * Fetch external busy intervals for a user in a window. Used by
 * lib/availability.ts to subtract conflicting slots before returning
 * availability. Returns [] for users with no active connection or on
 * any error — fallback behavior preserves pre-feature availability.
 */
export async function getExternalBusyForUser(
  userId: string,
  windowStart: Date,
  windowEnd: Date
): Promise<BusyInterval[]> {
  const conn = await getActiveConnection(userId, "google");
  if (!conn || conn.status !== "active") return [];

  const refreshToken = safeDecrypt(conn.refreshTokenEncrypted);
  if (!refreshToken) {
    await markNeedsReconnect(conn.id, "Stored credential could not be decrypted");
    return [];
  }

  const startedAt = Date.now();
  let lastErr: unknown = null;
  let lastCls: ErrorClass = "unknown";
  let lastMsg = "";

  // Wave A — retry transient/rate-limit failures on freebusy. Tighter
  // budget than event-mutating calls because freebusy sits in the slot-
  // computation hot path; we'd rather show "no external busy" than
  // make the customer wait 4+ seconds for the slot grid to load.
  for (let attempt = 0; attempt <= FREEBUSY_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const busy = await googleGetBusy({
        refreshToken,
        calendarId: conn.calendarId,
        windowStart,
        windowEnd,
      });
      await writeSyncLog({
        tenantId: conn.tenantId,
        connectionId: conn.id,
        userId,
        provider: "google",
        kind: "freebusy",
        status: "ok",
        latencyMs: Date.now() - startedAt,
        retryCount: attempt,
      });
      await markActive(conn.id);
      return busy;
    } catch (err) {
      lastErr = err;
      lastCls = classifyError(err);
      lastMsg = errorMessage(err);
      const canRetry =
        RETRYABLE_CLASSES.includes(lastCls) && attempt < FREEBUSY_RETRY_DELAYS_MS.length;
      if (canRetry) {
        await sleep(FREEBUSY_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      break;
    }
  }

  await writeSyncLog({
    tenantId: conn.tenantId,
    connectionId: conn.id,
    userId,
    provider: "google",
    kind: "freebusy",
    status: "failed",
    errorClass: lastCls,
    errorMessage: lastMsg,
    latencyMs: Date.now() - startedAt,
    retryCount: FREEBUSY_RETRY_DELAYS_MS.length,
  });
  if (lastCls === "auth") await markNeedsReconnect(conn.id, lastMsg);
  else await incrementFailureCount(conn.id);
  void lastErr;

  // Fall back to "no external busy" — better to allow a slot that
  // turns out to be double-booked (rare, manual reschedule available)
  // than to fail closed on a transient freebusy error and refuse
  // every booking.
  return [];
}

// ─── Internals ─────────────────────────────────────────────────────────

function buildDraft(args: {
  booking: typeof bookings.$inferSelect;
  staff: User;
  serviceName: string;
  videoConference: boolean;
}): ExternalEventDraft {
  return {
    summary: `${args.serviceName} with ${args.booking.clientName}`,
    description: args.booking.notes ?? "",
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
        provider: "google",
        kind: args.kind,
        status: "ok",
        externalEventId: result.eventId || undefined,
        latencyMs: Date.now() - startedAt,
        retryCount: attempt,
      });
      return {
        status: "ok",
        provider: "google",
        eventId: result.eventId,
        meetLink: result.meetLink,
      };
    } catch (err) {
      lastErr = err;
      lastCls = classifyError(err);
      lastMsg = errorMessage(err);

      // Retryable? If so, sleep then loop.
      const canRetry =
        RETRYABLE_CLASSES.includes(lastCls) && attempt < RETRY_DELAYS_MS.length;
      if (canRetry) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      // No retry — break out and log the final outcome below.
      break;
    }
  }

  // Final outcome path (failed or terminal-success-like not_found).
  await writeSyncLog({
    tenantId: args.tenantId,
    connectionId: args.connectionId,
    userId: args.userId,
    bookingId: args.bookingId,
    provider: "google",
    kind: args.kind,
    status: lastCls === "not_found" ? "ok" : "failed",
    errorClass: lastCls === "not_found" ? undefined : lastCls,
    errorMessage: lastCls === "not_found" ? undefined : lastMsg,
    latencyMs: Date.now() - startedAt,
    retryCount: RETRY_DELAYS_MS.length, // exhausted retries
  });
  if (lastCls === "auth") {
    await markNeedsReconnect(args.connectionId, lastMsg);
  } else if (lastCls !== "not_found") {
    // Transient/rate-limit exhausted, or unknown/config — bump the
    // consecutive-failures counter so a future health-check cron can
    // surface a degraded connection before it breaks outright.
    await incrementFailureCount(args.connectionId);
  }
  if (lastCls === "not_found") {
    return { status: "ok", provider: "google", eventId: "" };
  }
  // Type-narrow lastErr usage (it's tracked for symmetry / future logging)
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
