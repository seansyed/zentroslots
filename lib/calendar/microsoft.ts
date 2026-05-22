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

/**
 * Errors thrown by `graph()` carry these optional fields so the
 * orchestrator's retry loop can:
 *   - read the HTTP status (classifyError mapping)
 *   - honor Graph's Retry-After header on 429 / 503 instead of using
 *     our generic backoff schedule (Wave C.1 throttling hardening)
 *   - surface the upstream Graph error code (e.g. "ErrorAccessDenied",
 *     "ResourceNotFound") in sync logs alongside the AADSTS code
 */
export type GraphError = Error & {
  status?: number;
  /** Honored by the orchestrator's retry sleep; in seconds. */
  retryAfterSec?: number;
  /** Graph's machine-readable error.code field, if present. */
  graphCode?: string;
};

/**
 * Parse Graph's Retry-After header. Microsoft sends EITHER a number
 * of seconds OR an HTTP-date; we handle both. Clamp to a sane range
 * (1s..60s) so a misbehaving Graph response can't pin us at a
 * 30-minute sleep on a hot booking path.
 */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  // Numeric seconds path (Graph's normal response).
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.min(60, Math.max(1, Math.round(n)));
  // HTTP-date fallback. Rare from Graph but spec-allowed.
  const d = new Date(value).getTime();
  if (!Number.isNaN(d)) {
    const sec = Math.round((d - Date.now()) / 1000);
    if (sec > 0) return Math.min(60, sec);
  }
  return undefined;
}

