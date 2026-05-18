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
 */

import "dotenv/config";
import { eq } from "drizzle-orm";

import { db } from "../db/client";
import { bookingSeries } from "../db/schema";
import { generateOccurrences } from "../lib/recurrence/generateOccurrences";
import { materializeOccurrences } from "../lib/recurrence/materializeOccurrences";

const GENERATE_HORIZON_DAYS = 30;
const MATERIALIZE_HORIZON_HOURS = 24;

(async () => {
  try {
    const now = new Date();
    const generateWindow = new Date(now.getTime() + GENERATE_HORIZON_DAYS * 24 * 60 * 60_000);
    const materializeHorizon = new Date(now.getTime() + MATERIALIZE_HORIZON_HOURS * 60 * 60_000);

    // PHASE A — generate future occurrence rows for active series.
    const activeSeries = await db
      .select()
      .from(bookingSeries)
      .where(eq(bookingSeries.status, "active"));

    let totalGenerated = 0;
    for (const s of activeSeries) {
      try {
        const r = await generateOccurrences({ series: s, windowEnd: generateWindow });
        totalGenerated += r.created;
      } catch (e) {
        console.error(`[recurring] generate failed for series ${s.id}:`, e);
      }
    }
    console.log(
      `[recurring] generated ${totalGenerated} new occurrences across ${activeSeries.length} active series`
    );

    // PHASE B — materialize due occurrences into real bookings.
    const matResult = await materializeOccurrences({ horizon: materializeHorizon });
    console.log(
      `[recurring] scanned=${matResult.scanned} materialized=${matResult.materialized} failed=${matResult.failed} skipped=${matResult.skipped}`
    );
    process.exit(0);
  } catch (e) {
    console.error("[recurring] worker crashed:", e);
    process.exit(1);
  }
})();
