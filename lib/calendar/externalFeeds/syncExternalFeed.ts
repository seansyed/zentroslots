/**
 * Phase ICAL-3 — single-feed sync orchestrator.
 *
 * Drives one feed end-to-end:
 *   1. Decrypt URL.
 *   2. SSRF-defended fetch with ETag/If-Modified-Since.
 *   3. Parse the body into normalized events (bounded window +
 *      event count).
 *   4. Replace the cached event set in a single transaction
 *      (delete + bulk insert).
 *   5. Update feed row's last_synced_at / last_sync_status /
 *      last_error / etag / last_modified / next_sync_after.
 *
 * The function NEVER throws — every failure path returns a typed
 * result so the cron worker can keep going on the next feed in the
 * batch. Failures are persisted to the feed row so the staff UI
 * can surface them.
 *
 * Failure surface (typed by FeedSyncResult):
 *   • ssrf_blocked  — URL resolved to a private/reserved IP
 *   • fetch_failed  — network error, timeout, or non-2xx
 *   • too_large     — response exceeded 5 MB cap
 *   • parse_failed  — ICS structure unparseable
 *   • not_modified  — 304 from upstream; cache still valid
 *   • ok            — replaced N events
 */

import crypto from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  externalCalendarFeeds,
  externalFeedEvents,
} from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { safeFetch } from "@/lib/security/safeFetch";

import { parseICSFeed } from "./parseICSFeed";
import { classifyFeedContent } from "./feedContentClassifier";
import {
  FEED_MAX_EVENTS_PER_SYNC,
  type FeedSyncResult,
  type FeedSyncStatus,
  type NormalizedFeedEvent,
} from "./types";

/** Min seconds between successive syncs for the same feed. The
 *  cron worker schedules itself every 15 min, but the per-feed
 *  next_sync_after gate lets us back off individual feeds longer
 *  on repeated failure.
 *
 *  Phase ICAL-4 — apple_icloud gets a 30-min cadence by default.
 *  Apple's edge cache rejects more-aggressive polling with 503,
 *  and the calendar data itself rarely changes more than a few
 *  times an hour. Other providers stay on 15 min. */
const SUCCESS_BACKOFF_S_DEFAULT = 15 * 60;
const SUCCESS_BACKOFF_S_BY_PROVIDER: Record<string, number> = {
  apple_icloud: 30 * 60,
};
/** Failure backoff is adaptive — it scales with consecutive failure
 *  count to give the upstream room to recover without us hammering
 *  it. Capped at 4 hours so we never silently park a feed for a
 *  day. */
function failureBackoffSeconds(consecutiveFailures: number): number {
  // 1st failure: 1 h; 2nd: 2 h; 3rd: 4 h; cap at 4 h thereafter.
  const tier = Math.min(consecutiveFailures, 3);
  const base = 60 * 60 * Math.pow(2, Math.max(0, tier - 1));
  return Math.min(base, 4 * 60 * 60);
}

/** Sync jitter — add up to ±20% randomization to nextSyncAfter so
 *  we don't synchronize a thundering herd onto an upstream
 *  provider at the same wall-clock minute. */
function applyJitter(baseSeconds: number): number {
  const jitter = baseSeconds * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.max(60, Math.floor(baseSeconds + jitter));
}

type FeedRow = typeof externalCalendarFeeds.$inferSelect;

/** Persist the sync result onto the feed row. Idempotent.
 *
 *  Phase ICAL-4 — additionally writes consecutive_failures (resets
 *  on success, increments on failure), event_count (on success),
 *  and sync_duration_ms (always). nextSyncAfter uses provider-aware
 *  backoff + jitter to avoid thundering herd. */
async function persistSyncOutcome(
  feed: FeedRow,
  status: FeedSyncStatus,
  detail: {
    error?: string;
    etag?: string | null;
    lastModified?: string | null;
    eventCount?: number | null;
    durationMs?: number;
  },
): Promise<void> {
  const now = new Date();
  const isSuccess = status === "ok" || status === "not_modified";
  const newFailures = isSuccess ? 0 : feed.consecutiveFailures + 1;

  const baseSeconds = isSuccess
    ? SUCCESS_BACKOFF_S_BY_PROVIDER[feed.providerKind] ?? SUCCESS_BACKOFF_S_DEFAULT
    : failureBackoffSeconds(newFailures);
  const nextDelay = applyJitter(baseSeconds);

  const updates: Partial<typeof externalCalendarFeeds.$inferInsert> = {
    lastSyncedAt: now,
    lastSyncStatus: status,
    lastError: detail.error ?? null,
    etag: detail.etag ?? null,
    lastModified: detail.lastModified ?? null,
    nextSyncAfter: new Date(now.getTime() + nextDelay * 1000),
    syncDurationMs: detail.durationMs ?? null,
    consecutiveFailures: newFailures,
    updatedAt: now,
  };
  // Only update event_count on a real "ok" — 304 not_modified means
  // the cache is unchanged, so the previously-recorded count remains
  // accurate.
  if (status === "ok" && detail.eventCount !== undefined && detail.eventCount !== null) {
    updates.eventCount = detail.eventCount;
  }

  await db
    .update(externalCalendarFeeds)
    .set(updates)
    .where(eq(externalCalendarFeeds.id, feed.id));
}

/** Replace the cached event set for this feed in a single
 *  transaction. The DELETE-then-INSERT pattern is acceptable here:
 *    • Feeds are bounded to ≤2000 events.
 *    • Reads (the availability engine) are by (user_id, window),
 *      not by feed_id, so transient empties don't double-book.
 *    • Even if the txn aborts the prior events remain (no data
 *      loss on partial failure). */
