/**
 * Calendar-event external sync orchestrator (Phase 17I).
 *
 * Sibling to lib/calendar/sync.ts. That module is owned by the public
 * booking lifecycle (create/reschedule/cancel of customer-facing
 * bookings) and is a stable hot path. THIS module handles external
 * calendar sync for the new `calendar_events` table — blocked time
 * and internal meetings — which has fundamentally different shape:
 *
 *   • Multi-attendee semantics (internal meetings can include several
 *     staff members; booking lifecycle only has organizer + customer).
 *   • No customer email field (these events never surface to clients).
 *   • Optional video provider with the organizer's own connection
 *     (no side-car selection — Zoom is excluded for v1).
 *
 * Trying to retrofit the booking ExternalEventDraft shape (single
 * attendeeEmail / attendeeName) would either lose attendees or force
 * a riskier breaking change to the booking sync adapters. A sibling
 * module that calls Google/Microsoft directly is additive and keeps
 * the booking path byte-identical.
 *
 * Reuse:
 *   • `pickConnectionForWrite` — connection picker (organizer's
 *     calendar host: google / microsoft only). Wave D's zoom-as-
 *     side-car never applies here.
 *   • `getMicrosoftAccessToken` — exported from sync.ts (Phase 17I
 *     one-line additive export) so we share the rolling-refresh
 *     token cache.
 *
 * Failure model:
 *   • NEVER throws to the caller. Returns a structured SyncResult.
 *   • Token-refresh failures flip the connection to needs_reconnect
 *     (same behavior as the booking path; reuses markNeedsReconnect).
 *   • No retry policy in v1 — the caller fires-and-forgets, and if
 *     a transient blip drops the sync the organizer can recreate the
 *     event on their calendar manually. Future hardening can lift
 *     sync.ts's runWithLog pattern here.
 */

import { google } from "googleapis";

import { calendarConnections, type User } from "@/db/schema";
import {
  getActiveConnection,
  getMicrosoftAccessToken,
  getZoomAccessToken,
  markActive,
  markNeedsReconnect,
  pickConnectionForWrite,
} from "./sync";
import { createEvent as zoomCreateEvent } from "./zoom";
import { decryptSecret } from "@/lib/crypto";
import type { CalendarProvider } from "./types";

// ─── Public types ──────────────────────────────────────────────────────

export type CalendarEventSyncResult =
  | {
      status: "ok";
      provider: CalendarProvider;
      externalEventId: string;
      meetLink: string | null;
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; message: string };

export type CalendarEventForSync = {
  /** Application-side event row id, used only for logging context. */
  id: string;
  eventType: "blocked_time" | "internal_meeting";
  title: string;
  startAt: Date;
  endAt: Date;
  notes: string | null;
  location: string | null;
  /** Optional video provider. google_meet + teams are embedded in the
   *  calendar provider's create call; zoom uses a side-car create
   *  (same pattern as the booking lifecycle in lib/calendar/sync.ts)
   *  so the join URL ends up in the event description. */
  videoProvider: "google_meet" | "teams" | "zoom" | null;
  /** Whether the external calendar should notify attendees on create.
   *  Only meaningful for internal_meeting; ignored for blocked_time
   *  (which has no attendees by definition). */
  sendNotifications: boolean;
};

// ─── Helpers ───────────────────────────────────────────────────────────

/** Mirror of lib/calendar/sync.ts safeDecrypt — guards against the
 *  legacy non-versioned envelopes that never made it past the Wave A
 *  migration. Local copy keeps the sibling module fully self-contained.
 */
function safeDecrypt(envelope: string | null | undefined): string | null {
  if (!envelope) return null;
  if (!envelope.startsWith("v1:")) return null;
  try {
    return decryptSecret(envelope);
  } catch {
    return null;
  }
}

/** Build the calendar event description body shared by both providers.
 *  Optional sideCarUrl is prepended (Zoom side-car path) so the join
 *  link is the first thing the staff sees on their Outlook / Google
 *  Calendar entry. */
