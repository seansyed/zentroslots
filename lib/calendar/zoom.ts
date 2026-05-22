/**
 * Zoom adapter (Wave D).
 *
 * Mirrors the shape of lib/calendar/google.ts and lib/calendar/microsoft.ts
 * so the orchestrator can dispatch through the same registry, but Zoom
 * is conceptually a SIDE-CAR meeting provider — it owns the meeting URL,
 * never the calendar event. Practical consequences:
 *
 *   • No `getBusy` export: Zoom has no freebusy API for our use case.
 *     The orchestrator's `readBusyForConnection` filters Zoom rows out.
 *   • `createEvent` returns a Zoom meeting id and join URL; the
 *     orchestrator wires that URL into the staff's primary calendar
 *     event (which lives on Google or Microsoft) so the customer sees
 *     "Zoom link" in confirmation emails + their calendar invite.
 *   • `updateEvent` / `deleteEvent` PATCH / DELETE the Zoom meeting
 *     in place using its meeting id — same idempotency contract as
 *     the other adapters.
 *
 * Token model:
 *   Zoom uses ROLLING refresh tokens (like Microsoft): every refresh
 *   call returns a new refresh_token that supersedes the previous one.
 *   Callers MUST persist the new refresh token or the chain breaks
 *   the next time we refresh. The orchestrator's
 *   `getZoomAccessToken` (in sync.ts) handles this — the adapter is
 *   stateless and just exposes the raw exchange/refresh primitives.
 *
 * Default meeting settings reflect operational safety: waiting room
 * on, join-before-host off, mute on entry, no auto-recording, server-
 * generated passcode. We deliberately don't expose these as runtime
 * config yet — Wave D scope is "enterprise-safe defaults", not "Zoom
 * admin controls."
 *
 * No DB writes here.
 */

import type {
  BusyInterval,
  ErrorClass,
  ExternalEventDraft,
  ExternalEventResult,
} from "./types";

// ─── Endpoints ─────────────────────────────────────────────────────────

const OAUTH_AUTHORIZE_URL = "https://zoom.us/oauth/authorize";
const OAUTH_TOKEN_URL = "https://zoom.us/oauth/token";
const ZOOM_API_BASE = "https://api.zoom.us/v2";

/**
 * Granular Zoom OAuth scopes (post-2024 model). Each maps to a single
 * action: read the authenticated user (for the account email tile),
 * and create/update/delete meetings on their behalf.
 *
 * Why granular not bundled:
 *   Zoom rejects apps requesting the bundled `user:read meeting:write`
 *   scopes for new app registrations. The granular scopes also reduce
 *   the consent surface visible to the user.
 *
 * `user_zak:read` (the legacy "API token") is intentionally NOT
 *   requested — we don't generate ZAKs.
 */
const OAUTH_SCOPES = [
  "user:read:user",
  "meeting:read:meeting",
  "meeting:write:meeting",
  "meeting:update:meeting",
  "meeting:delete:meeting",
];

// ─── Config helpers ────────────────────────────────────────────────────

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readEnv() {
  const {
    ZOOM_CLIENT_ID,
    ZOOM_CLIENT_SECRET,
    ZOOM_REDIRECT_URI,
    APP_BASE_URL,
  } = process.env;
  if (!ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
    throw new ConfigError("Zoom OAuth env vars missing (ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET)");
  }
  const redirectUri =
    ZOOM_REDIRECT_URI ??
    `${(APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "")}/api/calendar/zoom/callback`;
  return {
    clientId: ZOOM_CLIENT_ID,
    clientSecret: ZOOM_CLIENT_SECRET,
    redirectUri,
  };
}

/** Zoom requires Basic auth (base64-encoded client_id:client_secret)
 *  on the token endpoint. Built once per call to avoid leaking the
 *  encoded string. */
function basicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

// ─── OAuth ─────────────────────────────────────────────────────────────

/**
 * Consent URL. `state` round-trips the orchestrator-chosen state param
 * (user id) so the callback can match the result to the right row.
 */
