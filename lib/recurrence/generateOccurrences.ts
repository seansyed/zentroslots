/**
 * Generate booking_occurrences rows for a series within a window.
 *
 * Called from the rolling worker. Idempotent — the (booking_series_id,
 * occurrence_index) partial unique index prevents duplicates; we
 * swallow 23505 silently.
 *
 * Does NOT insert real bookings — that's materializeOccurrences. This
 * stage just lays out the schedule so admins can see "the next 30 days
 * of this series" even before each occurrence has been materialized.
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookingOccurrences, bookingSeries } from "@/db/schema";

import { expandSeries } from "./expandSeries";
import { parseRecurrenceRule } from "./recurrenceRules";

export type GenerateInput = {
  /** A loaded booking_series row. */
  series: typeof bookingSeries.$inferSelect;
  /** UTC upper bound — typically now + 30 days. */
  windowEnd: Date;
  /** Cap on new occurrences per run to bound batch size. */
  maxNew?: number;
};

export type GenerateResult = { created: number; lastIndex: number };

export async function generateOccurrences(input: GenerateInput): Promise<GenerateResult> {
  const rule = parseRecurrenceRule(input.series.recurrenceRule);
  const startIndex = input.series.lastMaterializedIndex + 1;

  const expanded = expandSeries({
    rule,
    startLocal: input.series.startLocal,
    timezone: input.series.timezone,
    windowEnd: input.windowEnd,
    startIndex,
    maxCount: input.maxNew ?? 60,
  });

  let created = 0;
  let lastIndex = input.series.lastMaterializedIndex;
  for (const occ of expanded) {
    try {
      await db.insert(bookingOccurrences).values({
        tenantId: input.series.tenantId,
        bookingSeriesId: input.series.id,
        occurrenceIndex: occ.index,
        occurrenceStartAt: occ.startAt,
        status: "scheduled",
      });
      created++;
      lastIndex = occ.index;
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === "23505") {
        // Idempotency: row exists. Update high-water mark anyway.
        lastIndex = Math.max(lastIndex, occ.index);
        continue;
      }
      throw e;
    }
  }

  if (lastIndex > input.series.lastMaterializedIndex) {
    await db
      .update(bookingSeries)
      .set({ lastMaterializedIndex: lastIndex, updatedAt: new Date() })
      .where(
        and(
          eq(bookingSeries.id, input.series.id),
          eq(bookingSeries.tenantId, input.series.tenantId)
        )
      );
  }

  return { created, lastIndex };
}
