/**
 * Phase ICAL-4 — pure feed health classifier.
 *
 * Maps the raw feed row state (last_synced_at, last_sync_status,
 * consecutive_failures, is_enabled) onto a small, stable enum that
 * the UI + admin dashboard + alert engine all share.
 *
 * Pure function — no DB, no Date.now() side effects. Pass `now` to
 * deterministically test boundary conditions.
 *
 * State definitions:
 *   • disabled  — is_enabled=false. Highest precedence.
 *   • error     — consecutive_failures ≥ ERROR_FAILURE_THRESHOLD,
 *                 or the last sync status is a hard failure
 *                 category (ssrf_blocked, too_large).
 *   • stale     — last successful sync ≥ STALE_HOURS ago. Includes
 *                 the case where there's NEVER been a successful
 *                 sync but the feed is older than STALE_HOURS.
 *   • warning   — sync is overdue but not yet stale, OR a transient
 *                 failure has occurred without crossing the error
 *                 threshold yet.
 *   • healthy   — within expected cadence; last sync was ok or
 *                 not_modified within WARN_MINUTES.
 *
 * Order of evaluation matters — once a feed matches a more-severe
 * state we don't downgrade it.
 */

import type { FeedSyncStatus } from "./types";

export type FeedHealthState =
  | "healthy"
  | "warning"
  | "stale"
  | "error"
  | "disabled";

/** Public-shape input the classifier consumes. We deliberately
 *  accept a NARROW slice of the feed row so this module is unit-
 *  testable without a DB schema dependency. */
export type FeedHealthInput = {
  isEnabled: boolean;
  lastSyncedAt: Date | null;
  lastSyncStatus: FeedSyncStatus | string | null;
  consecutiveFailures: number;
  createdAt: Date;
};

export type FeedHealth = {
  state: FeedHealthState;
  /** Human-readable explanation surfaced in tooltips + the admin
   *  observability endpoint. Never null. */
  reason: string;
  /** Color hint for the UI badge. The UI may override but it's
   *  convenient to have a single source of truth. */
  tone: "green" | "amber" | "red" | "slate";
  /** Age in milliseconds since the last successful sync. null when
   *  the feed has never synced successfully. */
  ageMs: number | null;
};

// ─── Tunables ─────────────────────────────────────────────────────────

/** Sync cadence target. The cron runs every 15 min; we declare
 *  "warning" once we've missed by more than 2x that. */
const WARN_MINUTES = 30;
/** Threshold for transitioning a feed into "stale". 24h matches
 *  the typical user expectation that a calendar feed is "broken"
 *  if it hasn't refreshed in a day. */
const STALE_HOURS = 24;
/** Consecutive failure count that flips the feed into "error".
 *  Three strikes is the standard pattern — transient hiccups stay
 *  warning. */
const ERROR_FAILURE_THRESHOLD = 3;
/** Failure categories that flip the feed straight to "error" on
 *  the first occurrence (no three-strike grace). These are
 *  unrecoverable on the user's side without action. */
const HARD_FAILURE_STATUSES = new Set<FeedSyncStatus | string>([
  "ssrf_blocked",
  "too_large",
]);

// ─── Classifier ──────────────────────────────────────────────────────

export function classifyFeedHealth(
  input: FeedHealthInput,
  now: Date = new Date(),
): FeedHealth {
  // Rule 1 — disabled is absolute, wins over everything.
  if (!input.isEnabled) {
    return {
      state: "disabled",
      reason: "Feed is disabled. Re-enable to resume syncing.",
      tone: "slate",
      ageMs: null,
    };
  }

  const ageMs = input.lastSyncedAt
    ? now.getTime() - input.lastSyncedAt.getTime()
    : null;
  const ageHours = ageMs !== null ? ageMs / 3_600_000 : null;
  const ageMinutes = ageMs !== null ? ageMs / 60_000 : null;
  const sinceCreatedMs = now.getTime() - input.createdAt.getTime();

  // Rule 2 — hard failure status always wins, even on first
  // occurrence (these aren't transient hiccups).
  if (
    input.lastSyncStatus &&
    HARD_FAILURE_STATUSES.has(input.lastSyncStatus)
  ) {
    return {
      state: "error",
      reason:
        input.lastSyncStatus === "ssrf_blocked"
          ? "URL resolved to a private or reserved address and was refused."
          : "Feed exceeded the 5 MB size limit.",
      tone: "red",
      ageMs,
    };
  }

  // Rule 3 — three consecutive failures = error.
  if (input.consecutiveFailures >= ERROR_FAILURE_THRESHOLD) {
    return {
      state: "error",
      reason: `${input.consecutiveFailures} consecutive sync failures. Check the feed URL and the source provider.`,
      tone: "red",
      ageMs,
    };
  }

  // Rule 4 — no successful sync ever AND the feed is older than
  // the stale threshold. Newly-added feeds that haven't completed
  // their first sync get a grace window equal to STALE_HOURS.
  if (input.lastSyncedAt === null) {
    if (sinceCreatedMs > STALE_HOURS * 3_600_000) {
      return {
        state: "stale",
        reason: "No successful sync since the feed was added.",
        tone: "amber",
        ageMs: null,
      };
    }
    // Grace period — show as warning, not stale.
    return {
      state: "warning",
      reason: "Awaiting first successful sync.",
      tone: "amber",
      ageMs: null,
    };
  }

  // Rule 5 — last successful sync was a hard while ago.
  if (ageHours !== null && ageHours >= STALE_HOURS) {
    return {
      state: "stale",
      reason: `No successful sync for ${Math.floor(ageHours)} hours.`,
      tone: "amber",
      ageMs,
    };
  }

  // Rule 6 — overdue but not stale yet, OR there has been a recent
  // transient failure.
  if (
    (ageMinutes !== null && ageMinutes > WARN_MINUTES) ||
    input.consecutiveFailures > 0
  ) {
    const reason =
      input.consecutiveFailures > 0
        ? `Last sync failed (${input.consecutiveFailures} attempt${input.consecutiveFailures === 1 ? "" : "s"}).`
        : `Sync overdue by ${Math.floor(ageMinutes ?? 0) - WARN_MINUTES} min.`;
    return { state: "warning", reason, tone: "amber", ageMs };
  }

  // Default — healthy.
  return {
    state: "healthy",
    reason: "Syncing normally.",
    tone: "green",
    ageMs,
  };
}

// ─── Exports of the tunables for tests + admin UI ─────────────────────

export const FEED_HEALTH_THRESHOLDS = {
  WARN_MINUTES,
  STALE_HOURS,
  ERROR_FAILURE_THRESHOLD,
} as const;