export function authUrl(state: string): string {
  const { clientId, redirectUri } = readEnv();
  const u = new URL(OAUTH_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  u.searchParams.set("state", state);
  return u.toString();
}

export type ExchangedTokens = {
  refreshToken: string;
  accessToken: string | null;
  expiresAt: Date | null;
  email: string | null;
  scope: string[];
};

/**
 * Exchanges an authorization code for tokens.
 *
 * Zoom's token endpoint uses Basic auth (NOT a body-encoded secret
 * like Microsoft) — the body carries only the grant type + code +
 * redirect URI.
 */
export async function exchangeCode(code: string): Promise<ExchangedTokens> {
  const { clientId, clientSecret, redirectUri } = readEnv();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Zoom token exchange failed (${res.status}): ${text.slice(0, 400)}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!json.refresh_token) {
    throw new Error(
      "Zoom did not return a refresh_token. Verify the app's OAuth " +
      "configuration grants refresh tokens (some Zoom app types omit them).",
    );
  }

  // Resolve the account email via /users/me. Non-fatal — the tile
  // works either way, the user just sees a generic "Zoom account"
  // label when the lookup fails (e.g. user:read:user scope not granted).
  let email: string | null = null;
  if (json.access_token) {
    try {
      const meRes = await fetch(`${ZOOM_API_BASE}/users/me`, {
        headers: { Authorization: `Bearer ${json.access_token}` },
      });
      if (meRes.ok) {
        const me = (await meRes.json()) as { email?: string };
        email = me.email ?? null;
      }
    } catch {
      email = null;
    }
  }

  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token ?? null,
    expiresAt: json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000)
      : null,
    email,
    scope: json.scope ? json.scope.split(/\s+/).filter(Boolean) : OAUTH_SCOPES,
  };
}

/**
 * Exchange a refresh token for a fresh access token. ROLLING refresh:
 * Zoom returns a new refresh_token that supersedes the input. Caller
 * MUST persist the new value (the orchestrator does this).
 *
 * On Zoom, expired or revoked refresh tokens come back as HTTP 401
 * with a JSON body `{ reason: "Invalid Token!" }` or `{ error: "invalid_grant" }`.
 * The classifier below routes both onto our `auth` ErrorClass.
 */
export async function refreshAccessToken(refreshTokenIn: string): Promise<ExchangedTokens> {
  const { clientId, clientSecret } = readEnv();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTokenIn,
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err: Error & { status?: number } = new Error(
      `Zoom token refresh failed (${res.status}): ${text.slice(0, 400)}`,
    );
    err.status = res.status;
    throw err;
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  return {
    refreshToken: json.refresh_token ?? refreshTokenIn,
    accessToken: json.access_token ?? null,
    expiresAt: json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000)
      : null,
    email: null,
    scope: json.scope ? json.scope.split(/\s+/).filter(Boolean) : OAUTH_SCOPES,
  };
}

// ─── Zoom API HTTP helper ──────────────────────────────────────────────

export type ZoomError = Error & {
  status?: number;
  /** Honored by the orchestrator's retry sleep; in seconds. */
  retryAfterSec?: number;
  /** Zoom's machine-readable error code, surfaced by their API:
   *  https://developers.zoom.us/docs/api/rest/reference/error-codes/ */
  zoomCode?: number;
};

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.min(60, Math.max(1, Math.round(n)));
  const d = new Date(value).getTime();
  if (!Number.isNaN(d)) {
    const sec = Math.round((d - Date.now()) / 1000);
    if (sec > 0) return Math.min(60, sec);
  }
  return undefined;
}

