/**
 * Phase SMART-4 — booking conversion funnel aggregator.
 *
 * Joins:
 *   • embed_events table     page-visit + interaction tracking
 *   • bookings table         confirmed/completed/cancelled/no-show
 *
 * Computes:
 *   • visitToBookingRatePct  (completedBookings / pageVisits) × 100
 *   • bookingCompletionRatePct  successfulBookings / allBookings
 *
 * Strictly tenant-scoped. Read-only. No new schema.
 *
 * Formula notes (no hidden estimation):
 *   • pageVisits = count of embed_events rows in the window. We
 *     do NOT distinguish unique visitors here — that would require
 *     a session-key column the schema doesn't track. Visit count
 *     is the most-honest available signal.
 *   • completedBookings = bookings.status IN ('confirmed','completed').
 *     We exclude 'pending' / 'pending_payment' / 'payment_failed' /
 *     'cancelled' / 'no_show' from the success numerator.
 */

import { and, eq, gte, lt, sql, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, embedEvents } from "@/db/schema";
import type { ConversionFunnel } from "./types";

const DEFAULT_WINDOW_DAYS = 30;

export async function computeConversionFunnel(args: {
  tenantId: string;
  windowDays?: number;
}): Promise<ConversionFunnel> {
  const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000);

  // ─── Page visits ────────────────────────────────────────────────
  // We count ALL embed_events for the tenant in the window. Different
  // event kinds (view, slot_click, etc.) all count toward funnel
  // top-of-funnel since we don't have a dedicated "view" filter
  // baked into the schema right now.
  const [visitRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(embedEvents)
    .where(
      and(
        eq(embedEvents.tenantId, args.tenantId),
        gte(embedEvents.createdAt, windowStart),
        lt(embedEvents.createdAt, now),
      ),
    );
  const pageVisits = visitRow?.n ?? 0;

  // ─── Booking outcomes ──────────────────────────────────────────
  // One scan, classify by status.
  const bookingRows = await db
    .select({ status: bookings.status })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, args.tenantId),
        gte(bookings.createdAt, windowStart),
        lt(bookings.createdAt, now),
      ),
    );

  let completed = 0;
  let cancelled = 0;
  let noShow = 0;
  let other = 0;
  for (const r of bookingRows) {
    if (r.status === "confirmed" || r.status === "completed") completed++;
    else if (r.status === "cancelled") cancelled++;
    else if (r.status === "no_show") noShow++;
    else other++;
  }

  const totalBookings = completed + cancelled + noShow + other;

  // ─── Rates ─────────────────────────────────────────────────────
  // Both rates clamp to 0..100. When the denominator is 0 (no
  // visits or no bookings yet) we return 0 rather than NaN — the
  // dashboard renders "—" for 0 with a tooltip noting insufficient
  // sample.
  const visitToBookingRatePct =
    pageVisits === 0
      ? 0
      : Math.min(100, Math.round((completed / pageVisits) * 100));
  const bookingCompletionRatePct =
    totalBookings === 0
      ? 0
      : Math.round((completed / totalBookings) * 100);

  return {
    windowDays,
    pageVisits,
    completedBookings: completed,
    cancelledBookings: cancelled,
    noShowBookings: noShow,
    visitToBookingRatePct,
    bookingCompletionRatePct,
  };
}

/** Pure helper — same shape, no DB. For tests + composition. */
export function rollupConversionFromCounts(args: {
  windowDays: number;
  pageVisits: number;
  completed: number;
  cancelled: number;
  noShow: number;
  other: number;
}): ConversionFunnel {
  const total =
    args.completed + args.cancelled + args.noShow + args.other;
  return {
    windowDays: args.windowDays,
    pageVisits: args.pageVisits,
    completedBookings: args.completed,
    cancelledBookings: args.cancelled,
    noShowBookings: args.noShow,
    visitToBookingRatePct:
      args.pageVisits === 0
        ? 0
        : Math.min(100, Math.round((args.completed / args.pageVisits) * 100)),
    bookingCompletionRatePct:
      total === 0 ? 0 : Math.round((args.completed / total) * 100),
  };
}
