/**
 * Phase SMART-3 — customer engagement signal aggregator.
 *
 * Reads from existing tables (bookings + communication_logs) and
 * returns deterministic per-customer profiles. Strictly tenant-
 * scoped — every query carries (tenantId, lower clientEmail).
 *
 * No new schema. No mutation. Pure DB reads.
 *
 * Why we don't use a cache table:
 *   • Bookings per customer per tenant is small (< 100 rows for
 *     nearly all real customers).
 *   • The bookings(client_email) index makes the lookup cheap.
 *   • Eliminating a cache eliminates the invalidation surface.
 */

import { and, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, communicationLogs } from "@/db/schema";
import type { CustomerEngagementProfile } from "./types";

/** Lookback window for engagement metrics. Matches the
 *  SMART-1 customerPreferences module's 730-day window for
 *  consistency. */
const LOOKBACK_DAYS = 730;

/** Build the engagement profile for a single customer (tenant + email
 *  scoped). Returns null when there's no observable history. */
export async function loadCustomerEngagementProfile(args: {
  tenantId: string;
  customerEmail: string;
}): Promise<CustomerEngagementProfile | null> {
  if (!args.customerEmail || !args.customerEmail.includes("@")) return null;
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);

  const rows = await db
    .select({
      startAt: bookings.startAt,
      status: bookings.status,
      createdAt: bookings.createdAt,
      updatedAt: bookings.updatedAt,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, args.tenantId),
        sql`lower(${bookings.clientEmail}) = ${args.customerEmail.toLowerCase()}`,
        sql`${bookings.startAt} >= ${cutoff.toISOString()}`,
      ),
    )
    .limit(500);

  if (rows.length === 0) return null;

  let completed = 0;
  let noShow = 0;
  let cancelled = 0;
  let rescheduleHints = 0;
  let lastStart: Date | null = null;

  // Heuristic for rescheduleCount: a confirmed booking whose
  // updatedAt is materially after createdAt (> 1 hour) suggests
  // the customer moved their time at least once. Imperfect but
  // consistent.
  const RESCHEDULE_GAP_MS = 60 * 60_000;
  for (const r of rows) {
    if (r.status === "completed") completed++;
    else if (r.status === "no_show") noShow++;
    else if (r.status === "cancelled") cancelled++;
    if (
      r.status === "confirmed" &&
      r.updatedAt.getTime() - r.createdAt.getTime() > RESCHEDULE_GAP_MS
    ) {
      rescheduleHints++;
    }
    if (!lastStart || r.startAt > lastStart) lastStart = r.startAt;
  }
  const totalObserved = completed + noShow + cancelled;

  return {
    email: args.customerEmail.toLowerCase(),
    totalBookings: rows.length,
    completedBookings: completed,
    noShowBookings: noShow,
    cancelledBookings: cancelled,
    rescheduleCount: rescheduleHints,
    noShowRate: totalObserved === 0 ? 0 : noShow / totalObserved,
    cancellationRate: totalObserved === 0 ? 0 : cancelled / totalObserved,
    completionRate: totalObserved === 0 ? 0 : completed / totalObserved,
    lastBookingAt: lastStart?.toISOString() ?? null,
  };
}

/** Tenant-wide ranking of customers by no-show rate. Returns top-N
 *  with at least 3 observed bookings (sample-size floor). Used by
 *  the admin "repeat offenders" view.
 *
 *  Single SQL aggregation — does not call loadCustomerEngagement
 *  Profile() per customer (that would be N+1). */
export async function loadHighRiskCustomers(args: {
  tenantId: string;
  limit?: number;
}): Promise<CustomerEngagementProfile[]> {
  const limit = args.limit ?? 10;
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);

  // Aggregate per lowered email.
  // Note: we count statuses individually + total. We require >= 3
  // observed bookings to surface, so a single accidental no-show
  // doesn't put someone on the "high-risk" list.
  const rows = await db
    .select({
      email: sql<string>`lower(${bookings.clientEmail})`,
      total: sql<number>`count(*)::int`,
      completed: sql<number>`sum(case when ${bookings.status} = 'completed' then 1 else 0 end)::int`,
      noShow: sql<number>`sum(case when ${bookings.status} = 'no_show' then 1 else 0 end)::int`,
      cancelled: sql<number>`sum(case when ${bookings.status} = 'cancelled' then 1 else 0 end)::int`,
      lastBookingAt: sql<string>`max(${bookings.startAt})::text`,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, args.tenantId),
        gte(bookings.startAt, cutoff),
      ),
    )
    .groupBy(sql`lower(${bookings.clientEmail})`)
    // Floor: 3+ observed bookings to be statistically meaningful.
    .having(sql`count(*) >= 3`);

  // Compute rates + sort in app code (Postgres CASE math is verbose
  // and the result set is small). We rank by no-show rate first,
  // then by absolute no-show count as a tiebreak.
  const enriched = rows
    .map((r) => {
      const observed = r.completed + r.noShow + r.cancelled;
      return {
        email: r.email,
        totalBookings: r.total,
        completedBookings: r.completed,
        noShowBookings: r.noShow,
        cancelledBookings: r.cancelled,
        rescheduleCount: 0, // Aggregated separately if needed
        noShowRate: observed === 0 ? 0 : r.noShow / observed,
        cancellationRate: observed === 0 ? 0 : r.cancelled / observed,
        completionRate: observed === 0 ? 0 : r.completed / observed,
        lastBookingAt: r.lastBookingAt,
      };
    })
    // Only surface customers with a non-trivial no-show signal.
    .filter((c) => c.noShowRate > 0)
    .sort((a, b) => {
      if (b.noShowRate !== a.noShowRate) return b.noShowRate - a.noShowRate;
      return b.noShowBookings - a.noShowBookings;
    });

  return enriched.slice(0, limit);
}

/** Reminder-channel health across the window. Pure aggregation over
 *  communication_logs. Used by the admin observability endpoint. */
export async function loadReminderChannelHealth(args: {
  tenantId: string;
  windowDays: number;
}): Promise<{
  sent: number;
  suppressed: number;
  failed: number;
}> {
  const cutoff = new Date(Date.now() - args.windowDays * 86_400_000);

  const rows = await db
    .select({
      status: communicationLogs.status,
      n: sql<number>`count(*)::int`,
    })
    .from(communicationLogs)
    .where(
      and(
        eq(communicationLogs.tenantId, args.tenantId),
        // Reminder event types only.
        sql`${communicationLogs.eventType} IN ('appointment.reminder_24h','appointment.reminder_1h')`,
        gte(communicationLogs.createdAt, cutoff),
      ),
    )
    .groupBy(communicationLogs.status);

  const byStatus = new Map(rows.map((r) => [r.status ?? "unknown", r.n]));
  return {
    sent: byStatus.get("sent") ?? 0,
    suppressed: byStatus.get("skipped") ?? 0,
    failed: byStatus.get("failed") ?? 0,
  };
}
