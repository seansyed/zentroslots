/**
 * Microsoft Graph adapter (Wave C).
 *
 * Mirrors the shape of lib/calendar/google.ts so the orchestrator in
 * lib/calendar/sync.ts can dispatch through a single registry without
 * provider-specific branching scattered through booking lifecycle code.
 *
 * Responsibilities:
 *   - OAuth code exchange + refresh-token rotation (Microsoft identity
 *     platform v2.0 endpoints — common tenant).
 *   - Calendar event create / patch / delete via Graph `/me/events`.
 *   - Free/busy reads via Graph `/me/calendar/getSchedule`.
 *   - Teams online-meeting creation as part of the event payload
 *     (`isOnlineMeeting: true`, `onlineMeetingProvider: teamsForBusiness`).
 *
 * Why no SDK:
 *   The `@azure/msal-node` library is OAuth-only; for Graph calls
 *   you still talk HTTP. `@microsoft/microsoft-graph-client` ships a
 *   thin fetch wrapper that pulls in heavyweight Polyfill code and a
 *   different auth shape than we need. Plain fetch is simpler, gives
 *   us full control over retries (orchestrator owns that layer), and
 *   keeps the adapter dependency-free.
 *
 * Token model:
 *   Microsoft access tokens live ~1h; refresh tokens up to 90 days
 *   with rolling refresh (every refresh call returns a NEW refresh
 *   token that supersedes the previous one). Callers must persist
 *   the new refresh token whenever `refreshAccessToken` returns one
 *   that differs from the input — otherwise the chain breaks 90 days
 *   later. The orchestrator owns this persistence.
 *
 * Stateless. No DB writes here.
 */

import type {
  BusyInterval,
  ErrorClass,
  ExternalEventDraft,
  ExternalEventResult,
} from "./types";

// ─── Endpoints ─────────────────────────────────────────────────────────

const OAUTH_AUTHORIZE_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const OAUTH_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Scopes we ask for at consent time. The `offline_access` scope is
 * what gets us a refresh token at all; the rest cover the operations
 * the orchestrator dispatches.
 *
 *   - User.Read              → fetch the signed-in account email
 *   - Calendars.ReadWrite    → read busy time + create/update/delete events
 *   - OnlineMeetings.ReadWrite → required when isOnlineMeeting=true; without
 *                               it, event creation succeeds but Teams join
 *                               URL is null, causing the same silent-link-
 *                               failure pattern Wave A guarded against
 *
 * `openid email profile` round-trip the ID token + email claim so we
 * don't need a second /me round-trip on every connect (we still do
 * one for the canonical mail, but having it on the ID token is the
 * fast path).
 */
const OAUTH_SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "email",
  "User.Read",
  "Calendars.ReadWrite",
  "OnlineMeetings.ReadWrite",
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
    MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET,
    MICROSOFT_REDIRECT_URI,
    APP_BASE_URL,
  } = process.env;
  if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) {
    throw new ConfigError("Microsoft OAuth env vars missing (MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET)");
  }
  const redirectUri =
    MICROSOFT_REDIRECT_URI ??
    `${(APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "")}/api/calendar/microsoft/callback`;
  return {
    clientId: MICROSOFT_CLIENT_ID,
    clientSecret: MICROSOFT_CLIENT_SECRET,
    redirectUri,
  };
}

// ─── OAuth ─────────────────────────────────────────────────────────────

/**
 * Returns the consent URL we redirect users to. `state` round-trips
 * the user id (the orchestrator's chosen state param) so the callback
 * can match the result to the right row.
 *
 *   - prompt=select_account encourages the user to pick their work
 *     account rather than auto-using whichever Microsoft session is
 *     already attached to the browser. Critical for multi-tenant
 *     installations where the staff member's personal Microsoft
 *     account would otherwise be picked silently.
 *   - response_mode=query keeps the response in the URL (consistent
 *     with the Google flow's callback handler shape).
 */
