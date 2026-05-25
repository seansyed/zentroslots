/**
 * Phase ICAL-3 — typed contracts for external ICS feed import.
 *
 * "External feed" = an inbound subscription URL pasted by a staff
 * member (Apple iCloud share, Outlook published, Google iCal, etc.).
 * The contract is intentionally narrow:
 *
 *   • read-only — we NEVER write to the source
 *   • busy-only — we don't surface the events anywhere customer-
 *     facing; they only block slots in the availability engine
 *   • sanitized — every text field is stripped of control chars
 *     and bounded in length before insertion
 *
 * Compare with Phase ICAL-2 (lib/calendar/feeds/*) which is the
 * OPPOSITE direction (we EMIT an .ics feed; staff subscribes their
 * Apple Calendar to OUR URL). The two modules never interact.
 */

/** Coarse hint inferred from the feed URL hostname. Used only for
 *  UI affordance (icon, label). The sync engine treats every kind
 *  identically. */
export type FeedProviderKind =
  | "apple_icloud"
  | "outlook"
  | "google"
  | "exchange"
  | "other";

/** Status the sync orchestrator writes after each fetch attempt. */
export type FeedSyncStatus =
  | "ok"
  | "not_modified"   // 304 from upstream; cache still valid
  | "pending"
  | "fetch_failed"   // network / timeout / non-2xx
  | "parse_failed"   // body fetched but ICS unparseable
  | "too_large"      // size cap exceeded
  | "ssrf_blocked"   // URL resolved to a private/reserved IP
  | "rate_limited"   // local backoff applied (not implemented yet)
  | "error";         // catch-all for unexpected exceptions

/** One normalized busy event from an external feed. The only fields
 *  the availability engine reads are start/end + status. The summary
 *  is held for the staff calendar render (not customer-facing). */
export type NormalizedFeedEvent = {
  sourceUid: string;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  /** Sanitized title. May be empty when the upstream stripped it
   *  (some Apple shared calendars deliberately strip SUMMARY). */
  summary: string;
  /** RFC 5545 STATUS — when "CANCELLED" we drop the event entirely
   *  rather than block on it (the user cancelled it on the source
   *  calendar). */
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED" | "UNKNOWN";
  /** RFC 5545 TRANSP — "TRANSPARENT" means the source calendar
   *  marked the event as free-time (e.g. an all-day "On vacation"
   *  reminder that shouldn't block office hours). We drop these. */
  transparent: boolean;
};

/** Result of one sync attempt. Caller (the orchestrator) is responsible
 *  for persisting the status + ETag back to the feed row. */
export type FeedSyncResult =
  | {
      ok: true;
      status: "not_modified";
      /** No event mutation; ETag may still need updating. */
      etag: string | null;
      lastModified: string | null;
    }
  | {
      ok: true;
      status: "ok";
      events: NormalizedFeedEvent[];
      etag: string | null;
      lastModified: string | null;
    }
  | {
      ok: false;
      status: Exclude<FeedSyncStatus, "ok" | "not_modified">;
      error: string;
    };

/** Window the availability engine reads from. Bounded so the
 *  recurrence expander can't blow up on a pathological RRULE. */
export const FEED_IMPORT_WINDOW_DAYS_BACK = 30;
export const FEED_IMPORT_WINDOW_DAYS_FORWARD = 180;

/** Hard cap on materialized events per feed. Anything past this is
 *  truncated (we sort by startAt ASC, take the first N). Defends
 *  against unbounded RRULE expansion. */
export const FEED_MAX_EVENTS_PER_SYNC = 2000;
