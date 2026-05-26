/**
 * Phase SMART-4 — no-show loss calculator.
 *
 * Pure aggregator. Reads (bookings + services) for the window and
 * computes:
 *   • Estimated lost revenue = sum(service.price) over no-show
 *     bookings in the window.
 *   • Wasted staff-minutes = sum(service.durationMinutes).
 *   • Per-service + per-customer breakdowns.
 *
 * The formula is intentionally SIMPLE so admins can audit it. No
 * synthetic "could have been booked instead" projection — that
 * would be a financial estimation without a clear formula, which
 * the SMART-4 spec explicitly forbids. We report ACTUAL lost
 * service price for ACTUAL no-shows.
 *
 * Strictly tenant-scoped. No mutation.
 */

import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services } from "@/db/schema";
import type {
  Cents,
  NoShowLossPerService,
  NoShowLossResult,
} from "./types";

const DEFAULT_WINDOW_DAYS = 30;

export async function computeNoShowLoss(args: {
  tenantId: string;
  windowDays?: number;
}): Promise<NoShowLossResult> {
  const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000);

  // Single indexed scan — bookings.status='no_show' + start in window.
  // We pull the service price + duration via join so the math is
  // done in app code (Postgres joins on 100s of rows are cheaper
  // than streaming raw rows + correlating; one query handles both).
  const rows = await db
    .select({
      bookingId: bookings.id,
      clientEmail: bookings.clientEmail,
      serviceId: bookings.serviceId,
      serviceName: services.name,
      servicePriceCents: services.price,
      serviceDurationMinutes: services.durationMinutes,
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .where(
      and(
        eq(bookings.tenantId, args.tenantId),
        eq(bookings.status, "no_show"),
        gte(bookings.startAt, windowStart),
        lt(bookings.startAt, now),
      ),
    );

  // ─── Totals ─────────────────────────────────────────────────────
  let totalLossCents: Cents = 0;
  let totalWastedMinutes = 0;

  // ─── Per-service rollup ─────────────────────────────────────────
  type Acc = {
    serviceName: string;
    count: number;
    lossCents: Cents;
    wastedMinutes: number;
    pricePerBookingCents: Cents;
  };
  const byService = new Map<string, Acc>();

  // ─── Per-customer rollup ────────────────────────────────────────
  const byCustomer = new Map<string, { count: number; lossCents: Cents }>();

  for (const r of rows) {
    // service.price is INTEGER (cents). Always int math — never float.
    const price = r.servicePriceCents ?? 0;
    const mins = r.serviceDurationMinutes ?? 0;
    totalLossCents += price;
    totalWastedMinutes += mins;

    // Per-service
    const existing = byService.get(r.serviceId);
    if (existing) {
      existing.count++;
      existing.lossCents += price;
      existing.wastedMinutes += mins;
    } else {
      byService.set(r.serviceId, {
        serviceName: r.serviceName,
        count: 1,
        lossCents: price,
        wastedMinutes: mins,
        pricePerBookingCents: price,
      });
    }

    // Per-customer
    const emailKey = r.clientEmail.toLowerCase();
    const cust = byCustomer.get(emailKey);
    if (cust) {
      cust.count++;
      cust.lossCents += price;
    } else {
      byCustomer.set(emailKey, { count: 1, lossCents: price });
    }
  }

  const perService: NoShowLossPerService[] = Array.from(
    byService.entries(),
  )
    .map(([serviceId, v]) => ({
      serviceId,
      serviceName: v.serviceName,
      count: v.count,
      estimatedLossCents: v.lossCents,
      wastedStaffMinutes: v.wastedMinutes,
      pricePerBookingCents: v.pricePerBookingCents,
    }))
    .sort((a, b) => b.estimatedLossCents - a.estimatedLossCents);

  // Top 10 customers by absolute loss.
  const topCustomers = Array.from(byCustomer.entries())
    .map(([email, v]) => ({
      email,
      count: v.count,
      estimatedLossCents: v.lossCents,
    }))
    .sort((a, b) => b.estimatedLossCents - a.estimatedLossCents)
    .slice(0, 10);

  return {
    windowDays,
    total: {
      count: rows.length,
      estimatedLossCents: totalLossCents,
      wastedStaffMinutes: totalWastedMinutes,
    },
    perService,
    topCustomers,
  };
}

/** Pure helper exposed for tests + composition. Given raw no-show
 *  rows, returns the same shape without a DB hit. */
export function rollupNoShowLossFromRows(
  rows: ReadonlyArray<{
    bookingId: string;
    clientEmail: string;
    serviceId: string;
    serviceName: string;
    servicePriceCents: Cents;
    serviceDurationMinutes: number;
  }>,
  windowDays: number,
): NoShowLossResult {
  let totalLossCents: Cents = 0;
  let totalWastedMinutes = 0;
  const byService = new Map<
    string,
    {
      serviceName: string;
      count: number;
      lossCents: Cents;
      wastedMinutes: number;
      pricePerBookingCents: Cents;
    }
  >();
  const byCustomer = new Map<string, { count: number; lossCents: Cents }>();

  for (const r of rows) {
    const price = r.servicePriceCents;
    const mins = r.serviceDurationMinutes;
    totalLossCents += price;
    totalWastedMinutes += mins;

    const ex = byService.get(r.serviceId);
    if (ex) {
      ex.count++;
      ex.lossCents += price;
      ex.wastedMinutes += mins;
    } else {
      byService.set(r.serviceId, {
        serviceName: r.serviceName,
        count: 1,
        lossCents: price,
        wastedMinutes: mins,
        pricePerBookingCents: price,
      });
    }

    const k = r.clientEmail.toLowerCase();
    const cu = byCustomer.get(k);
    if (cu) {
      cu.count++;
      cu.lossCents += price;
    } else {
      byCustomer.set(k, { count: 1, lossCents: price });
    }
  }

  return {
    windowDays,
    total: {
      count: rows.length,
      estimatedLossCents: totalLossCents,
      wastedStaffMinutes: totalWastedMinutes,
    },
    perService: Array.from(byService.entries())
      .map(([id, v]) => ({
        serviceId: id,
        serviceName: v.serviceName,
        count: v.count,
        estimatedLossCents: v.lossCents,
        wastedStaffMinutes: v.wastedMinutes,
        pricePerBookingCents: v.pricePerBookingCents,
      }))
      .sort((a, b) => b.estimatedLossCents - a.estimatedLossCents),
    topCustomers: Array.from(byCustomer.entries())
      .map(([email, v]) => ({
        email,
        count: v.count,
        estimatedLossCents: v.lossCents,
      }))
      .sort((a, b) => b.estimatedLossCents - a.estimatedLossCents)
      .slice(0, 10),
  };
}
