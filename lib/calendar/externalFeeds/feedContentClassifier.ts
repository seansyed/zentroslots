/**
 * Phase ICAL-4 — content-shape classifier for fetched feed bodies.
 *
 * Detects common failure modes BEFORE we hand the body off to
 * node-ical, so the user sees a precise error message instead of
 * a generic "parse failed":
 *
 *   • html_masquerade       — provider returned an HTML error page
 *                             (login wall, "this calendar is
 *                             private", 5xx maintenance page).
 *   • password_protected    — body looks like a login form
 *                             (rare with raw .ics URLs but does
 *                             happen for Exchange OWA-style endpoints).
 *   • expired_share         — provider returned an ICS document but
 *                             with zero VEVENT lines AND a body
 *                             that mentions "revoked" / "expired".
 *   • empty_calendar        — well-formed VCALENDAR with zero
 *                             events. Not a failure — could be a
 *                             genuinely empty calendar — but worth
 *                             surfacing as a hint.
 *   • valid                 — looks like a parseable ICS body.
 *
 * Pure function. Inputs: response body string + optional
 * Content-Type header. No DB, no I/O.
 */

export type FeedContentClass =
  | "valid"
  | "html_masquerade"
  | "password_protected"
  | "expired_share"
  | "empty_calendar";

export type FeedContentVerdict = {
  classification: FeedContentClass;
  /** User-facing reason — appears in the staff UI when the feed
   *  errors. Plain English, no jargon. */
  userMessage: string;
};

/** Read the first ~256 bytes and decide. We cap inspection length
 *  because some HTML responses can be megabytes — we don't need
 *  more than the first heading to know the shape. */
function head(body: string, n = 4096): string {
  return body.length > n ? body.slice(0, n) : body;
}

export function classifyFeedContent(
  body: string,
  contentType?: string | null,
): FeedContentVerdict {
  const trimmed = body.trimStart();
  const sample = head(trimmed);
  const lower = sample.toLowerCase();

  // ─── HTML masquerade detection ────────────────────────────────
  // node-ical will happily try to parse HTML and silently return 0
  // events — far worse than a clear error. The strongest signal
  // is the response body STARTING with markup rather than the
  // VCALENDAR sentinel.
  const startsWithHtml =
    sample.startsWith("<!DOCTYPE") ||
    sample.startsWith("<html") ||
    sample.startsWith("<HTML") ||
    sample.startsWith("<?xml") ||
    sample.startsWith("<rss") ||
    sample.startsWith("<feed");
  const claimsHtml =
    !!contentType && /text\/html|application\/xhtml/i.test(contentType);

  if (startsWithHtml || claimsHtml) {
    // Look for a password-form sub-signal before we commit to
    // generic html_masquerade.
    if (
      lower.includes('type="password"') ||
      lower.includes("type='password'") ||
      lower.includes("sign in") ||
      lower.includes("sign-in") ||
      lower.includes("login") ||
      lower.includes("authenticate")
    ) {
      return {
        classification: "password_protected",
        userMessage:
          "This feed requires authentication. Most calendar providers expose a separate PUBLIC share URL — check your provider's settings and use that instead.",
      };
    }
    return {
      classification: "html_masquerade",
      userMessage:
        "The URL returned an HTML page instead of a calendar feed. The share link may have expired, or you may have pasted the calendar's web view URL instead of its .ics URL.",
    };
  }

  // ─── ICS-shaped but problematic ──────────────────────────────
  // Apple iCloud sometimes returns a 200 with a VCALENDAR document
  // that contains a single PRODID line and no events when a share
  // is revoked.
  if (!sample.includes("BEGIN:VCALENDAR")) {
    return {
      classification: "html_masquerade",
      userMessage:
        "The URL did not return a calendar feed. Double-check that you copied the iCal/ICS link (it usually ends with .ics) and not a web view URL.",
    };
  }

  // From here we have a VCALENDAR body. Check for events.
  const hasEvents = body.includes("BEGIN:VEVENT");
  if (!hasEvents) {
    // Check the body for "revoked" / "expired" / "no longer
    // shared" wording — Apple historically embeds this as a
    // X-APPLE-CALENDAR-COLOR-only document with a SUMMARY field
    // that explains the state. The signal is fuzzy; we only flip
    // to expired_share when wording is clear.
    if (
      /revoked|no longer (shared|available)|expired/i.test(body.slice(0, 4096))
    ) {
      return {
        classification: "expired_share",
        userMessage:
          "The share link appears to have been revoked or expired. Re-share the calendar from the source provider and update the URL here.",
      };
    }
    return {
      classification: "empty_calendar",
      userMessage:
        "Calendar fetched successfully but contains no events. This isn't necessarily an error — the calendar may genuinely be empty.",
    };
  }

  return {
    classification: "valid",
    userMessage: "Feed parsed successfully.",
  };
}