export function authUrl(state: string): string {
  const { clientId, redirectUri } = readEnv();
  const u = new URL(OAUTH_AUTHORIZE_URL);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

/** Token response normalised to the same shape as the Google adapter
 *  so callers can use a single binding. */
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
 * Microsoft's token endpoint speaks `application/x-www-form-urlencoded`
 * with the client secret in the body — we follow that protocol exactly
 * rather than using Authorization: Basic, because some Azure tenant
 * configurations reject the Basic form.
 *
 * If `offline_access` was granted the response includes a refresh token;
 * otherwise we treat it as a hard error (no refresh = no ability to
 * sync after the access token expires). The user should re-consent.
 */
export async function exchangeCode(code: string): Promise<ExchangedTokens> {
  const { clientId, clientSecret, redirectUri } = readEnv();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES.join(" "),
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Microsoft token exchange failed (${res.status}): ${text.slice(0, 400)}`,
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
      "Microsoft did not return a refresh_token. The user likely declined " +
      "the offline_access scope. Have them retry the connect flow.",
    );
  }

  // Resolve the account email via /me. Non-fatal on failure — the tile
  // still works, the user just sees a generic "Microsoft account" label.
  let email: string | null = null;
  if (json.access_token) {
    try {
      const meRes = await fetch(`${GRAPH_BASE}/me`, {
        headers: { Authorization: `Bearer ${json.access_token}` },
      });
      if (meRes.ok) {
        const me = (await meRes.json()) as { mail?: string; userPrincipalName?: string };
        email = me.mail ?? me.userPrincipalName ?? null;
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
 * Exchange a refresh token for a fresh access token. Microsoft uses
 * **rolling refresh**: the response normally contains a NEW refresh
 * token that supersedes the input. The caller MUST persist
 * `refreshToken` from the response — losing it means the next refresh
 * call fails with AADSTS70008 (token replaced or revoked) ~24h later.
 *
 * Returns the same shape as `exchangeCode` for symmetry.
 */
export async function refreshAccessToken(refreshTokenIn: string): Promise<ExchangedTokens> {
  const { clientId, clientSecret, redirectUri } = readEnv();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshTokenIn,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES.join(" "),
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    // Surface enough detail for classifyError() to land on "auth" for
    // AADSTS70008 / invalid_grant / revoked, and "transient" for 5xx.
    const text = await res.text().catch(() => "");
    const err = new Error(
      `Microsoft token refresh failed (${res.status}): ${text.slice(0, 400)}`,
    );
    (err as { status?: number }).status = res.status;
    throw err;
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  // If Microsoft chose not to rotate (rare; happens for some app
  // registrations) we keep using the same refresh token. Most flows
  // get a new one on every refresh.
  return {
    refreshToken: json.refresh_token ?? refreshTokenIn,
    accessToken: json.access_token ?? null,
    expiresAt: json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000)
      : null,
    email: null, // not returned on refresh; caller doesn't need it
    scope: json.scope ? json.scope.split(/\s+/).filter(Boolean) : OAUTH_SCOPES,
  };
}

// ─── Graph HTTP helper ─────────────────────────────────────────────────

async function graph(
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
  const res = await fetch(`${GRAPH_BASE}${path}`, { method, headers, body });

  // 204 No Content → return null (delete returns this)
  if (res.status === 204) return null;

  const text = await res.text();
  if (!res.ok) {
    // Attach status so classifyError() can read it. Graph returns a
    // JSON body with { error: { code, message } } for errors; surface
    // a truncated message to avoid leaking entire response payloads
    // into logs.
    const err = new Error(`Graph ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// ─── Event lifecycle ───────────────────────────────────────────────────

/**
 * Create a calendar event. When `videoConference: true` we set
 * `isOnlineMeeting: true` so Graph spawns a Teams meeting alongside
 * the event and returns its `joinUrl` in the response. Returning the
 * join URL on the same round-trip keeps the orchestrator path
 * identical to Google's (one network call → one event + one link).
 *
 * Attendees: the staff organizer's email + the customer's email.
 * Graph automatically sends invitations because we pass an organizer
 * and the response objects.
 *
 * Idempotency: Microsoft doesn't accept a client-supplied event ID
 * the way Google does, so duplicate-create protection comes from the
 * orchestrator's retry policy (transient/rate_limit only) plus the
 * fact that the booking row's `externalEventId` is set on first
 * success. A retry that happens AFTER success would only fire if the
 * client never saw the success — extremely rare in practice.
 */
export async function createEvent(args: {
  accessToken: string;
  draft: ExternalEventDraft;
}): Promise<ExternalEventResult> {
  const body: Record<string, unknown> = {
    subject: args.draft.summary,
    body: {
      contentType: "text",
      content: args.draft.description || "",
    },
    start: {
      dateTime: args.draft.startAt.toISOString(),
      timeZone: "UTC",
    },
    end: {
      dateTime: args.draft.endAt.toISOString(),
      timeZone: "UTC",
    },
    attendees: [
      {
        emailAddress: { address: args.draft.attendeeEmail, name: args.draft.attendeeName },
        type: "required",
      },
    ],
  };
  if (args.draft.videoConference) {
    body.isOnlineMeeting = true;
    body.onlineMeetingProvider = "teamsForBusiness";
  }

  const res = (await graph(args.accessToken, "/me/events", {
    method: "POST",
    body,
  })) as {
    id?: string;
    onlineMeeting?: { joinUrl?: string };
    onlineMeetingUrl?: string;
  };

  // Graph returns the join URL under `onlineMeeting.joinUrl` on the
  // returned event resource. Older Graph versions sometimes surface
  // `onlineMeetingUrl` instead — read both for forward/back compat.
  const joinUrl =
    res?.onlineMeeting?.joinUrl ??
    res?.onlineMeetingUrl ??
    null;

  return {
    eventId: res?.id ?? "",
    meetLink: args.draft.videoConference ? joinUrl : null,
  };
}

/**
 * Patch an existing event (used on reschedule). Idempotent server-side
 * because PATCH replaces only the fields we send. We DO NOT touch
 * `isOnlineMeeting` here — the Teams URL stays attached to the same
 * event across reschedules. This is the Wave-C-critical behavior:
 * "Teams URL preserved across reschedule."
 */
export async function updateEvent(args: {
  accessToken: string;
  eventId: string;
  startAt: Date;
  endAt: Date;
  summary?: string;
}): Promise<void> {
  const body: Record<string, unknown> = {
    start: { dateTime: args.startAt.toISOString(), timeZone: "UTC" },
    end: { dateTime: args.endAt.toISOString(), timeZone: "UTC" },
  };
  if (args.summary) body.subject = args.summary;
  await graph(args.accessToken, `/me/events/${encodeURIComponent(args.eventId)}`, {
    method: "PATCH",
    body,
  });
}

/**
 * Cancel/delete an event. 404 is treated as success (idempotent — the
 * desired end state is "no event exists on the server"). This matches
 * the Google adapter's contract.
 */
export async function deleteEvent(args: {
  accessToken: string;
  eventId: string;
}): Promise<void> {
  try {
    await graph(args.accessToken, `/me/events/${encodeURIComponent(args.eventId)}`, {
      method: "DELETE",
    });
  } catch (err) {
    if (classifyError(err) === "not_found") return;
    throw err;
  }
}

/**
 * Read busy intervals via Graph's getSchedule. We pass the user's own
 * email as the only schedule target — Graph expands recurring events
 * server-side AND respects all-day blocks, matching Google's
 * freebusy semantics so the availability engine doesn't need any
 * client-side expansion.
 *
 * Busy classification: Graph returns `scheduleItems[]` with a `status`
 * field of `free | busy | tentative | oof | workingElsewhere | unknown`.
 * We treat ANY non-free status as busy. Tentative is intentionally
 * included — if the staff has a "maybe" on their calendar we'd rather
 * NOT double-book over it; manual override via dashboard is always
 * available.
 *
 * `availabilityViewInterval: 60` is the bucket size for the
 * `availabilityView` string Graph also returns; we ignore that field
 * and use `scheduleItems` directly because it carries exact start/end
 * times instead of bucketed bitmaps.
 */
export async function getBusy(args: {
  accessToken: string;
  accountEmail: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<BusyInterval[]> {
  const body = {
    schedules: [args.accountEmail],
    startTime: { dateTime: args.windowStart.toISOString(), timeZone: "UTC" },
    endTime: { dateTime: args.windowEnd.toISOString(), timeZone: "UTC" },
    availabilityViewInterval: 60,
  };
  const res = (await graph(args.accessToken, "/me/calendar/getSchedule", {
    method: "POST",
    body,
  })) as {
    value?: Array<{
      scheduleItems?: Array<{
        status?: string;
        start?: { dateTime?: string; timeZone?: string };
        end?: { dateTime?: string; timeZone?: string };
      }>;
    }>;
  };

  const items = res?.value?.[0]?.scheduleItems ?? [];
  const out: BusyInterval[] = [];
  for (const it of items) {
    if (!it.start?.dateTime || !it.end?.dateTime) continue;
    // Skip explicit "free" entries. Treat unknown defensively as busy
    // so we never silently widen availability based on Graph's
    // ambiguous classifications.
    if (it.status === "free") continue;
    // Graph returns naive ISO strings without timezone offset; assume
    // UTC since that's what we requested. (Graph honors the timeZone
    // header we passed.)
    const start = parseGraphDate(it.start.dateTime, it.start.timeZone);
    const end = parseGraphDate(it.end.dateTime, it.end.timeZone);
    if (!start || !end) continue;
    out.push({ start, end });
  }
  return out;
}

/**
 * Graph's getSchedule returns dateTimes WITHOUT a trailing Z, even
 * when timeZone is "UTC". We need to coerce them to proper Date
 * objects. If timezone is anything other than UTC, log + drop —
 * we explicitly request UTC and any other value is a bug in Graph's
 * response.
 */
function parseGraphDate(dt: string, tz: string | undefined): Date | null {
  // ISO strings sometimes arrive with sub-second precision but no Z.
  const iso = dt.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(dt) ? dt : `${dt}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // If Graph returned a non-UTC zone we'd have to reinterpret — leave
  // a defensive log breadcrumb if that ever happens so we can patch.
  if (tz && tz !== "UTC") {
    // eslint-disable-next-line no-console
    console.warn(`[calendar/microsoft] unexpected timezone in getSchedule: ${tz}`);
  }
  return d;
}

// ─── Error classification ──────────────────────────────────────────────

/**
 * Map a thrown error to one of our closed ErrorClass values. Mirrors
 * the Google adapter so the orchestrator can treat both providers
 * uniformly.
 */
export function classifyError(err: unknown): ErrorClass {
  if (err instanceof ConfigError) return "config";

  const e = err as { status?: number; code?: string | number; message?: string };
  const status =
    typeof e?.status === "number"
      ? e.status
      : typeof e?.code === "number"
      ? e.code
      : undefined;

  if (status === 401 || status === 403) return "auth";
  if (status === 404 || status === 410) return "not_found";
  if (status === 429) return "rate_limit";
  if (typeof status === "number" && status >= 500) return "transient";

  if (typeof e?.code === "string") {
    if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(e.code)) {
      return "transient";
    }
  }

  // Microsoft's AADSTS70008 ("token expired or revoked") + invalid_grant
  // both surface only in the message string when the refresh token is
  // dead. Treat as auth so the orchestrator flips to needs_reconnect.
  const msg = e?.message ?? "";
  if (
    msg.includes("invalid_grant") ||
    msg.includes("AADSTS70008") ||
    msg.includes("AADSTS50173") || // password changed → forces re-consent
    msg.includes("AADSTS700082") || // refresh token inactive >90 days
    msg.includes("interaction_required")
  ) {
    return "auth";
  }

  return "unknown";
}

/** Short, safe-to-log error message. */
export function errorMessage(err: unknown): string {
  const e = err as { message?: string };
  const msg = e?.message ?? String(err);
  return msg.slice(0, 500);
}
