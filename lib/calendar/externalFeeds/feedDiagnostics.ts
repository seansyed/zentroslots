/**
 * Phase ICAL-4 — support-safe diagnostics formatter.
 *
 * Builds a redacted, exportable JSON payload describing a single
 * feed's recent sync behavior. Used by:
 *   • The per-feed diagnostics endpoint (staff UI "Diagnostics" panel)
 *   • Customer support exports — when a user opens a ticket about a
 *     feed not syncing, support can pull this payload without ever
 *     seeing the plaintext URL or any cached personal events
 *
 * Hard guarantees:
 *   • No URL, no ETag content, no token, no email, no event summary
 *     is ever included.
 *   • Only the URL HOST is exposed (the host alone is metadata —
 *     the secret-bearing parts of an iCloud share URL are the path
 *     segments).
 *   • Plaintext-decryption of the stored URL happens INSIDE this
 *     module so callers can't leak the plaintext by accident.
 *
 * The "fields" array structure mirrors common support-export
 * conventions so it can be pasted into Linear/Zendesk tickets
 * directly.
 */

import { decryptSecret } from "@/lib/crypto";
import { classifyFeedHealth, type FeedHealth } from "./feedHealth";
import type { FeedProviderKind, FeedSyncStatus } from "./types";

export type FeedDiagnosticsInput = {
  id: string;
  tenantId: string;
  userId: string;
  providerLabel: string;
  providerKind: FeedProviderKind | string;
  feedUrlEncrypted: string;
  isEnabled: boolean;
  lastSyncedAt: Date | null;
  lastSyncStatus: FeedSyncStatus | string | null;
  lastError: string | null;
  etag: string | null;
  lastModified: string | null;
  nextSyncAfter: Date;
  syncDurationMs: number | null;
  eventCount: number | null;
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
};

export type FeedDiagnostics = {
  feedId: string;
  /** Phase ICAL-4 health classification. */
  health: FeedHealth;
  /** Provider classification (apple_icloud / outlook / google / etc.). */
  providerKind: string;
  /** Human label the user gave the feed (the input is sanitized
   *  upstream — included as-is for support context). */
  providerLabel: string;
  /** ONLY the host of the feed URL. Path + query + fragment are
   *  redacted to keep iCloud share secrets out of support exports. */
  urlHost: string;
  /** Whether the upstream supports conditional GET (ETag /
   *  Last-Modified). We never expose the values themselves, only
   *  the boolean. */
  supportsETag: boolean;
  supportsLastModified: boolean;
  /** Most recent run summary. */
  lastRun: {
    at: string | null;
    status: string | null;
    durationMs: number | null;
    eventCount: number | null;
    error: string | null;
  };
  consecutiveFailures: number;
  nextSyncAt: string;
  /** Counts from the related external_feed_events rows. Caller
   *  populates if they have a join already; this module never
   *  hits the DB to fetch them. */
  cachedEventCount?: number;
  /** ISO timestamps for support to correlate with logs. */
  createdAt: string;
  updatedAt: string;
};

/** Pull the bare host out of an encrypted URL without ever
 *  exposing the rest. Falls back to "(unknown)" on any failure
 *  (revoked key, malformed URL, etc.) — diagnostics ALWAYS work
 *  even when the feed itself is broken. */
function safeHost(encryptedUrl: string): string {
  try {
    const plain = decryptSecret(encryptedUrl);
    if (!plain) return "(unknown)";
    const u = new URL(plain);
    return u.hostname || "(unknown)";
  } catch {
    return "(unknown)";
  }
}

/** Build a support-safe diagnostics payload for one feed. The
 *  returned object is safe to log, email, paste into a Slack
 *  channel, or include verbatim in a customer-facing API response. */
export function buildFeedDiagnostics(
  feed: FeedDiagnosticsInput,
  opts: { cachedEventCount?: number; now?: Date } = {},
): FeedDiagnostics {
  const now = opts.now ?? new Date();
  const health = classifyFeedHealth(
    {
      isEnabled: feed.isEnabled,
      lastSyncedAt: feed.lastSyncedAt,
      lastSyncStatus: feed.lastSyncStatus,
      consecutiveFailures: feed.consecutiveFailures,
      createdAt: feed.createdAt,
    },
    now,
  );

  return {
    feedId: feed.id,
    health,
    providerKind: feed.providerKind,
    providerLabel: feed.providerLabel,
    urlHost: safeHost(feed.feedUrlEncrypted),
    supportsETag: !!feed.etag,
    supportsLastModified: !!feed.lastModified,
    lastRun: {
      at: feed.lastSyncedAt?.toISOString() ?? null,
      status: feed.lastSyncStatus ?? null,
      durationMs: feed.syncDurationMs,
      eventCount: feed.eventCount,
      // last_error is short by design (truncated in the orchestrator
      // before persist) so we surface as-is. If a future change
      // expanded the column, we'd want to truncate here too.
      error: feed.lastError ? feed.lastError.slice(0, 500) : null,
    },
    consecutiveFailures: feed.consecutiveFailures,
    nextSyncAt: feed.nextSyncAfter.toISOString(),
    cachedEventCount: opts.cachedEventCount,
    createdAt: feed.createdAt.toISOString(),
    updatedAt: feed.updatedAt.toISOString(),
  };
}
