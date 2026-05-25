#!/usr/bin/env tsx
/**
 * sync-external-feeds.ts
 *
 * Phase ICAL-3 — fetches due external ICS feeds and refreshes the
 * cached busy event set used by the availability engine.
 *
 * Selection: any feed with is_enabled=true AND next_sync_after <= now,
 * ordered by next_sync_after ASC. We process up to BATCH_SIZE per
 * invocation; the orchestrator (per-feed) updates next_sync_after on
 * each completion so the next invocation picks up the next batch.
 *
 * Run every 15 minutes via a host-level scheduler:
 *   - Linux:   cron entry  ​*​/15 * * * *  (cd /app && npm run feeds:sync)
 *
 * Idempotent — each feed runs at most once per invocation (we lock
 * the batch by updating next_sync_after to NOW + 5 min as soon as
 * we select them, so a concurrent invocation skips them). The
 * per-feed orchestrator re-bases next_sync_after to its real cadence
 * (15 min on success, 1 h on failure) when it completes.
 *
 * Failure isolation: a single feed error never aborts the batch.
 * Errors are caught + persisted to the feed row's last_error.
 */

import "dotenv/config";
import { and, asc, eq, lte } from "drizzle-orm";

import { db } from "../db/client";
import { externalCalendarFeeds } from "../db/schema";
import { syncExternalFeed } from "../lib/calendar/externalFeeds/syncExternalFeed";

/** How many feeds to attempt per run. With a 15-min cadence and a
 *  ~3s avg sync time, 60 feeds/run leaves ample headroom. Tune up
 *  if the queue grows beyond a single tenant's worth of feeds. */
const BATCH_SIZE = 60;

/** Soft lock window — claim a feed by pushing next_sync_after a
 *  few minutes ahead so a concurrent invocation of this script
 *  won't pick it up. The per-feed orchestrator overwrites the
 *  field with the real cadence when it finishes. */
const CLAIM_WINDOW_MS = 5 * 60_000;

async function main(): Promise<void> {
  const now = new Date();
  const claimUntil = new Date(now.getTime() + CLAIM_WINDOW_MS);

  // Pick batch — enabled + due. Order by oldest-due so nothing
  // gets starved by a flood of new feeds.
  const due = await db
    .select()
    .from(externalCalendarFeeds)
    .where(
      and(
        eq(externalCalendarFeeds.isEnabled, true),
        lte(externalCalendarFeeds.nextSyncAfter, now),
      ),
    )
    .orderBy(asc(externalCalendarFeeds.nextSyncAfter))
    .limit(BATCH_SIZE);

  if (due.length === 0) {
    console.log(`[feeds:sync] no due feeds at ${now.toISOString()}`);
    return;
  }

  console.log(`[feeds:sync] processing ${due.length} feed(s)`);

  // Claim them BEFORE syncing so a concurrent invocation skips
  // the same rows. We update one-at-a-time rather than IN (...)
  // to keep the per-row error story clean; the cost is N round
  // trips, which for 60 rows is negligible.
  for (const f of due) {
    try {
      await db
        .update(externalCalendarFeeds)
        .set({ nextSyncAfter: claimUntil })
        .where(eq(externalCalendarFeeds.id, f.id));
    } catch (e) {
      console.error(`[feeds:sync] failed to claim feed ${f.id}:`, e);
    }
  }

  // Now sync each. Errors are isolated — one bad feed cannot
  // stop the batch.
  let ok = 0;
  let failed = 0;
  for (const f of due) {
    try {
      const res = await syncExternalFeed(f);
      if (res.ok) {
        ok++;
        console.log(
          `[feeds:sync] feed=${f.id} status=${res.status}` +
            (res.status === "ok" ? ` events=${res.events.length}` : ""),
        );
      } else {
        failed++;
        console.warn(
          `[feeds:sync] feed=${f.id} status=${res.status} error="${res.error}"`,
        );
      }
    } catch (e) {
      failed++;
      console.error(`[feeds:sync] feed=${f.id} unexpected error:`, e);
    }
  }

  console.log(`[feeds:sync] complete: ok=${ok} failed=${failed}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
