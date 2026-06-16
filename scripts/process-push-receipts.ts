#!/usr/bin/env tsx
/**
 * process-push-receipts.ts — Phase 1D push receipt reconciler (2nd pass).
 *
 * The send worker (run-push-deliveries.ts) only proves Expo ACCEPTED a push.
 * The delivery RECEIPT (fetched seconds-to-minutes later) is the authoritative
 * result and is where DeviceNotRegistered surfaces for tokens that died after
 * registration. This worker:
 *   • selects 'sent' deliveries that carry an expo_receipt_id, within a 24h
 *     lookback (Expo discards receipts after ~24h);
 *   • fetches receipts from Expo;
 *   • ok        → status='delivered'   (terminal; drops out of the query)
 *   • pending   → leave 'sent'         (re-checked next tick)
 *   • token-dead (DeviceNotRegistered) → status='failed' + DELETE the token
 *   • transient → leave 'sent'         (re-checked; token NOT deleted)
 *   • other err → status='failed'      (token NOT deleted)
 *
 *   Linux cron:  every 5 minutes  --  *​/5 * * * *  cd /app && npm run push:receipts
 *
 * NEVER throws — exit 0 always so cron doesn't back off. Only writes to
 * push_deliveries + a tenant-safe DELETE on push_tokens by exact expo_token.
 */

import "dotenv/config";

import { and, eq, gte, isNotNull } from "drizzle-orm";

import { db } from "../db/client";
import { pushDeliveries, pushTokens } from "../db/schema";
import { withCronRun } from "../lib/cronObservability";
import { fetchExpoPushReceipts } from "../lib/push/sender";

const MAX_ROWS_PER_RUN = 1000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000; // Expo keeps receipts ~24h

async function runOnce(): Promise<{ checked: number; delivered: number; failed: number; pending: number; tokensPruned: number }> {
  const since = new Date(Date.now() - LOOKBACK_MS);
  const rows = await db
    .select({ id: pushDeliveries.id, expoToken: pushDeliveries.expoToken, expoReceiptId: pushDeliveries.expoReceiptId })
    .from(pushDeliveries)
    .where(
      and(
        eq(pushDeliveries.status, "sent"),
        isNotNull(pushDeliveries.expoReceiptId),
        gte(pushDeliveries.sentAt, since),
      ),
    )
    .orderBy(pushDeliveries.sentAt)
    .limit(MAX_ROWS_PER_RUN);

  if (rows.length === 0) return { checked: 0, delivered: 0, failed: 0, pending: 0, tokensPruned: 0 };

  const receiptIds = rows.map((r) => r.expoReceiptId!).filter(Boolean);
  const receipts = await fetchExpoPushReceipts(receiptIds);

  let delivered = 0;
  let failed = 0;
  let pending = 0;
  let tokensPruned = 0;

  for (const row of rows) {
    const r = row.expoReceiptId ? receipts[row.expoReceiptId] : undefined;
    if (!r || r.status === "pending") {
      pending++;
      continue; // leave 'sent' — re-check next tick
    }
    try {
      if (r.status === "ok") {
        await db
          .update(pushDeliveries)
          .set({ status: "delivered", finalizedAt: new Date() })
          .where(eq(pushDeliveries.id, row.id));
        delivered++;
      } else if (r.transient) {
        // leave 'sent' — re-check next tick; do NOT touch the token
        pending++;
      } else {
        // permanent receipt error
        await db
          .update(pushDeliveries)
          .set({ status: "failed", finalizedAt: new Date(), lastError: r.message.slice(0, 1000) })
          .where(eq(pushDeliveries.id, row.id));
        failed++;
        if (r.tokenInvalid) {
          // DeviceNotRegistered surfaced at receipt time — prune the dead
          // token (tenant-safe: exact expo_token match). Best-effort.
          await db.delete(pushTokens).where(eq(pushTokens.expoToken, row.expoToken)).catch(() => {});
          tokensPruned++;
        }
      }
    } catch (writeErr) {
      console.error(
        JSON.stringify({
          evt: "push_receipt_writeback_failed",
          deliveryId: row.id,
          err: writeErr instanceof Error ? writeErr.message.slice(0, 200) : "unknown",
        }),
      );
    }
  }

  return { checked: rows.length, delivered, failed, pending, tokensPruned };
}

async function main(): Promise<void> {
  const result = await withCronRun("push_receipts", async () => runOnce());
  console.log(JSON.stringify({ evt: "push_receipts_tick", ...result, ts: new Date().toISOString() }));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      JSON.stringify({ evt: "push_receipts_fatal", err: err instanceof Error ? err.message.slice(0, 500) : "unknown" }),
    );
    process.exit(0);
  });