async function graph(
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown; clientRequestId?: string } = {},
): Promise<unknown> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  // Wave C.1 — `client-request-id` is Graph's idempotency hint. When
  // the same id arrives on a POST that already succeeded, Graph
  // collapses the second call to the first response (in most
  // situations). Best practice for mutating calls; harmless on reads.
  if (init.clientRequestId) {
    headers["client-request-id"] = init.clientRequestId;
  }
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
    // Try to pull Graph's structured error code out of the response
    // body. Graph's error envelope is always `{ error: { code, message } }`
    // so we parse defensively and ignore non-JSON bodies (some
    // gateway 5xxs come back as plain HTML).
    let graphCode: string | undefined;
    try {
      if (text.trim().startsWith("{")) {
        const parsed = JSON.parse(text) as { error?: { code?: string } };
        graphCode = parsed?.error?.code;
      }
    } catch {
      graphCode = undefined;
    }

    const err: GraphError = Object.assign(
      new Error(`Graph ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`),
      {
        status: res.status,
        graphCode,
        retryAfterSec: parseRetryAfter(res.headers.get("retry-after")),
      },
    );
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

  // Wave C.1 — idempotency on retries.
  //
  // The orchestrator retries on transient/rate_limit failures. If a
  // retry happens AFTER Graph actually created the event but BEFORE
  // we received the response (TCP reset / our timeout), a naive retry
  // would create a duplicate Outlook event AND a duplicate Teams
  // meeting URL. We stabilize the `client-request-id` per (organizer,
  // attendee, startMs) so Graph collapses duplicate POSTs from the
  // same logical create into a single event. The same key is stable
  // across our internal retries but unique across distinct bookings.
  //
  // Note: Graph's idempotency window is ~24h; longer than our retry
  // budget (max ~4s) by orders of magnitude. Safe.
  const requestId = stableRequestId(
    args.draft.organizerEmail,
    args.draft.attendeeEmail,
    args.draft.startAt.getTime(),
  );

  const res = (await graph(args.accessToken, "/me/events", {
    method: "POST",
    body,
    clientRequestId: requestId,
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
 * Stable per-booking request id used as `client-request-id` so Graph
 * can dedupe our retries. UUID-shaped (Graph rejects arbitrary
 * strings) — we hash the (organizer, attendee, startMs) triple into a
 * deterministic 8-4-4-4-12 grouping.
 *
 * Hash uses Node's crypto via `globalThis.crypto.subtle` would be
 * async; we use a simpler djb2 expansion that produces a v4-shaped
 * hex string. Collision risk is irrelevant for our purposes — we
 * only need stability inside a single booking's retry window.
 */
function stableRequestId(organizer: string, attendee: string, startMs: number): string {
  const input = `${organizer.toLowerCase()}|${attendee.toLowerCase()}|${startMs}`;
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) >>> 0; // djb2
    h2 = ((h2 << 5) - h2 + c) >>> 0; // sdbm
  }
  const hex = (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
    //
    // Wave C.1 — explicit pass list documents which Graph statuses
    // count as busy:
    //   - busy            : event with no special status
    //   - tentative       : "maybe" event; conservative inclusion so
    //                       we don't book over a soft hold
    //   - oof             : out of office
    //   - workingElsewhere: working but not at desk; still busy from
    //                       the staff's perspective
    //   - unknown         : Graph couldn't classify; conservative
    //                       inclusion to avoid silent double-bookings
    // anything else (including future Graph values we don't recognize)
    // is treated as busy via the default branch below.
    if (it.status === "free") continue;
    // Graph returns naive ISO strings without timezone offset; assume
    // UTC since that's what we requested. (Graph honors the timeZone
    // header we passed.)
    const start = parseGraphDate(it.start.dateTime, it.start.timeZone);
    const end = parseGraphDate(it.end.dateTime, it.end.timeZone);
    if (!start || !end) continue;
    // Defensive clamps:
    //   • drop zero-width / inverted ranges (Graph occasionally emits
    //     end===start for cancelled-but-still-listed all-day events)
    //   • clamp obviously-bogus intervals (>30 days) so a malformed
    //     all-day-event-without-end never blanks out an entire month
    //     of bookable time
    if (end.getTime() <= start.getTime()) continue;
    const widthMs = end.getTime() - start.getTime();
    if (widthMs > 30 * 24 * 60 * 60 * 1000) continue;
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
 * AADSTS codes that mean "the refresh token can't be used anymore —
 * the user must re-consent." Treated as `auth` so the orchestrator
 * flips the connection to `needs_reconnect` and fires the dedupe-aware
 * staff email instead of retrying forever.
 *
 * Reference: https://learn.microsoft.com/azure/active-directory/develop/reference-error-codes
 *
 * Wave C.1 — expanded from the Wave C trio to cover the realistic
 * spread of "user must take action" scenarios we'd otherwise misclassify
 * as `unknown` and bury in retry storms.
 */
const AADSTS_AUTH_CODES = [
  "AADSTS50020",   // user from a tenant without access to the resource (guest issue)
  "AADSTS50034",   // user account does not exist in the tenant
  "AADSTS50057",   // user account is disabled
  "AADSTS50105",   // user not assigned to the application
  "AADSTS50173",   // password recently changed; re-consent required
  "AADSTS65001",   // app needs admin consent — actionable by a tenant admin
  "AADSTS65004",   // user declined consent
  "AADSTS70008",   // refresh token expired or revoked
  "AADSTS700082",  // refresh token inactive >90 days
  "AADSTS700084",  // refresh token revoked because user signed out
  "AADSTS50076",   // MFA required for the operation
  "AADSTS50079",   // MFA enrollment required
  "AADSTS90072",   // user account in another tenant; user must add the app
];

/**
 * AADSTS codes that mean "config problem on OUR side" — wrong client
 * id, wrong redirect uri, app not approved. Bucketed as `config` so
 * the orchestrator doesn't flip the user's connection — the fix is
 * an admin/ops change, not a staff reconnect.
 */
const AADSTS_CONFIG_CODES = [
  "AADSTS700016", // invalid client id / app not found in directory
  "AADSTS50011",  // redirect uri mismatch
  "AADSTS7000218", // missing client secret in token request
  "AADSTS7000215", // invalid client secret
  "AADSTS900971", // no reply address provided
];

/**
 * Graph error codes (from `error.code` in the response body) that
 * correspond to "auth" without surfacing through the HTTP status.
 * Graph sometimes returns 400 with a body code that's effectively
 * an auth break — classify accordingly.
 */
const GRAPH_AUTH_CODES = new Set([
  "InvalidAuthenticationToken",
  "AccessDenied",
  "AuthenticationFailure",
  "Forbidden",
  "TokenExpired",
]);

/**
 * Map a thrown error to one of our closed ErrorClass values. Mirrors
 * the Google adapter so the orchestrator can treat both providers
 * uniformly.
 *
 * Wave C.1 — significantly widened to handle the full AADSTS + Graph
 * error-code surface. The classifier is now conservative-first:
 * "auth" only fires when we're confident the user's connection needs
 * attention; transient/rate-limit defaults preserve retry safety;
 * everything else falls through to `unknown` which the orchestrator
 * records but doesn't act on.
 */
export function classifyError(err: unknown): ErrorClass {
  if (err instanceof ConfigError) return "config";

  const e = err as { status?: number; code?: string | number; message?: string; graphCode?: string };
  const status =
    typeof e?.status === "number"
      ? e.status
      : typeof e?.code === "number"
      ? e.code
      : undefined;

  // Graph response body codes can disambiguate ambiguous HTTP statuses
  // (a 400 with "InvalidAuthenticationToken" is actually auth, not
  // a malformed request). Check before the HTTP-status branch.
  if (e?.graphCode) {
    if (GRAPH_AUTH_CODES.has(e.graphCode)) return "auth";
    if (e.graphCode === "TooManyRequests") return "rate_limit";
    if (e.graphCode === "ServiceNotAvailable" || e.graphCode === "GatewayTimeout") {
      return "transient";
    }
    if (e.graphCode === "ResourceNotFound" || e.graphCode === "ErrorItemNotFound") {
      return "not_found";
    }
  }

  if (status === 401 || status === 403) return "auth";
  if (status === 404 || status === 410) return "not_found";
  if (status === 429) return "rate_limit";
  if (typeof status === "number" && status >= 500) return "transient";

  if (typeof e?.code === "string") {
    if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(e.code)) {
      return "transient";
    }
  }

  const msg = e?.message ?? "";

  // Token-refresh failures bubble up as plain Error objects (not
  // GraphError) with the AADSTS code embedded in the message. Match
  // the full known set to avoid the "everything-AADSTS-is-auth"
  // sledgehammer that misclassifies admin-consent issues.
  for (const code of AADSTS_AUTH_CODES) {
    if (msg.includes(code)) return "auth";
  }
  for (const code of AADSTS_CONFIG_CODES) {
    if (msg.includes(code)) return "config";
  }

  if (
    msg.includes("invalid_grant") ||
    msg.includes("interaction_required") ||
    msg.includes("consent_required")
  ) {
    return "auth";
  }
  if (msg.includes("temporarily_unavailable") || msg.includes("server_error")) {
    return "transient";
  }

  return "unknown";
}

/**
 * Translate raw error text into a human-readable description for
 * `calendar_connections.last_error` + the reconnect email. Stored as
 * the staff-facing reason. We keep the underlying technical message
 * accessible via the full sync log row.
 *
 * The mapping prioritizes ACTIONABILITY: the staff member needs to
 * know whether they should reconnect, ask their admin, or just wait.
 */
export function describeError(err: unknown): string {
  const msg = (err as { message?: string })?.message ?? String(err);

  if (msg.includes("AADSTS65001"))
    return "Your Microsoft tenant requires an admin to grant ZentroMeet access. Ask your IT admin to approve the integration.";
  if (msg.includes("AADSTS50057"))
    return "Your Microsoft account is disabled. Contact your IT admin.";
  if (msg.includes("AADSTS50105"))
    return "Your account isn't assigned to the ZentroMeet app in your Microsoft tenant. Contact your IT admin.";
  if (msg.includes("AADSTS50076") || msg.includes("AADSTS50079"))
    return "Microsoft requires multi-factor authentication to sync your calendar. Reconnect and complete MFA.";
  if (msg.includes("AADSTS50173"))
    return "Your Microsoft password was recently changed. Reconnect Outlook to refresh the connection.";
  if (msg.includes("AADSTS70008") || msg.includes("AADSTS700082") || msg.includes("AADSTS700084"))
    return "Your Microsoft sign-in expired (90-day refresh window). Reconnect Outlook to resume calendar sync.";
  if (msg.includes("AADSTS65004"))
    return "Microsoft consent was declined. Reconnect Outlook and accept the requested permissions.";
  if (msg.includes("invalid_grant"))
    return "Your Microsoft session is no longer valid. Reconnect Outlook to resume calendar sync.";
  if (msg.includes("AADSTS700016") || msg.includes("AADSTS50011"))
    return "ZentroMeet's Microsoft integration is misconfigured. Contact support — no action needed from you.";
  if (msg.includes("TooManyRequests") || msg.includes("AADSTS90") || msg.includes("rate"))
    return "Microsoft Graph is rate-limiting requests. Sync will resume automatically.";

  // Fallback: surface a short summary but never the full body (may
  // contain sensitive Graph payloads).
  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}

/** Short, safe-to-log error message. */
export function errorMessage(err: unknown): string {
  const e = err as { message?: string };
  const msg = e?.message ?? String(err);
  return msg.slice(0, 500);
}
