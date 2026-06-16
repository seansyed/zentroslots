/**
 * Pure selection of the soonest upcoming bookings for the Home "Up next"
 * section. Dependency-free (type-only Appointment import is erased) so it is
 * unit-testable under node.
 *
 * Rules:
 *   • Canonical UPCOMING status set = confirmed, pending, pending_payment.
 *     pending_payment is a real appointment (a paid booking on a short payment
 *     hold) and MUST appear — the reported bug was it being dropped while
 *     Activity still showed it. Excluded: cancelled, completed, no_show,
 *     payment_failed, refunded (terminal / dead). Defense-in-depth: the Home
 *     queries already filter by the three upcoming statuses server-side.
 *   • startAt >= now (epoch comparison; both sides are ms-since-epoch, so it is
 *     timezone-agnostic — a UTC instant compared to Date.now()).
 *   • Sorted ASCENDING (soonest first) and limited to `count`.
 */

import type { Appointment } from "@/api/appointments";

const UPCOMING_STATUSES = new Set<string>(["confirmed", "pending", "pending_payment"]);

export function selectUpcoming(
  rows: Appointment[],
  nowMs: number,
  count: number,
): Appointment[] {
  return rows
    .filter(
      (r) =>
        UPCOMING_STATUSES.has(r.status) &&
        new Date(r.startAt).getTime() >= nowMs,
    )
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
    .slice(0, count);
}
