/**
 * Staff utilization helpers — used by the dashboard to show
 * "X bookings/staff/day" + fairness distribution.
 *
 * NOT part of the daily snapshot (would bloat the row); computed
 * on-read from the per-day snapshot.extras.staffAssignments map +
 * the tenant's active staff list.
 */

export type FairnessDistribution = {
  staff: { staffId: string; staffName: string; count: number; sharePercent: number }[];
  /** Coefficient of variation (stddev / mean) of per-staff counts.
   *  0 = perfectly even; higher = more uneven. Useful for the
   *  operational-insight emitter. */
  unevenness: number;
};

/** Compute a fairness distribution from a per-staff count map. Pure.
 *  Returns 0 unevenness when fewer than 2 staff have any bookings. */
export function computeFairness(
  staffAssignments: Record<string, number>
): FairnessDistribution {
  const entries = Object.entries(staffAssignments);
  const total = entries.reduce((acc, [, n]) => acc + n, 0);
  if (entries.length === 0 || total === 0) {
    return { staff: [], unevenness: 0 };
  }
  const sorted = entries
    .map(([id, n]) => ({
      staffId: id,
      staffName: id, // caller can replace with real name if needed
      count: n,
      sharePercent: Math.round((n / total) * 100),
    }))
    .sort((a, b) => b.count - a.count);

  if (entries.length < 2) {
    return { staff: sorted, unevenness: 0 };
  }
  const mean = total / entries.length;
  const variance =
    entries.reduce((acc, [, n]) => acc + (n - mean) ** 2, 0) / entries.length;
  const stddev = Math.sqrt(variance);
  const unevenness = mean === 0 ? 0 : stddev / mean;
  return { staff: sorted, unevenness };
}
