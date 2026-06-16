/**
 * Pure selection of the soonest upcoming bookings for the Home "Up next"
 * section. Dependency-free (type-only Appointment import is erased) so it is
 * unit-testable under node.
 *
 * Rules:
 *   • Only "confirmed" or "pending" bookings are upcoming (defense-in-depth —
 *     the Home queries already filter by these statuses, so cancelled /
 *     completed / no_show are excluded both server-side and here).
 *   • startAt >= now (epoch comparison; both sides are ms-since-epoch, so it is
 *     timezone-agnostic — a UTC instant compared to Date.now()).
 *   • Sorted ASCENDING (soonest first) and limited to `count`.
 */

import type { Appointment } from "@/api/appointments";

const UPCOMING_STATUSES = new Set<string>(["confirmed", "pending"]);

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