async function writeFeedEvents(
  feed: FeedRow,
  events: NormalizedFeedEvent[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(externalFeedEvents)
      .where(eq(externalFeedEvents.feedId, feed.id));
    if (events.length === 0) return;
    // Cap defensively — parseICSFeed already enforces this, but the
    // public contract there could change. Belt + suspenders.
    const bounded = events.slice(0, FEED_MAX_EVENTS_PER_SYNC);
    // Drizzle .values() accepts an array; chunk if needed for older
    // pg drivers, but 2000 single-row inserts in a txn is fine on
    // node-postgres.
    const rows = bounded.map((e) => ({
      feedId: feed.id,
      tenantId: feed.tenantId,
      userId: feed.userId,
      sourceUid: e.sourceUid.slice(0, 255),
      startAt: e.startAt,
      endAt: e.endAt,
      allDay: e.allDay,
      summary: e.summary || null,
      status: e.status,
    }));
    // Chunk into 500-row batches to keep individual INSERTs bounded.
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(externalFeedEvents).values(rows.slice(i, i + 500));
    }
  });
}

/**
 * Sync a single feed. Returns the result for orchestrator logging;
 * also persists the outcome to the feed row inline.
 */
export async function syncExternalFeed(feed: FeedRow): Promise<FeedSyncResult> {
  const startedAt = Date.now();
  const dur = () => Date.now() - startedAt;

  // ─── 1. Decrypt the URL ─────────────────────────────────────────
  let url: string;
  try {
    const plain = decryptSecret(feed.feedUrlEncrypted);
    if (!plain) throw new Error("Empty URL after decrypt");
    url = plain;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Decrypt failed";
    await persistSyncOutcome(feed, "error", { error: message, durationMs: dur() });
    return { ok: false, status: "error", error: message };
  }

  // ─── 2. SSRF-defended fetch with conditional headers ────────────
  const fetched = await safeFetch(url, {
    ifNoneMatch: feed.etag,
    ifModifiedSince: feed.lastModified,
  });
  if (!fetched.ok) {
    const status: FeedSyncStatus =
      fetched.reason === "ssrf_blocked"
        ? "ssrf_blocked"
        : fetched.reason === "too_large"
          ? "too_large"
          : "fetch_failed";
    await persistSyncOutcome(feed, status, {
      error: fetched.message,
      durationMs: dur(),
    });
    return { ok: false, status, error: fetched.message };
  }

  // 304 Not Modified — keep the cached events, just bump
  // last_synced_at + persist ETag/Last-Modified (the upstream may
  // have rotated either while keeping the body identical).
  if (fetched.status === 304) {
    await persistSyncOutcome(feed, "not_modified", {
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      durationMs: dur(),
    });
    return {
      ok: true,
      status: "not_modified",
      etag: fetched.etag,
      lastModified: fetched.lastModified,
    };
  }

  // ─── 2.5. Content shape pre-check (Phase ICAL-4) ────────────────
  // Detect HTML masquerade / expired share / password gate BEFORE
  // we hand the body to node-ical so the user gets a precise error.
  // The ICS parser would otherwise silently return 0 events for
  // these cases — far worse UX than a clear "this URL returns HTML"
  // message.
  const verdict = classifyFeedContent(fetched.bodyText, null);
  if (
    verdict.classification === "html_masquerade" ||
    verdict.classification === "password_protected" ||
    verdict.classification === "expired_share"
  ) {
    await persistSyncOutcome(feed, "parse_failed", {
      error: verdict.userMessage,
      durationMs: dur(),
    });
    return { ok: false, status: "parse_failed", error: verdict.userMessage };
  }

  // ─── 3. Parse ───────────────────────────────────────────────────
  const parsed = parseICSFeed(fetched.bodyText);
  // We accept zero events (some calendars genuinely have no events
  // in the window). Only fail if the parser threw a structural error
  // (encoded as a warning that mentions "parseICS threw").
  const fatalParse = parsed.warnings.some((w) => w.startsWith("parseICS threw"));
  if (fatalParse) {
    const msg = parsed.warnings.join("; ").slice(0, 1000);
    await persistSyncOutcome(feed, "parse_failed", {
      error: msg,
      durationMs: dur(),
    });
    return { ok: false, status: "parse_failed", error: msg };
  }

  // ─── 4. Replace cached events ───────────────────────────────────
  try {
    await writeFeedEvents(feed, parsed.events);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "DB write failed";
    await persistSyncOutcome(feed, "error", {
      error: msg,
      durationMs: dur(),
    });
    return { ok: false, status: "error", error: msg };
  }

  // ─── 5. Persist success ─────────────────────────────────────────
  let detailMessage: string | undefined;
  if (parsed.recurrenceClamped) {
    detailMessage = `Truncated to ${FEED_MAX_EVENTS_PER_SYNC} events (RRULE expansion limit)`;
  }
  await persistSyncOutcome(feed, "ok", {
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    error: detailMessage,
    eventCount: parsed.events.length,
    durationMs: dur(),
  });

  return {
    ok: true,
    status: "ok",
    events: parsed.events,
    etag: fetched.etag,
    lastModified: fetched.lastModified,
  };
}

// ─── Hash helper for dedup ────────────────────────────────────────────

/** SHA-256 hex of the normalized URL. Used for the unique index on
 *  (tenant_id, user_id, normalized_feed_hash). NOT a secret — the
 *  URL is in the table next to it (encrypted). The hash is what
 *  lets us dedup without needing to decrypt every row on insert. */
export function normalizedFeedHash(normalizedUrl: string): string {
  return crypto.createHash("sha256").update(normalizedUrl, "utf8").digest("hex");
}
