/**
 * Phase SMART-2 — admin workflow observability.
 *
 * Pure aggregator over EXISTING tables (bookings + waitlists +
 * waitlist_notifications + pending_automations). No new schema —
 * we derive everything from current state.
 *
 * Metrics:
 *   • totalCancellations           — count of status=cancelled
 *                                    bookings in window
 *   • recoveredCancellations       — cancellations where the SAME
 *                                    customer (by lowered email)
 *                                    booked again within 7 days
 *   • recoveryRate                 — recoveredCancellations / total
 *   • totalNoShows                 — count of status=no_show
 *   • waitlistJoins                — count of waitlist rows
 *   • waitlistFills                — waitlists that progressed to
 *                                    status='claimed'
 *   • waitlistConversionRate       — fills / joins
 *   • pendingAutomations           — outstanding queue depth
 *   • avgRescheduleLeadHours       — average hours between
 *                                    booking.updatedAt and
 *                                    booking.startAt for bookings
 *                                    that changed time (approx —
 *                                    we don't have a dedicated
 *                                    reschedule log)
 *
 * Strictly tenant-scoped.
 */

import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookings,
  pendingAutomations,
  waitlists,
} from "@/db/schema";

export type WorkflowMetrics = {
  tenantId: string;
  generatedAt: string;
  windowDays: number;
  totals: {
    bookings: number;
    cancellations: number;
    noShows: number;
    completed: number;
  };
  recovery: {
    cancellationsRecovered: number;
    recoveryRatePct: number;
  };
  waitlist: {
    joins: number;
    fills: number;
    conversionRatePct: number;
  };
  automation: {
    pendingDepth: number;
    sentLast24h: number;
  };
  /** Average lead time (hours) for bookings that look like reschedules
   *  — i.e. status=confirmed and updated_at is significantly after
   *  created_at. Approximate; the schema lacks a dedicated reschedule
   *  log. */
  reschedule: {
    estimatedReschedules: number;
    avgLeadHours: number | null;
  };
};

const WINDOW_DAYS = 30;
const RECOVERY_WINDOW_DAYS = 7;

export async function computeWorkflowMetrics(
  tenantId: string,
): Promise<WorkflowMetrics> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);

  // ─── Booking totals in window ──────────────────────────────────
  const rows = await db
    .select({
      id: bookings.id,
      clientEmail: bookings.clientEmail,
      status: bookings.status,
      startAt: bookings.startAt,
      createdAt: bookings.createdAt,
      updatedAt: bookings.updatedAt,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        gte(bookings.createdAt, windowStart),
        lt(bookings.createdAt, now),
      ),
    );

  const cancellations = rows.filter((r) => r.status === "cancelled");
  const noShows = rows.filter((r) => r.status === "no_show");
  const completed = rows.filter((r) => r.status === "completed");

  // ─── Cancellation recovery: did the customer re-book within
  //     RECOVERY_WINDOW_DAYS of cancelling?
  // We approximate "cancelled at" using bookings.updatedAt for the
  // cancelled row, then look for any later booking from the same
  // (tenant, lower clientEmail) within the recovery window.
  let cancellationsRecovered = 0;
  if (cancellations.length > 0) {
    // Group all bookings by lowered email to power the lookup.
    const byEmail = new Map<string, { startAt: Date; updatedAt: Date }[]>();
    for (const r of rows) {
      const k = r.clientEmail.toLowerCase();
      if (!byEmail.has(k)) byEmail.set(k, []);
      byEmail.get(k)!.push({ startAt: r.startAt, updatedAt: r.updatedAt });
    }
    for (const c of cancellations) {
      const list = byEmail.get(c.clientEmail.toLowerCase()) ?? [];
      const cancelledAt = c.updatedAt.getTime();
      const windowEnd = cancelledAt + RECOVERY_WINDOW_DAYS * 86_400_000;
      const recovered = list.some(
        (b) =>
          b.updatedAt.getTime() > cancelledAt &&
          b.updatedAt.getTime() <= windowEnd,
      );
      if (recovered) cancellationsRecovered++;
    }
  }
  const recoveryRatePct =
    cancellations.length === 0
      ? 0
      : Math.round((cancellationsRecovered / cancellations.length) * 100);

  // ─── Waitlist activity ────────────────────────────────────────
  // Joins = total waitlist rows created in the window.
  // Fills = rows where status='claimed'.
  const waitlistRows = await db
    .select({ status: waitlists.status, createdAt: waitlists.createdAt })
    .from(waitlists)
    .where(
      and(
        eq(waitlists.tenantId, tenantId),
        gte(waitlists.createdAt, windowStart),
      ),
    );
  const waitlistJoins = waitlistRows.length;
  const waitlistFills = waitlistRows.filter((r) => r.status === "claimed").length;
  const conversionRatePct =
    waitlistJoins === 0 ? 0 : Math.round((waitlistFills / waitlistJoins) * 100);

  // ─── Automation queue depth ───────────────────────────────────
  // Pending = status in ('pending','queued') — schema may use either
  // shape so we count both. Sent in last 24h gives a "throughput"
  // signal.
  const pendingDepthRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pendingAutomations)
    .where(
      and(
        eq(pendingAutomations.tenantId, tenantId),
        sql`${pendingAutomations.status} IN ('pending','queued')`,
      ),
    );
  const pendingDepth = pendingDepthRow[0]?.n ?? 0;

  const sent24hRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pendingAutomations)
    .where(
      and(
        eq(pendingAutomations.tenantId, tenantId),
        eq(pendingAutomations.status, "sent"),
        gte(pendingAutomations.dueAt, new Date(now.getTime() - 86_400_000)),
      ),
    );
  const sentLast24h = sent24hRow[0]?.n ?? 0;

  // ─── Reschedule estimation ────────────────────────────────────
  // We don't have a dedicated reschedule log. Heuristic: any
  // confirmed booking whose updated_at is materially later than
  // created_at (> 1 hour) where the start_at is in the future is
  // likely a reschedule. Imperfect but consistent.
  const RESCHEDULE_GAP_MS = 60 * 60_000;
  const rescheduleCandidates = rows.filter(
    (r) =>
      r.status === "confirmed" &&
      r.startAt > now &&
      r.updatedAt.getTime() - r.createdAt.getTime() > RESCHEDULE_GAP_MS,
  );
  const leadsHours = rescheduleCandidates.map(
    (r) => (r.startAt.getTime() - r.updatedAt.getTime()) / 3_600_000,
  );
  const avgLeadHours =
    leadsHours.length === 0
      ? null
      : Math.round(leadsHours.reduce((a, b) => a + b, 0) / leadsHours.length);

  return {
    tenantId,
    generatedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    totals: {
      bookings: rows.length,
      cancellations: cancellations.length,
      noShows: noShows.length,
      completed: completed.length,
    },
    recovery: {
      cancellationsRecovered,
      recoveryRatePct,
    },
    waitlist: {
      joins: waitlistJoins,
      fills: waitlistFills,
      conversionRatePct,
    },
    automation: {
      pendingDepth,
      sentLast24h,
    },
    reschedule: {
      estimatedReschedules: rescheduleCandidates.length,
      avgLeadHours,
    },
  };
}
