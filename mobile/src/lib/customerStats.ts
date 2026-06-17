/**
 * Pure derivation of the customer-detail Stats-card aggregates from the
 * booking history the DETAIL endpoint returns.
 *
 * The detail route responds { customer, history } where `customer` is the raw
 * row WITHOUT the per-customer totals — those are computed only by the LIST
 * route. So the detail screen must derive them, matching the list route's
 * semantics: total = COUNT(*), completed/cancelled = status counts,
 * lastAppointmentAt = MAX(startAt). Keeping this in a dependency-free module
 * (no RN/axios imports) makes it unit-testable. Exact for ≤100 bookings (the
 * detail history is server-capped at 100).
 */

export type CustomerStats = {
  totalBookings: number;
  completed: number;
  cancelled: number;
  lastAppointmentAt: string | null;
};

export function deriveStatsFromHistory(
  history: ReadonlyArray<{ startAt: string; status: string }>,
): CustomerStats {
  let completed = 0;
  let cancelled = 0;
  let lastAppointmentAt: string | null = null;
  for (const h of history) {
    if (h.status === "completed") completed += 1;
    else if (h.status === "cancelled") cancelled += 1;
    // startAt is UTC ISO-8601 → lexicographic max == chronological max.
    if (h.startAt && (lastAppointmentAt === null || h.startAt > lastAppointmentAt)) {
      lastAppointmentAt = h.startAt;
    }
  }
  return { totalBookings: history.length, completed, cancelled, lastAppointmentAt };
}
