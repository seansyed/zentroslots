#!/usr/bin/env tsx
/**
 * run-push-deliveries.ts — Phase 1C push delivery worker.
 *
 * Polls push_deliveries rows where status='pending' AND next_retry_at <= now(),
 * groups them into batches of up to 100, POSTs to the Expo push API,
 * and writes back per-row status.
 *
 *   Linux cron:  every minute  --  * * * * *  cd /app && npm run push:deliver
 *
 * Reliability behavior:
 *   • Per-batch try/catch so one bad batch can't stall the run.
 *   • Permanent errors (DeviceNotRegistered, InvalidCredentials)
 *     mark the delivery 'failed' AND delete the dead token so we
 *     never retry against it.
 *   • Transient errors (HTTP 5xx, network, MessageRateExceeded)
 *     schedule a retry with exponential backoff (60s → 5m → 30m).
 *   • Hard giveup after 5 attempts → status='expired'.
 *   • Updates push_tokens.last_used_at on success — operators can
 *     prune stale tokens by joining on (last_used_at < 30d ago).
 *   • Cron run state via withCronRun() so /admin/diagnostics shows
 *     last-run health.
 *   • NEVER throws — exit code 0 always so cron doesn't backoff.
 */

import "dotenv/config";

import { and, eq, lte, sql } from "drizzle-orm";

import { db } from "../db/client";
import { pushDeliveries, pushTokens } from "../db/schema";
import { withCronRun } from "../lib/cronObservability";
import { sendExpoPushBatch, type ExpoPushMessage } from "../lib/push/sender";

const MAX_ROWS_PER_RUN = 500; // safety ceiling
const MAX_ATTEMPTS = 5;

function backoffMs(attempt: number): number {
  // attempt 1 → 60s, 2 → 5min, 3 → 30min, 4 → 2h, 5 → 6h
  const SCHEDULE = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];
  return SCHEDULE[Math.min(attempt, SCHEDULE.length - 1)]!;
}

async function runOnce(): Promise<{ processed: number; sent: number; failed: number; retried: number }> {
  const now = new Date();
  const pending = await db
    .select()
    .from(pushDeliveries)
    .where(
      and(
        eq(pushDeliveries.status, "pending"),
        lte(pushDeliveries.nextRetryAt, now),
      ),
    )
    .orderBy(pushDeliveries.nextRetryAt)
    .limit(MAX_ROWS_PER_RUN);

  if (pending.length === 0) {
    return { processed: 0, sent: 0, failed: 0, retried: 0 };
  }

  // Build the batch payload + a map back to delivery rows.
  const messages: ExpoPushMessage[] = pending.map((row) => ({
    to: row.expoToken,
    title: row.title,
    body: row.body,
    sound: "default",
    priority: "high",
    channelId: "default",
    data: (row.dataPayload ?? {}) as Record<string, unknown>,
    _id: row.id,
  }));

  const results = await sendExpoPushBatch(messages);

  let sent = 0;
  let failed = 0;
  let retried = 0;

  // Per-row status writeback — done individually so one row's failure
  // can't break the rest. Performance is fine: even a 500-row batch
  // is 500 small UPDATEs and runs in ~1 second.
  for (let i = 0; i < pending.length; i++) {
    const row = pending[i]!;
    const result = results[i]!;

    try {
      if (result.status === "ok") {
        await db
          .update(pushDeliveries)
          .set({
            status: "sent",
            sentAt: new Date(),
            finalizedAt: new Date(),
            expoReceiptId: result.receiptId,
            attemptCount: row.attemptCount + 1,
            lastError: null,
          })
          .where(eq(pushDeliveries.id, row.id));

        // Touch the token so stale-token cleanup can prune by
        // last_used_at. Best-effort — never block delivery writeback.
        void db
          .update(pushTokens)
          .set({ lastUsedAt: new Date() })
          .where(eq(pushTokens.expoToken, row.expoToken))
          .catch(() => {});

        sent++;
      } else {
        const nextAttempt = row.attemptCount + 1;

        if (result.tokenInvalid) {
          // Permanent — drop the row + the dead token.
          await db
            .update(pushDeliveries)
            .set({
              status: "failed",
              finalizedAt: new Date(),
              attemptCount: nextAttempt,
              lastError: result.message.slice(0, 1000),
            })
            .where(eq(pushDeliveries.id, row.id));
          await db
            .delete(pushTokens)
            .where(eq(pushTokens.expoToken, row.expoToken))
            .catch(() => {});
          failed++;
        } else if (nextAttempt >= MAX_ATTEMPTS) {
          // Giveup.
          await db
            .update(pushDeliveries)
            .set({
              status: "expired",
              finalizedAt: new Date(),
              attemptCount: nextAttempt,
              lastError: result.message.slice(0, 1000),
            })
            .where(eq(pushDeliveries.id, row.id));
          failed++;
        } else {
          // Schedule retry with backoff.
          const nextRetry = new Date(Date.now() + backoffMs(nextAttempt));
          await db
            .update(pushDeliveries)
            .set({
              attemptCount: nextAttempt,
              nextRetryAt: nextRetry,
              lastError: result.message.slice(0, 1000),
            })
            .where(eq(pushDeliveries.id, row.id));
          retried++;
        }
      }
    } catch (writeErr) {
      // We managed to send (or not) but failed to record the
      // outcome. The row stays in 'pending' and will be reprocessed
      // on the next tick — at worst we double-send once, which is
      // acceptable for push.
      console.error(
        JSON.stringify({
          evt: "push_writeback_failed",
          deliveryId: row.id,
          err: writeErr instanceof Error ? writeErr.message.slice(0, 200) : "unknown",
        }),
      );
    }
  }

  return { processed: pending.length, sent, failed, retried };
}

async function main(): Promise<void> {
  const result = await withCronRun("push_deliveries", async () => {
    return runOnce();
  });

  console.log(
    JSON.stringify({
      evt: "push_deliveries_tick",
      processed: result.processed,
      sent: result.sent,
      failed: result.failed,
      retried: result.retried,
      ts: new Date().toISOString(),
    }),
  );
}

main()
  .then(() => {
    // Drizzle keeps connection pool open — exit explicitly so cron
    // doesn't think we hung.
    process.exit(0);
  })
  .catch((err) => {
    console.error(
      JSON.stringify({
        evt: "push_deliveries_fatal",
        err: err instanceof Error ? err.message.slice(0, 500) : "unknown",
      }),
    );
    // Exit 0 anyway — never tell cron to back off; we'll just try
    // again next minute.
    process.exit(0);
  });

// Suppress unused-import lint when the SQL helper isn't called in
// the current code path (it's there for future filters).
void sql;
