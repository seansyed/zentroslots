/**
 * Provider-agnostic calendar sync orchestrator.
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
import { and, desc, eq, gte, lt } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookings,
  calendarConnections,
  calendarSyncLogs,
  users,
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
 *  error message so the dashboard can show "Token revoked — reconnect". */
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
}

/** Mark a connection as healthy. Used opportunistically after a
 *  successful sync — clears any stale error. */
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
      ...(accountEmail ? { accountEmail } : {}),
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

  // Backwards-compat with legacy lib/google.ts which reads from users
  // columns. Keep both rails populated until that file is removed.
  await db
    .update(users)
    .set({
      googleRefreshToken: args.refreshTokenPlain, // legacy plaintext column
      googleCalendarId: args.calendarId ?? "primary",
      googleStatus: "connected",
      googleLastErrorAt: null,
    })
    .where(eq(users.id, args.userId));

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
    });
    await markActive(conn.id);
    return busy;
  } catch (err) {
    const cls = classifyError(err);
    const msg = errorMessage(err);
    await writeSyncLog({
      tenantId: conn.tenantId,
      connectionId: conn.id,
      userId,
      provider: "google",
      kind: "freebusy",
      status: "failed",
      errorClass: cls,
      errorMessage: msg,
      latencyMs: Date.now() - startedAt,
    });
    if (cls === "auth") await markNeedsReconnect(conn.id, msg);
    // Fall back to "no external busy" — better to allow a slot that
    // turns out to be double-booked (rare, manual reschedule available)
    // than to fail closed on a transient freebusy error and refuse
    // every booking.
    return [];
  }
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
 * Wraps a provider call with timing + sync-log insertion + automatic
 * status flip on auth failure. NEVER throws.
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
    });
    return {
      status: "ok",
      provider: "google",
      eventId: result.eventId,
      meetLink: result.meetLink,
    };
  } catch (err) {
    const cls = classifyError(err);
    const msg = errorMessage(err);
    await writeSyncLog({
      tenantId: args.tenantId,
      connectionId: args.connectionId,
      userId: args.userId,
      bookingId: args.bookingId,
      provider: "google",
      kind: args.kind,
      status: cls === "not_found" ? "ok" : "failed",
      errorClass: cls === "not_found" ? undefined : cls,
      errorMessage: cls === "not_found" ? undefined : msg,
      latencyMs: Date.now() - startedAt,
    });
    if (cls === "auth") {
      await markNeedsReconnect(args.connectionId, msg);
    }
    if (cls === "not_found") {
      // For delete: success. For update: the orchestrator caller decides
      // whether to recreate (currently no — we just log).
      return { status: "ok", provider: "google", eventId: "" };
    }
    return { status: "failed", errorClass: cls, message: msg };
  }
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
