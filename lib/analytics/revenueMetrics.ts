/**
 * Revenue metrics from billing_transactions for one (tenant, day).
 *
 * Source-of-truth: billing_transactions.paid_at falls inside the day
 * window. Refunds (negative-amount rows with status 'refunded') are
 * counted via their refunded_at falling inside the day.
 *
 * Returned shapes match what the analytics snapshot's `extras.revenue`,
 * `extras.serviceRevenue`, and `extras.staffRevenue` carry.
 *
 * NEVER throws. Empty input → all zeros. Tenant-isolated by query
 * predicates.
 */
import { and, eq, gte, lt, or } from "drizzle-orm";

import { db } from "@/db/client";
import { billingTransactions, bookings, services, users } from "@/db/schema";

export type RevenueSummary = {
  grossRevenueCents: number;
  refundedRevenueCents: number;
  netRevenueCents: number;
  successfulPayments: number;
  failedPayments: number;
  avgBookingValueCents: number;
};

export type ServiceRevenueRow = {
  serviceId: string;
  serviceName: string;
  revenueCents: number;
  bookings: number;
};

export type StaffRevenueRow = {
  staffId: string;
  staffName: string;
  revenueCents: number;
  bookings: number;
};

export type RevenueDaily = {
  summary: RevenueSummary;
  serviceRevenue: ServiceRevenueRow[];
  staffRevenue: StaffRevenueRow[];
};

export function emptyRevenueDaily(): RevenueDaily {
  return {
    summary: {
      grossRevenueCents: 0,
      refundedRevenueCents: 0,
      netRevenueCents: 0,
      successfulPayments: 0,
      failedPayments: 0,
      avgBookingValueCents: 0,
    },
    serviceRevenue: [],
    staffRevenue: [],
  };
}

