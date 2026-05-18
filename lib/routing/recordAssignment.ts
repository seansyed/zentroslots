/**
 * Record an assignment after a successful booking insert.
 *
 * Called fire-and-forget from /api/bookings POST. Updates the
 * staff_assignment_stats row for this (tenant, staff) — increments
 * totalAssignments and the rolling today/week counters, refreshing
 * the day/week window anchors when they've rolled over.
 *
 * Never throws. A stats-update failure must NEVER fail a booking.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { staffAssignmentStats } from "@/db/schema";

export async function recordAssignment(args: {
  tenantId: string;
  staffId: string;
}): Promise<void> {
  try {
    const now = new Date();
    const todayKey = utcDayKey(now);
    const weekKey = utcIsoWeekKey(now);

    const existing = await db.query.staffAssignmentStats.findFirst({
      where: and(
        eq(staffAssignmentStats.tenantId, args.tenantId),
        eq(staffAssignmentStats.staffId, args.staffId)
      ),
    });

    if (existing) {
      const sameDay =
        existing.dayWindowStart && utcDayKey(existing.dayWindowStart) === todayKey;
      const sameWeek =
        existing.weekWindowStart && utcIsoWeekKey(existing.weekWindowStart) === weekKey;
      await db
        .update(staffAssignmentStats)
        .set({
          totalAssignments: existing.totalAssignments + 1,
          assignmentsToday: (sameDay ? existing.assignmentsToday : 0) + 1,
          assignmentsThisWeek: (sameWeek ? existing.assignmentsThisWeek : 0) + 1,
          dayWindowStart: sameDay ? existing.dayWindowStart : now,
          weekWindowStart: sameWeek ? existing.weekWindowStart : now,
          lastAssignedAt: now,
          updatedAt: now,
        })
        .where(eq(staffAssignmentStats.id, existing.id));
    } else {
      // Insert with the rolling counters initialized.
      try {
        await db.insert(staffAssignmentStats).values({
          tenantId: args.tenantId,
          staffId: args.staffId,
          totalAssignments: 1,
          assignmentsToday: 1,
          assignmentsThisWeek: 1,
          dayWindowStart: now,
          weekWindowStart: now,
          lastAssignedAt: now,
        });
      } catch (e: unknown) {
        // Race: another booking landed first and created the row. Fall
        // back to an UPDATE on the now-existing row.
        if ((e as { code?: string })?.code === "23505") {
          const racedRow = await db.query.staffAssignmentStats.findFirst({
            where: and(
              eq(staffAssignmentStats.tenantId, args.tenantId),
              eq(staffAssignmentStats.staffId, args.staffId)
            ),
          });
          if (racedRow) {
            await db
              .update(staffAssignmentStats)
              .set({
                totalAssignments: racedRow.totalAssignments + 1,
                assignmentsToday: racedRow.assignmentsToday + 1,
                assignmentsThisWeek: racedRow.assignmentsThisWeek + 1,
                lastAssignedAt: now,
                updatedAt: now,
              })
              .where(eq(staffAssignmentStats.id, racedRow.id));
          }
        }
        // Other errors: silently swallow — booking already committed.
      }
    }
  } catch (e) {
    console.error("[routing] recordAssignment failed (booking unaffected):", e);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * ISO week key in UTC. Returns "YYYY-Www" where Www is 1..53.
 * We don't need full ISO compliance — just a stable key per
 * Mon-anchored UTC week. The standard JS approach.
 */
function utcIsoWeekKey(d: Date): string {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Move to Thursday of this ISO week (ISO defines week by its Thursday).
  const dayNum = target.getUTCDay() || 7; // Sun=0 → 7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
