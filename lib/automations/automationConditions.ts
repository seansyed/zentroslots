/**
 * Conditional execution predicates for follow-up automations.
 *
 * Evaluated at queue-drain time (NOT enqueue time) so a "first time"
 * condition stays accurate if the customer happens to book a second
 * appointment between status flip and send.
 *
 * Pure-ish: predicates take a `BookingForCheck` and a DB handle, do
 * scoped queries, and return a boolean (with a structured reason on
 * failure). Tenant isolation is enforced — every DB read is scoped
 * by tenantId.
 */
import { and, asc, eq, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings } from "@/db/schema";

import type { PendingSkipReason } from "./types";

export type ConditionFailure = { ok: false; reason: PendingSkipReason };
export type ConditionPass = { ok: true };
export type ConditionResult = ConditionPass | ConditionFailure;

const PASS: ConditionPass = { ok: true };

/**
 * The customer (by email) has NEVER had a confirmed/completed booking
 * with this tenant before THIS booking.
 *
 * Email match is case-insensitive — same convention as the customers
 * table and the booking flow.
 */
export async function isFirstTimeCustomer(args: {
  tenantId: string;
  clientEmail: string;
  /** Booking we're evaluating around. Earlier bookings exist iff there's
   *  a non-cancelled booking with a startAt < this one. */
  bookingStartAt: Date;
}): Promise<ConditionResult> {
  const earlier = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, args.tenantId),
        sql`lower(${bookings.clientEmail}) = lower(${args.clientEmail})`,
        // Exclude cancelled — they aren't a real prior visit.
        sql`${bookings.status} <> 'cancelled'`,
        lt(bookings.startAt, args.bookingStartAt)
      )
    )
    .orderBy(asc(bookings.startAt))
    .limit(1);
  if (earlier.length > 0) return { ok: false, reason: "not_first_time_customer" };
  return PASS;
}

/**
 * The booking is in the 'completed' status.
 *
 * Caller passes the booking row (already loaded by the worker) so we
 * don't double-fetch.
 */
export function isCompletedBooking(args: {
  bookingStatus: string;
}): ConditionResult {
  if (args.bookingStatus !== "completed") {
    return { ok: false, reason: "not_completed" };
  }
  return PASS;
}

/**
 * Payment-required check.
 *
 * NOTE: This codebase doesn't have a `payments` or `invoices` table
 * today (see CLAUDE.md "KNOWN BROKEN — Subscription Payment Flow").
 * Until a payments table exists, this predicate FAILS CLOSED — when
 * an admin enables `require_successful_payment`, the automation is
 * SUPPRESSED rather than fired. Type-safe rule for future expansion:
 * when the payments table lands, the body of this function gets a
 * real query; the call site doesn't change.
 *
 * The admin UI surfaces a small "payments integration required" note
 * next to the toggle so admins know it's a no-op today.
 */
export async function hasSuccessfulPayment(args: {
  tenantId: string;
  bookingId: string;
}): Promise<ConditionResult> {
  // Reserved for future implementation. Pure failure for now —
  // safer than letting the automation fire without verifying.
  void args;
  return { ok: false, reason: "payment_required" };
}
