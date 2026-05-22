/**
 * Shared types for the external calendar sync layer.
 *
 * Provider is a closed union — adding a new provider requires touching
 * lib/calendar/sync.ts (the orchestrator) and implementing the
 * CalendarProviderAdapter interface in a new module. The DB stores
 * provider as varchar so future additions don't need migrations.
 *
 * Wave C — `microsoft` joined the union. Conceptually it covers both
 * Outlook calendar reads/writes AND Teams online-meeting links: a
 * single Graph API call creates an event with `isOnlineMeeting: true`
 * and gets back the Teams join URL alongside the event id. So one
 * connection (and one provider row in calendar_connections) services
 * both responsibilities — no separate "teams" provider entry needed.
 */

/**
 * Wave D — `zoom` joined the provider union, but conceptually it's a
 * SIDE-CAR MEETING PROVIDER, not a calendar provider:
 *
 *   • Google + Microsoft own BOTH the calendar event AND the embedded
 *     conferencing link (Meet, Teams) in a single API call.
 *   • Zoom only owns the meeting; the staff's calendar event lives
 *     wherever their primary calendar is (Google, Outlook, or — if
 *     they have no calendar connection — nowhere).
 *
 * We store Zoom in the SAME calendar_connections table for
 * encrypted-token reuse + connection-health symmetry, but the
 * orchestrator dispatches Zoom DIFFERENTLY:
 *
 *   • `pickConnectionForWrite` NEVER returns a Zoom connection as
 *     the primary calendar (Zoom can't host a calendar event).
 *   • A separate `pickMeetingProvider` helper consults Zoom when the
 *     service's `videoProvider === "zoom"`, and the orchestrator
 *     wires the Zoom join URL into the calendar provider's event as
 *     a side-car operation.
 *   • Freebusy reads skip Zoom rows — there's no Zoom freebusy API.
 *
 * This keeps the orchestrator additive and avoids a separate
 * "MeetingProvider" union that would fragment the type system.
 */
export type CalendarProvider = "google" | "microsoft" | "zoom";

export const CALENDAR_PROVIDERS: readonly CalendarProvider[] = ["google", "microsoft", "zoom"] as const;

/** Providers that own a real calendar (event create/update/delete +
 *  freebusy reads). Zoom is excluded — it's a meeting-only side-car. */
export const CALENDAR_HOST_PROVIDERS: readonly CalendarProvider[] = ["google", "microsoft"] as const;

/** Providers that own a meeting URL (conferencing). Today all three;
 *  for Google + Microsoft the meeting is embedded in the calendar
 *  event API call, for Zoom it's a separate side-car create. */
export const MEETING_PROVIDERS: readonly CalendarProvider[] = ["google", "microsoft", "zoom"] as const;

/** Type guard for runtime values arriving from DB or URL params. */
export function isCalendarProvider(v: unknown): v is CalendarProvider {
  return v === "google" || v === "microsoft" || v === "zoom";
}

/** Subset guard used by orchestrator pickConnectionForWrite — only
 *  these providers can host a calendar event. */
export function isCalendarHostProvider(
  v: CalendarProvider,
): v is "google" | "microsoft" {
  return v === "google" || v === "microsoft";
}

export type ConnectionStatus =
  | "active"
  | "needs_reconnect"
  | "disconnected";

export type SyncKind =
  | "create"
  | "update"
  | "delete"
  | "freebusy"
  | "connect"
  | "disconnect";

export type SyncStatus = "ok" | "failed" | "skipped";

/**
 * Closed set of failure classifications. Used to decide whether to flip
 * the connection to 'needs_reconnect' (auth), retry later (transient,
 * rate_limit), or give up (config, not_found, unknown).
 */
export type ErrorClass =
  | "auth"        // 401 / 403 → token revoked or scopes changed
  | "rate_limit"  // 429 → back off; do not flip status
  | "not_found"   // 404 → event already gone server-side; treat as success
  | "transient"   // 5xx → retry-eligible; do not flip status
  | "config"      // missing env / OAuth client misconfig
  | "unknown";

export type BusyInterval = { start: Date; end: Date };

/**
 * Inputs for the provider-agnostic event create call. The orchestrator
 * builds this from a Booking row + ancillaries and hands it to the
 * provider adapter, which only knows how to talk to its own API.
 */
export type ExternalEventDraft = {
  summary: string;
  description: string;
  startAt: Date;
  endAt: Date;
  organizerEmail: string;
  organizerName: string;
  attendeeEmail: string;
  attendeeName: string;
  /** Whether to ask the provider to create a video conference link
   *  (Google Meet / Teams). Provider may ignore if not supported. */
  videoConference: boolean;
};

/**
 * What the provider returns on successful create.
 */
export type ExternalEventResult = {
  eventId: string;
  meetLink: string | null;
};