function buildDescription(args: {
  event: CalendarEventForSync;
  organizer: User;
  sideCarUrl?: string | null;
}): string {
  const lines: string[] = [];
  if (args.sideCarUrl) {
    lines.push(`Join: ${args.sideCarUrl}`);
    lines.push("");
  }
  if (args.event.notes && args.event.notes.trim().length > 0) {
    lines.push(args.event.notes.trim());
  }
  // Closing footer makes it obvious in the staff's external calendar
  // that this entry came from ZentroMeet operations (vs a personal
  // event they created in Outlook directly). Lowercase, single line,
  // no link — keeps the event card compact.
  lines.push("");
  lines.push(`— ZentroMeet ${args.event.eventType.replace("_", " ")}`);
  return lines.join("\n");
}

// ─── Zoom side-car ─────────────────────────────────────────────────────

/** When the organizer picks Zoom for an internal meeting, we create
 *  the Zoom meeting BEFORE the calendar event so the calendar event's
 *  description can include the join URL. Mirror of the Wave D side-car
 *  pattern in lib/calendar/sync.ts onBookingCreated. NEVER throws — if
 *  Zoom fails the calendar event is still created (just without a URL,
 *  which the staff can paste in manually). */
async function createZoomSideCar(args: {
  userId: string;
  event: CalendarEventForSync;
  organizer: User;
}): Promise<{ meetingId: string; joinUrl: string | null } | null> {
  const zoomConn = await getActiveConnection(args.userId, "zoom");
  if (!zoomConn || zoomConn.status !== "active") return null;
  try {
    const accessToken = await getZoomAccessToken(zoomConn);
    if (!accessToken) {
      await markNeedsReconnect(zoomConn.id, "Zoom token refresh failed");
      return null;
    }
    const result = await zoomCreateEvent({
      accessToken,
      // Zoom adapter expects a booking-shaped draft. We re-use the
      // shape with the organizer as the sole attendee since Zoom's
      // meeting body doesn't care about the attendee list (Zoom
      // identifies participants by who joins, not by invite list).
      draft: {
        summary: args.event.title,
        description: args.event.notes ?? "",
        startAt: args.event.startAt,
        endAt: args.event.endAt,
        organizerEmail: args.organizer.email,
        organizerName: args.organizer.name,
        attendeeEmail: args.organizer.email,
        attendeeName: args.organizer.name,
        videoConference: true,
      },
    });
    await markActive(zoomConn.id).catch(() => undefined);
    return {
      meetingId: result.eventId,
      joinUrl: result.meetLink,
    };
  } catch (e) {
    console.error(
      `[calendar-events] zoom side-car failed (event=${args.event.id}):`,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

// ─── Google ────────────────────────────────────────────────────────────

async function createOnGoogle(args: {
  conn: typeof calendarConnections.$inferSelect;
  event: CalendarEventForSync;
  organizer: User;
  attendees: User[];
  /** Set when Zoom side-car succeeded — its join URL is baked into
   *  the description so the staff click-through works directly from
   *  their calendar entry. */
  sideCarUrl: string | null;
}): Promise<{ externalEventId: string; meetLink: string | null }> {
  const refreshToken = safeDecrypt(args.conn.refreshTokenEncrypted);
  if (!refreshToken) {
    await markNeedsReconnect(
      args.conn.id,
      "Stored credential could not be decrypted",
    );
    throw new Error("google: decrypt_failed");
  }

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } =
    process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("google: oauth env missing");
  }
  const client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
  );
  client.setCredentials({ refresh_token: refreshToken });
  const cal = google.calendar({ version: "v3", auth: client });

  // Bundled Meet only when google_meet is selected. If Zoom side-car
  // already produced a join URL we MUST NOT also create a Meet — the
  // event would carry two competing meeting links.
  const wantsBundledMeet = args.event.videoProvider === "google_meet" && !args.sideCarUrl;
  const requestId = `cev-${args.event.id}-${args.event.startAt.getTime()}`;

  // Attendees list: organizer FIRST (so Google attaches it as a
  // self-invite for the staff calendar), then the additional internal
  // meeting attendees. Blocked time → attendees array is just the
  // organizer (so the event sits cleanly on their own calendar with no
  // "needs response" prompts to anyone else).
  const attendees = [
    { email: args.organizer.email, displayName: args.organizer.name, responseStatus: "accepted" as const },
    ...args.attendees
      .filter((u) => u.id !== args.organizer.id)
      .map((u) => ({ email: u.email, displayName: u.name })),
  ];

  // Blocked time has no real attendees beyond the organizer — never
  // notify on a personal block. Internal meetings honor the toggle.
  const sendUpdates: "all" | "none" =
    args.event.eventType === "internal_meeting" && args.event.sendNotifications
      ? "all"
      : "none";

  const res = await cal.events.insert({
    calendarId: args.conn.calendarId || "primary",
    conferenceDataVersion: wantsBundledMeet ? 1 : 0,
    sendUpdates,
    requestBody: {
      summary: args.event.title,
      description: buildDescription({
        event: args.event,
        organizer: args.organizer,
        sideCarUrl: args.sideCarUrl,
      }),
      location: args.event.location ?? undefined,
      start: { dateTime: args.event.startAt.toISOString(), timeZone: "UTC" },
      end: { dateTime: args.event.endAt.toISOString(), timeZone: "UTC" },
      attendees,
      conferenceData: wantsBundledMeet
        ? {
            createRequest: {
              requestId,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          }
        : undefined,
      transparency: "opaque",
    },
  });

  return {
    externalEventId: res.data.id ?? "",
    meetLink: args.sideCarUrl ?? res.data.hangoutLink ?? null,
  };
}

// ─── Microsoft ─────────────────────────────────────────────────────────

async function createOnMicrosoft(args: {
  conn: typeof calendarConnections.$inferSelect;
  event: CalendarEventForSync;
  organizer: User;
  attendees: User[];
  /** Zoom side-car URL, when present. We must NOT also flip
   *  isOnlineMeeting in that case — the event would have two
   *  competing join URLs. */
  sideCarUrl: string | null;
}): Promise<{ externalEventId: string; meetLink: string | null }> {
  const accessToken = await getMicrosoftAccessToken(args.conn);
  if (!accessToken) {
    await markNeedsReconnect(args.conn.id, "Microsoft token refresh failed");
    throw new Error("microsoft: token_refresh_failed");
  }

  // Embedded Teams only when teams is selected AND there's no Zoom
  // side-car URL already taking that role.
  const wantsTeams = args.event.videoProvider === "teams" && !args.sideCarUrl;

  // Attendees: Graph wants `{ emailAddress: { address, name }, type }`.
  // Organizer goes implicitly via the connection identity — we don't
  // re-add them. Internal meeting attendees become Required attendees.
  const attendees = args.attendees
    .filter((u) => u.id !== args.organizer.id)
    .map((u) => ({
      emailAddress: { address: u.email, name: u.name },
      type: "required",
    }));

  const body: Record<string, unknown> = {
    subject: args.event.title,
    body: {
      contentType: "text",
      content: buildDescription({
        event: args.event,
        organizer: args.organizer,
        sideCarUrl: args.sideCarUrl,
      }),
    },
    start: {
      dateTime: args.event.startAt.toISOString(),
      timeZone: "UTC",
    },
    end: {
      dateTime: args.event.endAt.toISOString(),
      timeZone: "UTC",
    },
    attendees,
    // Show the slot as "Busy" on the organizer's calendar — applies to
    // both event types so freebusy lookups (from other tools polling
    // the staff's Outlook) correctly treat the block as unavailable.
    showAs: "busy",
    // Internal meetings honor the toggle; blocked time always silent
    // (Outlook would otherwise prompt every attendee — but blocked
    // time has none, so this is mostly defensive). false suppresses
    // the response-tracking UI prompt on each attendee's invite.
    responseRequested:
      args.event.eventType === "internal_meeting" ? args.event.sendNotifications : false,
  };
  if (args.event.location) {
    body.location = { displayName: args.event.location };
  }
  if (wantsTeams) {
    body.isOnlineMeeting = true;
    body.onlineMeetingProvider = "teamsForBusiness";
  }

  const res = await fetch("https://graph.microsoft.com/v1.0/me/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`microsoft: ${res.status} ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    id?: string;
    onlineMeeting?: { joinUrl?: string };
    onlineMeetingUrl?: string;
  };
  const teamsJoinUrl = json?.onlineMeeting?.joinUrl ?? json?.onlineMeetingUrl ?? null;

  return {
    externalEventId: json?.id ?? "",
    meetLink: args.sideCarUrl ?? (wantsTeams ? teamsJoinUrl : null),
  };
}

// ─── Public surface ────────────────────────────────────────────────────

/**
 * Push a calendar_events row to the organizer's external calendar
 * (Google or Microsoft). NEVER throws. Returns a structured result
 * the caller persists onto the row.
 *
 * Behavior matrix:
 *   • No active calendar host connection → skipped("no_connection")
 *   • Connection in needs_reconnect → skipped("connection_<status>")
 *   • Provider call succeeds → ok + externalEventId (+ meetLink if
 *                              videoProvider was set and provider
 *                              returned one)
 *   • Provider call fails → failed (with error class+message logged
 *                            to pm2 stderr; row is NOT updated)
 *
 * The organizer's videoProvider hint must match the connection's
 * provider (google_meet ↔ google, teams ↔ microsoft) for video to
 * actually generate. If they mismatch, the event still creates on
 * the calendar but without a meeting link.
 */
export async function onCalendarEventCreated(args: {
  event: CalendarEventForSync;
  organizer: User;
  /** Other staff invited to an internal_meeting. Empty for blocked_time.
   *  Organizer should NOT be in this list (we filter regardless). */
  attendees: User[];
}): Promise<CalendarEventSyncResult> {
  // ── Zoom side-car (optional, runs before the calendar event) ───
  // Same Wave D pattern as the booking lifecycle: if the organizer
  // picked Zoom, create the meeting first so the calendar event's
  // description can include the join URL. Failure is non-fatal —
  // the calendar event still gets created, just without the URL.
  let sideCarMeetingId: string | null = null;
  let sideCarUrl: string | null = null;
  if (args.event.videoProvider === "zoom") {
    const zoom = await createZoomSideCar({
      userId: args.organizer.id,
      event: args.event,
      organizer: args.organizer,
    });
    if (zoom) {
      sideCarMeetingId = zoom.meetingId;
      sideCarUrl = zoom.joinUrl;
    }
  }

  // ── Pick the calendar host connection ──────────────────────────
  const conn = await pickConnectionForWrite({
    userId: args.organizer.id,
    // The hint only steers between google and microsoft. Zoom never
    // hosts a calendar event, so when the user picked zoom we leave
    // the hint null and pickConnectionForWrite falls back to whatever
    // calendar host the organizer has connected.
    videoProviderHint:
      args.event.videoProvider === "google_meet"
        ? "google_meet"
        : args.event.videoProvider === "teams"
        ? "teams"
        : null,
  });

  if (!conn) {
    // No calendar host: if Zoom side-car succeeded we still consider
    // the operation a soft-ok (the meeting exists, just no calendar
    // event). Otherwise nothing happened.
    if (sideCarUrl) {
      return {
        status: "ok",
        provider: "zoom",
        externalEventId: sideCarMeetingId ?? "",
        meetLink: sideCarUrl,
      };
    }
    return { status: "skipped", reason: "no_connection" };
  }
  if (conn.status !== "active") {
    return { status: "skipped", reason: `connection_${conn.status}` };
  }

  const provider = conn.provider as CalendarProvider;
  // Defense in depth — pickConnectionForWrite already excludes zoom,
  // but a future change there should never silently fall through to
  // a code path that can't handle it.
  if (provider !== "google" && provider !== "microsoft") {
    return { status: "skipped", reason: `unsupported_provider_${provider}` };
  }

  try {
    const result =
      provider === "google"
        ? await createOnGoogle({ conn, ...args, sideCarUrl })
        : await createOnMicrosoft({ conn, ...args, sideCarUrl });

    // Opportunistically mark the connection as healthy. Mirrors the
    // booking path: a successful write is the strongest signal of
    // connection health we get.
    await markActive(conn.id).catch(() => undefined);

    return {
      status: "ok",
      provider,
      externalEventId: result.externalEventId,
      meetLink: result.meetLink,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // pm2 stderr captures this; no calendar_sync_log row for v1
    // (intentional — these events are operational and lower volume
    // than bookings, so the log table stays focused on the customer
    // path. Future hardening can lift the sync-log integration here.)
    console.error(
      `[calendar-events] sync failed (event=${args.event.id}, provider=${provider}):`,
      message,
    );
    return { status: "failed", message };
  }
}
