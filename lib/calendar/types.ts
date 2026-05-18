/**
 * Shared types for the external calendar sync layer.
 *
 * Provider is a closed union — adding a new provider requires touching
 * lib/calendar/sync.ts (the orchestrator) and implementing the
 * CalendarProviderAdapter interface in a new module. The DB stores
 * provider as varchar so future additions don't need migrations.
 */

export type CalendarProvider = "google";
// Future: | "outlook" | "office365"

export const CALENDAR_PROVIDERS: readonly CalendarProvider[] = ["google"] as const;

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
