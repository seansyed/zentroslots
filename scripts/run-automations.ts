#!/usr/bin/env tsx
/**
 * run-automations.ts
 *
 * Drains the pending_automations queue. For each row whose due_at has
 * arrived, re-evaluate the rule's conditions and fire through
 * triggerAutomation. Marks the row done / skipped / failed.
 *
 * Run on the same cadence as reminders (every 10–15 minutes):
 *   - Linux cron:  *​/15 * * * *  (cd /app && npm run automations:run)
 *
 * Idempotency:
 *   - communication_logs partial unique index prevents double-sends per
 *     (tenant, booking, event, channel).
 *   - pending_automations unique partial index on (booking_id, event_type)
 *     WHERE status IN ('pending','processing') prevents double-enqueue.
 *   - Worker uses an UPDATE … RETURNING pattern to claim rows from
 *     'pending' → 'processing' atomically so two workers can't race
 *     (though we don't run two in production today).
 *
 * NEVER throws. Each row processed independently; a single failure
 * doesn't stop the batch.
 */

import "dotenv/config";
import { and, eq, lte, sql } from "drizzle-orm";

import { db } from "../db/client";
import {
  bookings,
  followupAutomationRules,
  pendingAutomations,
  reviewRequestRules,
} from "../db/schema";
import {
  triggerAutomation,
  type AutomationEvent,
} from "../lib/communications/engine";
import {
  hasSuccessfulPayment,
  isCompletedBooking,
  isFirstTimeCustomer,
  type ConditionResult,
} from "../lib/automations/automationConditions";
import type { PendingSkipReason } from "../lib/automations/types";

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 3;

async function run() {
  const now = new Date();

  // Claim up to BATCH_SIZE pending rows that are due. The UPDATE …
  // RETURNING pattern is atomic per-row in PostgreSQL — flipping to
  // 'processing' commits before the worker reads the row back.
  const claimed = await db
    .update(pendingAutomations)
    .set({
      status: "processing",
      attempts: sql`${pendingAutomations.attempts} + 1`,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(
      sql`id IN (
        SELECT id FROM ${pendingAutomations}
        WHERE status = 'pending'
          AND due_at <= ${now}
          AND attempts < ${MAX_ATTEMPTS}
        ORDER BY due_at ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )`
    )
    .returning();

  console.log(`[automations] claimed ${claimed.length} due rows at ${now.toISOString()}`);

  for (const row of claimed) {
    try {
      await processOne(row);
    } catch (e) {
      // Per-row safety net — keep batch going.
      console.error(`[automations] row ${row.id} crashed:`, e);
      await markRow(row.id, "failed", "unknown");
    }
  }
}

async function processOne(row: typeof pendingAutomations.$inferSelect) {
  // 1. Load the booking.
  const booking = await db.query.bookings.findFirst({
    where: and(eq(bookings.id, row.bookingId), eq(bookings.tenantId, row.tenantId)),
  });
  if (!booking) {
    await markRow(row.id, "skipped", "booking_missing");
    return;
  }

  // 2. Re-evaluate the rule (the row stored ruleId at enqueue, but the
  // rule may have been disabled or deleted since). Branch by ruleKind.
  if (row.ruleKind === "review_request") {
    await processReviewRequest(row, booking);
  } else if (row.ruleKind === "followup") {
    await processFollowup(row, booking);
  } else {
    await markRow(row.id, "skipped", "unknown");
  }
}

async function processReviewRequest(
  row: typeof pendingAutomations.$inferSelect,
  booking: typeof bookings.$inferSelect
) {
  const rule = row.ruleId
    ? await db.query.reviewRequestRules.findFirst({
        where: and(
          eq(reviewRequestRules.id, row.ruleId),
          eq(reviewRequestRules.tenantId, row.tenantId)
        ),
      })
    : null;
  if (!rule) {
    await markRow(row.id, "skipped", "rule_missing");
    return;
  }
  if (!rule.enabled) {
    await markRow(row.id, "skipped", "rule_disabled");
    return;
  }
  // Re-check suppression in case the booking was re-flipped after enqueue.
  if (booking.status === "cancelled" && rule.suppressIfCancelled) {
    await markRow(row.id, "skipped", "suppress_cancelled");
    return;
  }
  if (booking.status === "no_show" && rule.suppressIfNoShow) {
    await markRow(row.id, "skipped", "suppress_no_show");
    return;
  }

  // Fire the automation. The review URL goes into contextExtras and
  // the templating engine renders {{review_url}} from it.
  const eventType: AutomationEvent = "appointment.review_request";
  const result = await triggerAutomation({
    tenantId: row.tenantId,
    bookingId: row.bookingId,
    eventType,
    contextExtras: {
      review_url: rule.reviewUrl ?? "",
      review_platform: rule.reviewPlatform,
    },
  });
  await finalizeFromTriggerResult(row.id, result);
}

async function processFollowup(
  row: typeof pendingAutomations.$inferSelect,
  booking: typeof bookings.$inferSelect
) {
  const rule = row.ruleId
    ? await db.query.followupAutomationRules.findFirst({
        where: and(
          eq(followupAutomationRules.id, row.ruleId),
          eq(followupAutomationRules.tenantId, row.tenantId)
        ),
      })
    : null;
  if (!rule) {
    await markRow(row.id, "skipped", "rule_missing");
    return;
  }
  if (!rule.enabled) {
    await markRow(row.id, "skipped", "rule_disabled");
    return;
  }

  // Conditional checks — evaluated NOW, not at enqueue time.
  if (rule.onlyCompletedBookings) {
    const r = isCompletedBooking({ bookingStatus: booking.status });
    if (!r.ok) {
      await markRow(row.id, "skipped", r.reason);
      return;
    }
  }
  if (rule.onlyFirstTimeCustomers) {
    const r: ConditionResult = await isFirstTimeCustomer({
      tenantId: row.tenantId,
      clientEmail: booking.clientEmail,
      bookingStartAt: booking.startAt,
    });
    if (!r.ok) {
      await markRow(row.id, "skipped", r.reason);
      return;
    }
  }
  if (rule.requireSuccessfulPayment) {
    const r = await hasSuccessfulPayment({
      tenantId: row.tenantId,
      bookingId: row.bookingId,
    });
    if (!r.ok) {
      await markRow(row.id, "skipped", r.reason);
      return;
    }
  }

  const result = await triggerAutomation({
    tenantId: row.tenantId,
    bookingId: row.bookingId,
    eventType: "appointment.followup",
  });
  await finalizeFromTriggerResult(row.id, result);
}

async function finalizeFromTriggerResult(
  rowId: string,
  result: Awaited<ReturnType<typeof triggerAutomation>>
) {
  if (result.status === "sent") {
    await markRow(rowId, "done");
  } else if (result.status === "skipped") {
    await markRow(rowId, "skipped", "engine_skipped");
  } else {
    await markRow(rowId, "failed", "engine_failed");
  }
}

async function markRow(
  id: string,
  status: "done" | "skipped" | "failed",
  reason?: PendingSkipReason | string
) {
  await db
    .update(pendingAutomations)
    .set({
      status,
      reason: reason ?? null,
      updatedAt: new Date(),
    })
    .where(eq(pendingAutomations.id, id));
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[automations] worker crashed:", e);
    process.exit(1);
  });

// `lte` is reserved for a future "find scheduled non-due rows" debug
// flag; keep the import alive without bloating bundle elsewhere.
void lte;
