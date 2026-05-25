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
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  externalCalendarFeeds,
  externalFeedEvents,
} from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { safeFetch } from "@/lib/security/safeFetch";

import { parseICSFeed } from "./parseICSFeed";
import {
  FEED_MAX_EVENTS_PER_SYNC,
  type FeedSyncResult,
  type FeedSyncStatus,
  type NormalizedFeedEvent,
} from "./types";

/** Min seconds between successive syncs for the same feed. The
 *  cron worker schedules itself every 15 min, but the per-feed
 *  next_sync_after gate lets us back off individual feeds longer
 *  on repeated failure. */
const SUCCESS_BACKOFF_S = 15 * 60; // 15 minutes after a clean sync
const FAILURE_BACKOFF_S = 60 * 60; // 1 hour after a failure (give upstream time to recover)

type FeedRow = typeof externalCalendarFeeds.$inferSelect;

/** Persist the sync result onto the feed row. Idempotent. */
async function persistSyncOutcome(
  feedId: string,
  status: FeedSyncStatus,
  detail: { error?: string; etag?: string | null; lastModified?: string | null },
): Promise<void> {
  const now = new Date();
  const nextDelay = status === "ok" || status === "not_modified"
    ? SUCCESS_BACKOFF_S
    : FAILURE_BACKOFF_S;
  await db
    .update(externalCalendarFeeds)
    .set({
      lastSyncedAt: now,
      lastSyncStatus: status,
      lastError: detail.error ?? null,
      etag: detail.etag ?? null,
      lastModified: detail.lastModified ?? null,
      nextSyncAfter: new Date(now.getTime() + nextDelay * 1000),
      updatedAt: now,
    })
    .where(eq(externalCalendarFeeds.id, feedId));
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
  // ─── 1. Decrypt the URL ─────────────────────────────────────────
  let url: string;
  try {
    const plain = decryptSecret(feed.feedUrlEncrypted);
    if (!plain) throw new Error("Empty URL after decrypt");
    url = plain;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Decrypt failed";
    await persistSyncOutcome(feed.id, "error", { error: message });
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
    await persistSyncOutcome(feed.id, status, { error: fetched.message });
    return { ok: false, status, error: fetched.message };
  }

  // 304 Not Modified — keep the cached events, just bump
  // last_synced_at + persist ETag/Last-Modified (the upstream may
  // have rotated either while keeping the body identical).
  if (fetched.status === 304) {
    await persistSyncOutcome(feed.id, "not_modified", {
      etag: fetched.etag,
      lastModified: fetched.lastModified,
    });
    return {
      ok: true,
      status: "not_modified",
      etag: fetched.etag,
      lastModified: fetched.lastModified,
    };
  }

  // ─── 3. Parse ───────────────────────────────────────────────────
  const parsed = parseICSFeed(fetched.bodyText);
  // We accept zero events (some calendars genuinely have no events
  // in the window). Only fail if the parser threw a structural error
  // (encoded as a warning that mentions "parseICS threw").
  const fatalParse = parsed.warnings.some((w) => w.startsWith("parseICS threw"));
  if (fatalParse) {
    const msg = parsed.warnings.join("; ").slice(0, 1000);
    await persistSyncOutcome(feed.id, "parse_failed", { error: msg });
    return { ok: false, status: "parse_failed", error: msg };
  }

  // ─── 4. Replace cached events ───────────────────────────────────
  try {
    await writeFeedEvents(feed, parsed.events);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "DB write failed";
    await persistSyncOutcome(feed.id, "error", { error: msg });
    return { ok: false, status: "error", error: msg };
  }

  // ─── 5. Persist success ─────────────────────────────────────────
  let detailMessage: string | undefined;
  if (parsed.recurrenceClamped) {
    detailMessage = `Truncated to ${FEED_MAX_EVENTS_PER_SYNC} events (RRULE expansion limit)`;
  }
  await persistSyncOutcome(feed.id, "ok", {
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    error: detailMessage,
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
