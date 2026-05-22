#!/usr/bin/env tsx
/**
 * materialize-recurring.ts
 *
 * Two-phase cron:
 *   Phase A (generate)   — for each active series, expand the next
 *                          30 days of occurrence rows. Idempotent —
 *                          partial unique index gates duplicates.
 *   Phase B (materialize) — for each scheduled occurrence due within
 *                           the next 24h, INSERT a real booking via
 *                           validateBookingRules + getAvailableSlots
 *                           + EXCLUDE backstop. Failures recorded on
 *                           the occurrence row; series stays intact.
 *
 * Cadence: every 15-30 minutes is plenty. Worker is idempotent and
 * never crashes the batch — per-row try/catch.
 *
 *   Linux cron:  *​/15 * * * *  (cd /app && npm run recurring:materialize)
 *
 * Plan enforcement (Phase 2 of billing hardening):
 *   Recurring series is a Pro+ capability. We honor the grandfather
 *   policy: existing series on Free tenants continue to materialize
 *   (the Phase 1 write-gate blocks new bypass attempts at API time).
 *   We DO skip:
 *     - tenants whose `active` flag is false (offboarded)
 *     - tenants whose Stripe subscriptionStatus is canceled / unpaid /
 *       incomplete_expired (premium retention not warranted after a
 *       billing failure beyond the retry window)
 *   Decisions are batched: one tenant lookup per cron run, not per
 *   series, so a 1000-series tenant stays a 1-query lookup.
 */

import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db/client";
import { bookingSeries, tenants } from "../db/schema";
import { generateOccurrences } from "../lib/recurrence/generateOccurrences";
import { materializeOccurrences } from "../lib/recurrence/materializeOccurrences";
import {
  auditCategoryFor,
  buildBatchDecisionMap,
  shouldExecute,
  type CronDecision,
} from "../lib/billing/cronGuards";
import { audit } from "../lib/audit";

const GENERATE_HORIZON_DAYS = 30;
const MATERIALIZE_HORIZON_HOURS = 24;
const CAPABILITY = "recurring_series" as const;

(async () => {
  try {
    const now = new Date();
    const generateWindow = new Date(now.getTime() + GENERATE_HORIZON_DAYS * 24 * 60 * 60_000);
    const materializeHorizon = new Date(now.getTime() + MATERIALIZE_HORIZON_HOURS * 60 * 60_000);

    // PHASE A — generate future occurrence rows for active series.
    // Skip series that the downgrade orchestrator paused (Phase 5).
    // The IS NULL predicate is cheap (partial index on enforcement_event_id)
    // and means an enforcement pause stops generation immediately.
    const activeSeries = await db
      .select()
      .from(bookingSeries)
      .where(
        and(
          eq(bookingSeries.status, "active"),
          isNull(bookingSeries.enforcementPausedAt),
        ),
      );

    // ── Plan-aware execution (Phase 2 billing hardening) ──────────
    // Build a single per-tenant decision map. We hit the tenants table
    // once with `inArray()` instead of per-series. The decision tells
    // us whether to process / grandfather / skip for each tenant.
    const tenantIds = Array.from(new Set(activeSeries.map((s) => s.tenantId)));
    const decisions = await buildBatchDecisionMap({
      db,
      tenantsTable: tenants,
      tenantIds,
      capability: CAPABILITY,
    });

    // Emit batch-level audit logs ONCE per (tenant, decision-mode) —
    // never per row, never per series. Crons are noisy enough.
    await emitBatchAudits(decisions);

    let totalGenerated = 0;
    let skipped = 0;
    for (const s of activeSeries) {
      const decision = decisions.get(s.tenantId) ?? { mode: "skip", reason: "tenant_missing" } satisfies CronDecision;
      if (!shouldExecute(decision)) {
        skipped++;
        continue;
      }
      try {
        const r = await generateOccurrences({ series: s, windowEnd: generateWindow });
        totalGenerated += r.created;
      } catch (e) {
        console.error(`[recurring] generate failed for series ${s.id}:`, e);
      }
    }
    console.log(
      `[recurring] generated ${totalGenerated} new occurrences across ${activeSeries.length - skipped}/${activeSeries.length} eligible series (${skipped} skipped by billing guard)`
    );

    // PHASE B — materialize due occurrences into real bookings.
    // The materializer iterates its own work queue (scheduled occurrence
    // rows) rather than series, so we pass the decision map in so it
    // can honor the same per-tenant guards. Existing-row grandfathering
    // means rows from previously-allowed series keep firing.
    const matResult = await materializeOccurrences({
      horizon: materializeHorizon,
      tenantDecisions: decisions,
    });
    console.log(
      `[recurring] scanned=${matResult.scanned} materialized=${matResult.materialized} failed=${matResult.failed} skipped=${matResult.skipped}`
    );
    process.exit(0);
  } catch (e) {
    console.error("[recurring] worker crashed:", e);
    process.exit(1);
  }
})();

/**
 * Emit one audit row per (tenant, non-process decision). Logging is
 * fire-and-forget — never blocks the batch.
 */
async function emitBatchAudits(decisions: Map<string, CronDecision>) {
  for (const [tenantId, decision] of decisions) {
    const category = auditCategoryFor(decision);
    if (!category) continue;
    try {
      audit({
        tenantId,
        action: category,
        actorLabel: "system:cron:materialize-recurring",
        entityType: "billing",
        metadata: {
          capability: CAPABILITY,
          decision_mode: decision.mode,
          reason: decision.reason,
        },
      });
    } catch (e) {
      // Audit failure NEVER breaks a cron — we already log it elsewhere.
      console.warn(`[recurring] audit emit failed for tenant ${tenantId}:`, e);
    }
  }
}