async function zoomApi(
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${ZOOM_API_BASE}${path}`, { method, headers, body });

  // 204 No Content → return null (DELETE returns this)
  if (res.status === 204) return null;

  const text = await res.text();
  if (!res.ok) {
    // Zoom's error envelope is `{ code: number, message: string }`.
    // Extract `code` so the classifier can map it precisely.
    let zoomCode: number | undefined;
    try {
      if (text.trim().startsWith("{")) {
        const parsed = JSON.parse(text) as { code?: number };
        zoomCode = typeof parsed?.code === "number" ? parsed.code : undefined;
      }
    } catch {
      zoomCode = undefined;
    }

    const err: ZoomError = Object.assign(
      new Error(`Zoom ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`),
      {
        status: res.status,
        zoomCode,
        retryAfterSec: parseRetryAfter(res.headers.get("retry-after")),
      },
    );
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// ─── Meeting settings — operational defaults ───────────────────────────

/**
 * Wave D — sensible enterprise defaults applied to every meeting we
 * create. These match the brief's Part 5:
 *
 *   • waiting_room      → ON  (host admits attendees; no random join)
 *   • join_before_host  → OFF (attendees can't enter empty meetings)
 *   • mute_upon_entry   → ON  (less disruptive joins)
 *   • auto_recording    → "none" (no surprise cloud recordings; admins
 *                                 can override per-meeting in Zoom UI
 *                                 if their tenant policy allows it)
 *
 * Passcode strategy:
 *   We let Zoom auto-generate the passcode by leaving the `password`
 *   field unset AND requesting `meeting_authentication: false`. Zoom's
 *   default behavior (since 2021) is to generate a passcode on every
 *   meeting unless the account's policy disables it — which we
 *   intentionally don't override.
 *
 * The passcode is baked into the `join_url` Zoom returns, so
 * customers click once and join. No separate "Here's your passcode"
 * step required.
 */
const DEFAULT_MEETING_SETTINGS = {
  host_video: false,
  participant_video: false,
  waiting_room: true,
  join_before_host: false,
  mute_upon_entry: true,
  approval_type: 2, // 0=automatic, 1=manual, 2=no registration required
  audio: "both",
  auto_recording: "none" as const,
} as const;

// ─── Event lifecycle ───────────────────────────────────────────────────

/**
 * Create a Zoom meeting.
 *
 * `type: 2` = scheduled meeting (one-off). Zoom distinguishes:
 *   1 = instant meeting (start immediately, no future time)
 *   2 = scheduled meeting     ← what we use for every booking
 *   3 = recurring with no fixed time
 *   8 = recurring with fixed time
 *
 * Per Wave D's "1 booking = 1 meeting" contract we always use type 2.
 * Recurring bookings still emit one Zoom meeting per occurrence — the
 * materializer fires this once per materialized booking row.
 *
 * `topic`: the visible meeting name (shows in calendar invites and the
 * Zoom client). We use the same string the calendar event uses.
 *
 * Idempotency: Zoom doesn't accept a client-supplied request id for
 * meeting creation, so retry safety here comes from the orchestrator
 * only retrying transient/rate-limit failures, and the booking row
 * persisting the meeting id on first success.
 */
export async function createEvent(args: {
  accessToken: string;
  draft: ExternalEventDraft;
}): Promise<ExternalEventResult> {
  const duration = Math.max(
    1,
    Math.round((args.draft.endAt.getTime() - args.draft.startAt.getTime()) / 60_000),
  );

  const body: Record<string, unknown> = {
    topic: args.draft.summary.slice(0, 200), // Zoom topic field maxes at 200 chars
    type: 2,
    start_time: args.draft.startAt.toISOString(),
    duration,
    timezone: "UTC",
    agenda: args.draft.description?.slice(0, 2000) || "",
    settings: {
      ...DEFAULT_MEETING_SETTINGS,
    },
  };

  const res = (await zoomApi(args.accessToken, "/users/me/meetings", {
    method: "POST",
    body,
  })) as {
    id?: number;
    join_url?: string;
    password?: string;
    encrypted_password?: string;
  };

  // Zoom returns `id` as a NUMBER but our schema column is a string.
  // Store the canonical decimal representation — Zoom accepts it back
  // as a path segment on update/delete.
  const meetingId = res?.id != null ? String(res.id) : "";
  const joinUrl = res?.join_url ?? null;

  return {
    eventId: meetingId,
    meetLink: args.draft.videoConference ? joinUrl : joinUrl,
    // Note: `videoConference` is always true when the orchestrator
    // routes here (Zoom only exists to provide a meeting URL), so we
    // return the join URL unconditionally. The orchestrator decides
    // whether to surface it on the booking.
  };
}

/**
 * Patch an existing meeting (reschedule). Zoom's PATCH /meetings/{id}
 * accepts the same body shape as create; we only send the fields that
 * changed. Returns 204 on success.
 *
 * Idempotent: PATCH with the same body twice is a no-op on Zoom's side.
 *
 * The meeting's `join_url` is STABLE across updates — it doesn't change
 * when start_time changes. This is the Wave D-critical property: a
 * customer who already received the Zoom URL in their confirmation
 * email keeps using the SAME URL after a reschedule.
 */
export async function updateEvent(args: {
  accessToken: string;
  eventId: string;
  startAt: Date;
  endAt: Date;
  summary?: string;
}): Promise<void> {
  const duration = Math.max(
    1,
    Math.round((args.endAt.getTime() - args.startAt.getTime()) / 60_000),
  );
  const body: Record<string, unknown> = {
    start_time: args.startAt.toISOString(),
    duration,
    timezone: "UTC",
  };
  if (args.summary) body.topic = args.summary.slice(0, 200);

  await zoomApi(args.accessToken, `/meetings/${encodeURIComponent(args.eventId)}`, {
    method: "PATCH",
    body,
  });
}

/**
 * Cancel/delete a meeting. 404 is treated as success — same contract
 * as Google and Microsoft. Zoom returns 204 on a successful delete.
 *
 * We deliberately DON'T send `schedule_for_reminder=true` (which would
 * email the host about the deletion) — the customer will already get
 * a cancellation email from us via the comms engine.
 */
export async function deleteEvent(args: {
  accessToken: string;
  eventId: string;
}): Promise<void> {
  try {
    await zoomApi(args.accessToken, `/meetings/${encodeURIComponent(args.eventId)}`, {
      method: "DELETE",
    });
  } catch (err) {
    if (classifyError(err) === "not_found") return;
    throw err;
  }
}

/**
 * `getBusy` is INTENTIONALLY NOT EXPORTED.
 *
 * Zoom doesn't have a freebusy API in the calendar sense — its
 * `/users/me/meetings` endpoint lists scheduled meetings the user
 * created via Zoom, but most staff schedule their meetings via their
 * calendar (Google / Outlook), so it would miss most busy time. We
 * route freebusy reads through the calendar provider only.
 *
 * The orchestrator's `readBusyForConnection` skips Zoom connections.
 */

// ─── Error classification ──────────────────────────────────────────────

/**
 * Zoom-specific error codes that mean "user needs to reconnect."
 * Reference: https://developers.zoom.us/docs/api/rest/reference/error-codes/
 *
 * Wave D — selecting the codes that warrant a `needs_reconnect` flip
 * vs. retry vs. transient. Conservative: only flip when we're certain
 * the user must take action.
 */
const ZOOM_AUTH_CODES = new Set([
  124, // Invalid access token
  1001, // User does not exist (revoked / left account)
  1010, // User not exist on this account
  4700, // Invalid or revoked access token
]);

const ZOOM_NOT_FOUND_CODES = new Set([
  3001, // Meeting does not exist
  3008, // Meeting not started yet (when querying a not-yet-started recurring instance)
]);

const ZOOM_RATE_LIMIT_CODES = new Set([
  429, // (also surfaces as HTTP 429; included for completeness)
]);

export function classifyError(err: unknown): ErrorClass {
  if (err instanceof ConfigError) return "config";

  const e = err as {
    status?: number;
    code?: string | number;
    message?: string;
    zoomCode?: number;
  };
  const status =
    typeof e?.status === "number"
      ? e.status
      : typeof e?.code === "number"
      ? e.code
      : undefined;

  // Zoom's structured error code disambiguates ambiguous HTTP statuses.
  // A 400 with zoomCode=124 is really an auth failure on a stale token.
  if (typeof e?.zoomCode === "number") {
    if (ZOOM_AUTH_CODES.has(e.zoomCode)) return "auth";
    if (ZOOM_NOT_FOUND_CODES.has(e.zoomCode)) return "not_found";
    if (ZOOM_RATE_LIMIT_CODES.has(e.zoomCode)) return "rate_limit";
  }

  if (status === 401) return "auth";
  // Zoom uses 403 for both "forbidden" (genuine auth) AND "your plan
  // doesn't include this feature" (config). We treat 403 as auth
  // primarily; the rare plan-restriction case still triggers a
  // reconnect prompt, which is the least-bad outcome (admin sees the
  // failure and contacts support).
  if (status === 403) return "auth";
  if (status === 404 || status === 410) return "not_found";
  if (status === 429) return "rate_limit";
  if (typeof status === "number" && status >= 500) return "transient";

  if (typeof e?.code === "string") {
    if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(e.code)) {
      return "transient";
    }
  }

  const msg = e?.message ?? "";
  if (
    msg.includes("invalid_grant") ||
    msg.includes("Invalid Token") ||
    msg.includes("invalid_token") ||
    msg.includes("expired_token")
  ) {
    return "auth";
  }

  return "unknown";
}

/**
 * Translate raw error text into a human-readable, actionable
 * description for the staff-facing reconnect email + dashboard banner.
 * Mirrors Microsoft's `describeError` pattern from Wave C.1.
 */
export function describeError(err: unknown): string {
  const e = err as { message?: string; zoomCode?: number; status?: number };
  const msg = e?.message ?? String(err);

  if (e?.zoomCode === 124 || e?.zoomCode === 4700) {
    return "Your Zoom access has been revoked. Reconnect Zoom to resume creating meetings for new bookings.";
  }
  if (e?.zoomCode === 1001 || e?.zoomCode === 1010) {
    return "Your Zoom user account is no longer accessible (account changed, left organization, or deactivated). Reconnect Zoom.";
  }
  if (e?.status === 403 && /Plan/i.test(msg)) {
    return "Your Zoom plan doesn't include the API features we use. Contact your Zoom admin or upgrade your plan.";
  }
  if (e?.status === 401) {
    return "Your Zoom session is no longer valid. Reconnect Zoom to refresh credentials.";
  }
  if (e?.status === 429 || e?.zoomCode === 429) {
    return "Zoom is rate-limiting requests. Meeting sync will resume automatically.";
  }
  if (msg.includes("invalid_grant") || msg.includes("Invalid Token") || msg.includes("expired_token")) {
    return "Your Zoom session has expired. Reconnect Zoom to resume meeting sync.";
  }

  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}

export function errorMessage(err: unknown): string {
  const e = err as { message?: string };
  const msg = e?.message ?? String(err);
  return msg.slice(0, 500);
}

// Re-export the (unused) BusyInterval type so the module surface
// matches Google + Microsoft. Helpful for future intersection types.
export type { BusyInterval };
