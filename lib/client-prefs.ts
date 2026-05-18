/**
 * Per-customer communication preferences.
 *
 * Stored as a `jsonb` blob on customers.comm_prefs so we can extend the
 * shape without further migrations. The blob is unauthoritative on its
 * own — always run it through `normalizePrefs()` so missing keys take
 * defaults and unknown keys are dropped.
 *
 * Only the fields below are actually honored by the delivery pipeline
 * today. New keys can sit in the jsonb harmlessly while their consumer
 * is being built.
 */

export type ClientCommPrefs = {
  /** Master switch — receive any email about your bookings. */
  emailEnabled: boolean;
  /** Master switch — receive SMS about your bookings. */
  smsEnabled: boolean;
  /** Send the 24-hour-before email reminder. */
  reminder24hEnabled: boolean;
  /** Send the 1-hour-before email reminder. */
  reminder1hEnabled: boolean;
  /** Marketing opt-in. Defaults to false (opt-in, never opt-out). */
  marketingEnabled: boolean;
};

export const DEFAULT_PREFS: ClientCommPrefs = {
  emailEnabled: true,
  smsEnabled: false,
  reminder24hEnabled: true,
  reminder1hEnabled: true,
  marketingEnabled: false,
};

/**
 * Coerce a raw jsonb value into the canonical shape. Anything that
 * isn't a boolean for a known key falls back to its default.
 */
export function normalizePrefs(raw: unknown): ClientCommPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    emailEnabled:        typeof r.emailEnabled === "boolean" ? r.emailEnabled : DEFAULT_PREFS.emailEnabled,
    smsEnabled:          typeof r.smsEnabled === "boolean" ? r.smsEnabled : DEFAULT_PREFS.smsEnabled,
    reminder24hEnabled:  typeof r.reminder24hEnabled === "boolean" ? r.reminder24hEnabled : DEFAULT_PREFS.reminder24hEnabled,
    reminder1hEnabled:   typeof r.reminder1hEnabled === "boolean" ? r.reminder1hEnabled : DEFAULT_PREFS.reminder1hEnabled,
    marketingEnabled:    typeof r.marketingEnabled === "boolean" ? r.marketingEnabled : DEFAULT_PREFS.marketingEnabled,
  };
}

/**
 * Returns true if the email-reminder for a given window should be sent.
 *
 * @deprecated Prefer `decideSchedulingEmail()` / `isReminderAllowed()`
 *   from `lib/communications/email-rules`. Kept as a thin delegator so
 *   any pre-existing caller keeps working — but the canonical decision
 *   now lives in one place.
 */
export function shouldSendEmailReminder(
  prefs: ClientCommPrefs,
  windowHours: 24 | 1
): boolean {
  if (!prefs.emailEnabled) return false;
  return windowHours === 24 ? prefs.reminder24hEnabled : prefs.reminder1hEnabled;
}