export async function aggregateRevenueMetrics(args: {
  tenantId: string;
  dayStart: Date;
  dayEnd: Date;
}): Promise<RevenueDaily> {
  try {
    // Pull every transaction touching this day window — covers both
    // paid_at (positive rows) and refunded_at (refund rows). One read.
    const rows = await db
      .select({
        id: billingTransactions.id,
        amountCents: billingTransactions.amountCents,
        transactionType: billingTransactions.transactionType,
        status: billingTransactions.status,
        bookingId: billingTransactions.bookingId,
        paidAt: billingTransactions.paidAt,
        refundedAt: billingTransactions.refundedAt,
      })
      .from(billingTransactions)
      .where(
        and(
          eq(billingTransactions.tenantId, args.tenantId),
          or(
            and(
              gte(billingTransactions.paidAt, args.dayStart),
              lt(billingTransactions.paidAt, args.dayEnd)
            ),
            and(
              gte(billingTransactions.refundedAt, args.dayStart),
              lt(billingTransactions.refundedAt, args.dayEnd)
            )
          )
        )
      );

    let gross = 0;
    let refunded = 0;
    let successful = 0;
    let failed = 0;
    const paidBookingIds = new Set<string>();
    const paidBookingAmounts: number[] = [];

    for (const r of rows) {
      // Paid revenue (positive rows with status 'paid' or 'partially_refunded')
      if (
        (r.status === "paid" || r.status === "partially_refunded") &&
        r.amountCents > 0 &&
        r.paidAt &&
        r.paidAt >= args.dayStart &&
        r.paidAt < args.dayEnd
      ) {
        gross += r.amountCents;
        successful++;
        if (r.bookingId) {
          paidBookingIds.add(r.bookingId);
          paidBookingAmounts.push(r.amountCents);
        }
      } else if (
        r.status === "failed" &&
        r.transactionType !== "refund" &&
        r.paidAt === null &&
        // Failed rows: count if created within the window. We don't
        // have a separate "failed_at" column — paid_at stays null on
        // failure — so we infer from the day query above (refundedAt
        // also null for failed rows, but the OR window catches them
        // via paid_at predicate elsewhere? actually no — neither.
        // Re-fetch by created_at would expand the query; instead we
        // count failed rows when refunded_at IS NULL AND paid_at
        // IS NULL — i.e. the row showed up because of some OTHER
        // filter. The OR above won't include those.
        // SAFER: include a separate predicate below for failed rows.
        false
      ) {
        failed++;
      } else if (r.transactionType === "refund" && r.amountCents < 0) {
        // Refund rows are stored with NEGATIVE amount + refundedAt
        // inside the day.
        if (r.refundedAt && r.refundedAt >= args.dayStart && r.refundedAt < args.dayEnd) {
          refunded += Math.abs(r.amountCents);
        }
      }
    }

    // Second pass for failed payments — separate predicate so we don't
    // muddle with paid_at/refunded_at OR above.
    const failedRows = await db
      .select({ id: billingTransactions.id })
      .from(billingTransactions)
      .where(
        and(
          eq(billingTransactions.tenantId, args.tenantId),
          eq(billingTransactions.status, "failed"),
          gte(billingTransactions.createdAt, args.dayStart),
          lt(billingTransactions.createdAt, args.dayEnd)
        )
      );
    failed = failedRows.length;

    const avg =
      paidBookingAmounts.length > 0
        ? Math.round(paidBookingAmounts.reduce((a, b) => a + b, 0) / paidBookingAmounts.length)
        : 0;

    const summary: RevenueSummary = {
      grossRevenueCents: gross,
      refundedRevenueCents: refunded,
      netRevenueCents: gross - refunded,
      successfulPayments: successful,
      failedPayments: failed,
      avgBookingValueCents: avg,
    };

    // Per-service + per-staff breakdowns from paid bookings.
    let serviceRevenue: ServiceRevenueRow[] = [];
    let staffRevenue: StaffRevenueRow[] = [];
    if (paidBookingIds.size > 0) {
      const bookingIds = Array.from(paidBookingIds);
      // Fetch the booking → service + staff mapping for the paid set.
      // We join lazily and filter inArray-style via the SET in JS,
      // which keeps the query simple for arbitrary id counts.
      const bookingRows = await db
        .select({
          bookingId: bookings.id,
          serviceId: services.id,
          serviceName: services.name,
          staffId: bookings.staffUserId,
          staffName: users.name,
        })
        .from(bookings)
        .leftJoin(services, eq(services.id, bookings.serviceId))
        .leftJoin(users, eq(users.id, bookings.staffUserId))
        .where(eq(bookings.tenantId, args.tenantId));

      // Build a map of paid-amount per booking from the ledger window.
      const ledgerByBooking = new Map<string, number>();
      for (const r of rows) {
        if (r.bookingId && r.paidAt && r.paidAt >= args.dayStart && r.paidAt < args.dayEnd) {
          ledgerByBooking.set(
            r.bookingId,
            (ledgerByBooking.get(r.bookingId) ?? 0) + r.amountCents
          );
        }
      }
      const serviceAgg: Record<string, ServiceRevenueRow> = {};
      const staffAgg: Record<string, StaffRevenueRow> = {};
      for (const br of bookingRows) {
        if (!ledgerByBooking.has(br.bookingId)) continue;
        const revenue = ledgerByBooking.get(br.bookingId)!;
        if (br.serviceId) {
          const k = br.serviceId;
          serviceAgg[k] = serviceAgg[k] ?? {
            serviceId: k,
            serviceName: br.serviceName ?? k,
            revenueCents: 0,
            bookings: 0,
          };
          serviceAgg[k].revenueCents += revenue;
          serviceAgg[k].bookings += 1;
        }
        if (br.staffId) {
          const k = br.staffId;
          staffAgg[k] = staffAgg[k] ?? {
            staffId: k,
            staffName: br.staffName ?? k,
            revenueCents: 0,
            bookings: 0,
          };
          staffAgg[k].revenueCents += revenue;
          staffAgg[k].bookings += 1;
        }
      }
      serviceRevenue = Object.values(serviceAgg).sort((a, b) => b.revenueCents - a.revenueCents);
      staffRevenue = Object.values(staffAgg).sort((a, b) => b.revenueCents - a.revenueCents);
      void bookingIds; // reserved if future query optimization wants it
    }

    return { summary, serviceRevenue, staffRevenue };
  } catch (e) {
    console.error("[analytics] revenueMetrics failed:", e);
    return emptyRevenueDaily();
  }
}
