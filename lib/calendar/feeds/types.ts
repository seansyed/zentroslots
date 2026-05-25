/**
 * Phase ICAL-2 — typed contracts for the staff calendar subscription
 * feed (webcal://) infrastructure.
 *
 * Why a separate module from lib/calendar/ics/* (Phase ICAL-1):
 *   • Different output shape — feeds are MULTI-event VCALENDAR
 *     documents with METHOD:PUBLISH, not single-event iTIP invites.
 *   • Different lifecycle — feed tokens persist for months and must
 *     be individually revocable; booking tokens are short-lived JWTs.
 *   • Different access model — feeds carry NO attendee/RSVP info
 *     (one-way subscription), so the iTIP fields IcsEvent surfaces
 *     would be confusing dead weight here.
 *
 * Phase ICAL-1 primitives (escape5545, formatLocal, formatUtc,
 * buildVTimezone, foldLine, bookingUid, bookingSequence) are REUSED;
 * the feed builder just composes them differently.
 */

/**
 * One event in a staff feed. Strictly less surface than IcsEvent:
 *   • No method (the whole feed is METHOD:PUBLISH)
 *   • No attendees (one-way subscription; no RSVP)
 *   • No alarms (Apple Calendar honors per-subscription alarm
 *     defaults; we don't impose our own)
 *
 * Source-agnostic: backed by bookings, calendar_events, or
 * group_sessions in the adapter layer. The feed renderer only sees
 * this shape.
 */
export type FeedEvent = {
  /** Stable UID — must match Phase ICAL-1's `bookingUid(...)` format
   *  for bookings so iPhone Calendar deduplicates the .ics-emailed
   *  invite against the subscription-rendered event. For non-booking
   *  sources (internal meeting, group session), uses a sibling
   *  `eventId@zentromeet` format. */
  uid: string;

  /** Monotonically advancing integer. Bumped on every update. Phase
   *  ICAL-1's `bookingSequence(updatedAt)` is the canonical derivation
   *  for booking-sourced events. */
  sequence: number;

  startAt: Date;
  endAt: Date;
  /** IANA timezone (e.g. "America/New_York"). Resolves to a TZID-
   *  qualified DTSTART/DTEND and triggers an inline VTIMEZONE block. */
  timezone: string;

  /** Short title shown on the calendar grid. Sanitized by
   *  escape5545 at emit time. */
  summary: string;

  /** Longer body shown in the event detail view. Optional. */
  description?: string;

  /** Free-form location. Typically the meeting URL or a room name. */
  location?: string;

  /** Optional ORGANIZER. Surfaced as "Organizer" in Apple Calendar
   *  but NOT actionable (one-way feed; no reply path). */
  organizer?: { email: string; name?: string | null };

  /** Last modification time, emitted as LAST-MODIFIED. Apple uses
   *  this + SEQUENCE for "should I update?" decisions. */
  lastModified: Date;
};

/**
 * Persistent record backing a webcal:// URL. Plaintext token is NEVER
 * stored — only the SHA-256 hex hash. The plaintext is returned to
 * the caller ONCE on create/rotate and discarded by the server.
 */
export type StaffFeedToken = {
  id: string;
  tenantId: string;
  userId: string;
  /** Plaintext token. Present ONLY on the response from
   *  generate/rotate. NEVER present on any read API. */
  rawToken?: string;
  /** SHA-256 hex of the plaintext. Stored at rest; used for lookup. */
  tokenHash: string;
  createdAt: Date;
  lastAccessedAt: Date | null;
  lastAccessedIp: string | null;
  revokedAt: Date | null;
  revokedReason: string | null;
};

/**
 * Result of generating a feed VCALENDAR. Returned by
 * generateStaffFeed and consumed directly by the public endpoint.
 */
export type GeneratedFeed = {
  /** The full VCALENDAR document. CRLF line endings, line-folded at
   *  75 octets. Ready to write to the response body. */
  body: string;
  /** Standard text/calendar content type with method=PUBLISH. */
  contentType: string;
  /** Suggested filename — staff-scoped so a user with multiple
   *  workspace subscriptions can tell them apart on disk. */
  filename: string;
  /** ETag value derived from the body content (sha256 hex slice).
   *  Used for If-None-Match → 304 cache validation. */
  etag: string;
  /** Latest event lastModified across the feed (or token createdAt
   *  if the feed is empty). Used for Last-Modified + If-Modified-
   *  Since cache validation. */
  lastModified: Date;
  /** Number of events included. Useful for observability + the
   *  Content-Disposition filename hint. Not surfaced in the body. */
  eventCount: number;
};

/**
 * Reasons a token may be revoked. Stored verbatim in the
 * revoked_reason column for audit traces.
 */
export type RevokeReason =
  | "rotated"           // Replaced by a fresh token on the same row
  | "user_revoke"       // Staff manually revoked their own
  | "admin_revoke"      // Admin acted on staff's behalf
  | "staff_offboarded"; // User account removed/disabled
