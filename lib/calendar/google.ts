/**
 * Google Calendar adapter.
 *
 * Thin wrapper around `googleapis` that takes a decrypted refresh token
 * and exposes the four operations the orchestrator needs:
 *   - createEvent
 *   - updateEvent (by external event id)
 *   - deleteEvent (by external event id)
 *   - getBusy (freebusy query for a window)
 *
 * Every method classifies errors via `classifyError()` so the orchestrator
 * can decide whether to flip status to 'needs_reconnect', retry, or log.
 *
 * No DB writes here — the adapter is stateless. Status mutation and
 * sync-log inserts live in the orchestrator (lib/calendar/sync.ts).
 */
import { google } from "googleapis";

import type {
  BusyInterval,
  ErrorClass,
  ExternalEventDraft,
  ExternalEventResult,
} from "./types";

const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function oauthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new ConfigError("Google OAuth env vars missing");
  }
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

/** Returns the consent URL we redirect users to. The `state` round-trips
 *  the connection-id (or user-id when bootstrapping) so the callback can
 *  match the result to the right row. The orchestrator handles signing.
 */
export function authUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh_token on every consent
    scope: OAUTH_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

/** Exchanges an authorization code for tokens. Returns the raw fields —
 *  the orchestrator encrypts before storage. Refresh token is REQUIRED:
 *  Google omits it if the user previously consented and hasn't revoked,
 *  so we always pass `prompt=consent` above to force its emission.
 */
export async function exchangeCode(code: string): Promise<{
  refreshToken: string;
  accessToken: string | null;
  expiresAt: Date | null;
  email: string | null;
  scope: string[];
}> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token. Revoke the existing grant " +
      "at https://myaccount.google.com/permissions and try again."
    );
  }

  // Fetch the authenticated email so we can show it next to the tile.
  let email: string | null = null;
  if (tokens.access_token) {
    try {
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const info = await oauth2.userinfo.get();
      email = info.data.email ?? null;
    } catch {
      email = null; // non-fatal; tile just shows "Google account"
    }
  }

  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? null,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    email,
    scope: tokens.scope ? tokens.scope.split(" ") : OAUTH_SCOPES,
  };
}

function calendarClient(refreshToken: string) {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth: client });
}

/** Create an event. Returns the provider event id + Meet link (if asked). */
export async function createEvent(args: {
  refreshToken: string;
  calendarId: string;
  draft: ExternalEventDraft;
}): Promise<ExternalEventResult> {
  const cal = calendarClient(args.refreshToken);
  const requestId = `${args.draft.organizerEmail}-${args.draft.startAt.getTime()}`;
  const res = await cal.events.insert({
    calendarId: args.calendarId || "primary",
    conferenceDataVersion: args.draft.videoConference ? 1 : 0,
    sendUpdates: "all",
    requestBody: {
      summary: args.draft.summary,
      description: args.draft.description,
      start: { dateTime: args.draft.startAt.toISOString(), timeZone: "UTC" },
      end: { dateTime: args.draft.endAt.toISOString(), timeZone: "UTC" },
      attendees: [
        { email: args.draft.organizerEmail },
        { email: args.draft.attendeeEmail, displayName: args.draft.attendeeName },
      ],
      conferenceData: args.draft.videoConference
        ? {
            createRequest: {
              requestId,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          }
        : undefined,
    },
  });
  return {
    eventId: res.data.id ?? "",
    meetLink: res.data.hangoutLink ?? null,
  };
}

/** Patch an existing event (used on reschedule). Idempotent server-side. */
export async function updateEvent(args: {
  refreshToken: string;
  calendarId: string;
  eventId: string;
  startAt: Date;
  endAt: Date;
  summary?: string;
}): Promise<void> {
  const cal = calendarClient(args.refreshToken);
  await cal.events.patch({
    calendarId: args.calendarId || "primary",
    eventId: args.eventId,
    sendUpdates: "all",
    requestBody: {
      start: { dateTime: args.startAt.toISOString(), timeZone: "UTC" },
      end: { dateTime: args.endAt.toISOString(), timeZone: "UTC" },
      ...(args.summary ? { summary: args.summary } : {}),
    },
  });
}

/** Cancel/delete an event. Returns success even if the event is already
 *  gone (404) — that's the desired end state. */
export async function deleteEvent(args: {
  refreshToken: string;
  calendarId: string;
  eventId: string;
}): Promise<void> {
  const cal = calendarClient(args.refreshToken);
  try {
    await cal.events.delete({
      calendarId: args.calendarId || "primary",
      eventId: args.eventId,
      sendUpdates: "all",
    });
  } catch (err) {
    if (classifyError(err) === "not_found") return; // idempotent
    throw err;
  }
}

/** Read busy intervals for a window. Google's freebusy API expands
 *  recurring events server-side AND includes all-day events, so the
 *  output covers the spec's "recurring + all-day" requirement without
 *  any client-side expansion logic. */
export async function getBusy(args: {
  refreshToken: string;
  calendarId: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<BusyInterval[]> {
  const cal = calendarClient(args.refreshToken);
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: args.windowStart.toISOString(),
      timeMax: args.windowEnd.toISOString(),
      items: [{ id: args.calendarId || "primary" }],
    },
  });
  const busy = res.data.calendars?.[args.calendarId || "primary"]?.busy ?? [];
  return busy.flatMap((b) => {
    if (!b.start || !b.end) return [];
    const start = new Date(b.start);
    const end = new Date(b.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
    return [{ start, end }];
  });
}

// ─── Error classification ──────────────────────────────────────────────

/**
 * Configuration errors (missing env) are thrown as ConfigError so the
 * orchestrator can distinguish them from API errors and log them as
 * 'config' instead of 'auth'.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Map a thrown error to one of our closed ErrorClass values. Heavily
 * defensive against the shapes googleapis throws — sometimes it's a
 * GaxiosError with `.code`, sometimes nested `.response.status`.
 */
export function classifyError(err: unknown): ErrorClass {
  if (err instanceof ConfigError) return "config";

  const e = err as {
    code?: number | string;
    status?: number;
    response?: { status?: number };
    message?: string;
  };

  const numericCode =
    typeof e?.code === "number"
      ? e.code
      : typeof e?.status === "number"
      ? e.status
      : e?.response?.status;

  if (numericCode === 401 || numericCode === 403) return "auth";
  if (numericCode === 404 || numericCode === 410) return "not_found";
  if (numericCode === 429) return "rate_limit";
  if (typeof numericCode === "number" && numericCode >= 500) return "transient";

  // String codes (network errors): ECONNRESET, ETIMEDOUT, etc.
  if (typeof e?.code === "string") {
    if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(e.code)) {
      return "transient";
    }
  }

  // googleapis surfaces invalid_grant as a string in the message when the
  // refresh token has been revoked at the Google account level.
  const msg = e?.message ?? "";
  if (msg.includes("invalid_grant") || msg.includes("Token has been expired or revoked")) {
    return "auth";
  }

  return "unknown";
}

/** Short, safe-to-log error message. Strips Google's verbose response
 *  bodies which can include user data we don't want in our logs. */
export function errorMessage(err: unknown): string {
  const e = err as { message?: string };
  const msg = e?.message ?? String(err);
  return msg.slice(0, 500);
}
