/**
 * Global Copilot Brief — Phase 9A.
 *
 * Synthesizes a cross-module operational brief for the calling tenant
 * by combining a small set of bounded queries across:
 *
 *   - bookings (calendar load + recent cancellations)
 *   - customers (VIP roster + dormant VIPs)
 *   - tasks (open + overdue queue)
 *   - communicationLogs (24h delivery health)
 *
 * No new tables, no schema changes — every query is tenant-scoped and
 * uses only existing columns. The body is a deterministic synthesis;
 * the "AI" framing belongs to the surface, not the data.
 *
 * Tenant isolation is enforced by requireUser() + explicit tenantId
 * predicates on every clause. The endpoint deliberately never throws
 * on empty data — instead it returns a calm fallback brief so the
 * surface stays graceful for new tenants.
 */
import { NextResponse } from "next/server";
import { and, eq, gte, isNotNull, lt, lte, ne, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  analyticsDailySnapshots,
  bookings,
  communicationLogs,
  customers,
  tasks,
} from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Tone = "positive" | "warning" | "brand" | "neutral";
type Module = "calendar" | "appointments" | "customers" | "communications" | "tasks" | "analytics";

type Signal = {
  id: string;
  module: Module;
  tone: Tone;
  title: string;
  detail: string;
  href?: string;
  actionLabel?: string;
};

type QuickAction = {
  id: string;
  label: string;
  description: string;
  href: string;
  module: Module;
};

export async function GET() {
  try {
    const caller = await requireUser();
    const tenantId = caller.tenantId;

    const now = new Date();
    const today0 = new Date(now);
    today0.setHours(0, 0, 0, 0);
    const tomorrow0 = new Date(today0.getTime() + 86_400_000);
    const in7d = new Date(today0.getTime() + 7 * 86_400_000);
    const last7dStart = new Date(today0.getTime() - 7 * 86_400_000);
    const last14dStart = new Date(today0.getTime() - 14 * 86_400_000);
    const last30dStart = new Date(today0.getTime() - 30 * 86_400_000);
    const last48hStart = new Date(now.getTime() - 48 * 3_600_000);
    const last24hStart = new Date(now.getTime() - 24 * 3_600_000);

    const cancelledStatus = "cancelled" as const;

    // All counts run in parallel — every where clause carries tenantId.
    const [
      todayBookings,
      next7dBookings,
      prev7dCompleted,
      recent48hCancels,
      vipCount,
      vipRecentCommRows,
      openTasksCount,
      overdueTasksCount,
      comms24hTotal,
      comms24hFailed,
      snapshotsRecent,
    ] = await Promise.all([
      db
        .select({ c: sql<number>`count(*)::int` })
        .from(bookings)
        .where(
          and(
            eq(bookings.tenantId, tenantId),
            gte(bookings.startAt, today0),
            lt(bookings.startAt, tomorrow0),
            ne(bookings.status, cancelledStatus),
          ),
        ),
      db
        .select({ c: sql<number>`count(*)::int` })
        .from(bookings)
        .where(
          and(
            eq(bookings.tenantId, tenantId),
            gte(bookings.startAt, today0),
            lt(bookings.startAt, in7d),
            ne(bookings.status, cancelledStatus),
          ),
        ),
      db
        .select({ c: sql<number>`count(*)::int` })
        .from(bookings)
        .where(
          and(
            eq(bookings.tenantId, tenantId),
            gte(bookings.startAt, last7dStart),
            lt(bookings.startAt, today0),
            ne(bookings.status, cancelledStatus),
          ),
        ),
      db
        .select({ c: sql<number>`count(*)::int` })
        .from(bookings)
        .where(
          and(
            eq(bookings.tenantId, tenantId),
            gte(bookings.updatedAt, last48hStart),
            eq(bookings.status, cancelledStatus),
          ),
        ),
      db
        .select({ c: sql<number>`count(*)::int` })
        .from(customers)
        .where(and(eq(customers.tenantId, tenantId), eq(customers.status, "vip"))),
      db
        .select({
          customerId: customers.id,
          lastComm: sql<Date | null>`max(${communicationLogs.createdAt})`,
        })
        .from(customers)
        .leftJoin(
          communicationLogs,
          and(
            eq(communicationLogs.tenantId, tenantId),
            eq(communicationLogs.customerId, customers.id),
            gte(communicationLogs.createdAt, last14dStart),
          ),
        )
        .where(and(eq(customers.tenantId, tenantId), eq(customers.status, "vip")))
        .groupBy(customers.id),
      db
        .select({ c: sql<number>`count(*)::int` })
        .from(tasks)
        .where(and(eq(tasks.tenantId, tenantId), eq(tasks.status, "open"))),
      db
        .select({ c: sql<number>`count(*)::int` })
        .from(tasks)
        .where(
          and(
            eq(tasks.tenantId, tenantId),
            eq(tasks.status, "open"),
            isNotNull(tasks.dueAt),
            lt(tasks.dueAt, now),
          ),
        ),
      db
        .select({ c: sql<number>`count(*)::int` })
        .from(communicationLogs)
        .where(and(eq(communicationLogs.tenantId, tenantId), gte(communicationLogs.createdAt, last24hStart))),
      db
        .select({ c: sql<number>`count(*)::int` })
        .from(communicationLogs)
        .where(
          and(
            eq(communicationLogs.tenantId, tenantId),
            gte(communicationLogs.createdAt, last24hStart),
            or(eq(communicationLogs.status, "failed"), eq(communicationLogs.status, "bounced")),
          ),
        ),
      db
        .select({
          snapshotDate: analyticsDailySnapshots.snapshotDate,
          totalBookings: analyticsDailySnapshots.totalBookings,
          cancelledBookings: analyticsDailySnapshots.cancelledBookings,
          completedBookings: analyticsDailySnapshots.completedBookings,
        })
        .from(analyticsDailySnapshots)
        .where(
          and(
            eq(analyticsDailySnapshots.tenantId, tenantId),
            gte(analyticsDailySnapshots.snapshotDate, last30dStart.toISOString().slice(0, 10)),
            lte(analyticsDailySnapshots.snapshotDate, today0.toISOString().slice(0, 10)),
          ),
        ),
    ]);

    const today = todayBookings[0]?.c ?? 0;
    const next7 = next7dBookings[0]?.c ?? 0;
    const prev7 = prev7dCompleted[0]?.c ?? 0;
    const cancels48 = recent48hCancels[0]?.c ?? 0;
    const vips = vipCount[0]?.c ?? 0;
    const dormantVips = vipRecentCommRows.filter((r) => r.lastComm === null).length;
    const openTasks = openTasksCount[0]?.c ?? 0;
    const overdueTasks = overdueTasksCount[0]?.c ?? 0;
    const comms24 = comms24hTotal[0]?.c ?? 0;
    const commsFailed = comms24hFailed[0]?.c ?? 0;
    const commsHealthPct = comms24 > 0 ? Math.round(((comms24 - commsFailed) / comms24) * 100) : 100;

    const avgDailyPrev = prev7 > 0 ? prev7 / 7 : 0;
    const loadVsAvg = avgDailyPrev > 0 ? Math.round(((today - avgDailyPrev) / avgDailyPrev) * 100) : 0;

    const snapshotAvgBookings =
      snapshotsRecent.length > 0
        ? snapshotsRecent.reduce((s, r) => s + r.totalBookings, 0) / snapshotsRecent.length
        : 0;

    // ── Synthesize the headline + signals ──────────────────────────
    const signals: Signal[] = [];

    // Calendar load
    if (today > 0) {
      const loadDelta =
        loadVsAvg > 25 ? "well above" :
        loadVsAvg > 10 ? "running heavier than" :
        loadVsAvg < -25 ? "noticeably lighter than" :
        loadVsAvg < -10 ? "lighter than" :
        "in line with";
      signals.push({
        id: "today-load",
        module: "calendar",
        tone: loadVsAvg > 25 ? "warning" : loadVsAvg < -25 ? "warning" : loadVsAvg > 10 ? "brand" : "neutral",
        title: `${today} ${today === 1 ? "booking" : "bookings"} today`,
        detail: `${loadDelta} the 7-day average${avgDailyPrev > 0 ? ` (${Math.round(avgDailyPrev)})` : ""}.`,
        href: "/dashboard/calendar",
        actionLabel: "Open calendar",
      });
    } else {
      signals.push({
        id: "today-load",
        module: "calendar",
        tone: "neutral",
        title: "No bookings on the calendar today",
        detail: "A quiet day — good window to address open optimization recommendations.",
        href: "/dashboard/calendar",
        actionLabel: "Open calendar",
      });
    }

    // Upcoming week
    if (next7 > 0) {
      signals.push({
        id: "next-7d",
        module: "appointments",
        tone: next7 > Math.max(10, prev7) ? "brand" : "neutral",
        title: `${next7} ${next7 === 1 ? "appointment" : "appointments"} in the next 7 days`,
        detail:
          prev7 > 0
            ? `Last 7 days delivered ${prev7}. ${next7 >= prev7 ? "Momentum is holding." : "Volume is softer."}`
            : "First-time window — no prior baseline to compare against yet.",
        href: "/dashboard/appointments",
        actionLabel: "Review schedule",
      });
    }

    // Cancellation cluster
    if (cancels48 >= 3) {
      signals.push({
        id: "cancel-cluster",
        module: "appointments",
        tone: cancels48 >= 6 ? "warning" : "warning",
        title: `${cancels48} cancellations in the last 48 hours`,
        detail:
          cancels48 >= 6
            ? "Worth a focused review — could indicate friction in the booking experience or reminder cadence."
            : "Small cluster — quick review will tell whether it's a pattern or noise.",
        href: "/dashboard/appointments",
        actionLabel: "Review cancellations",
      });
    }

    // VIP relationship
    if (vips > 0 && dormantVips > 0) {
      signals.push({
        id: "vip-dormant",
        module: "customers",
        tone: "warning",
        title: `${dormantVips} ${dormantVips === 1 ? "VIP customer hasn't" : "VIP customers haven't"} been contacted in 14+ days`,
        detail: "Relationship layer signal — a short outreach window typically restores cadence.",
        href: "/dashboard/customers",
        actionLabel: "Open VIP list",
      });
    } else if (vips > 0) {
      signals.push({
        id: "vip-healthy",
        module: "customers",
        tone: "positive",
        title: `VIP engagement is healthy`,
        detail: `All ${vips} VIP ${vips === 1 ? "customer has" : "customers have"} had recent touchpoints.`,
        href: "/dashboard/customers",
        actionLabel: "Open VIP list",
      });
    }

    // Task load
    if (overdueTasks > 0) {
      signals.push({
        id: "tasks-overdue",
        module: "tasks",
        tone: overdueTasks >= 5 ? "warning" : "warning",
        title: `${overdueTasks} ${overdueTasks === 1 ? "task is" : "tasks are"} overdue`,
        detail: `Total open queue: ${openTasks}. Overdue items typically cascade into response-time pressure.`,
        href: "/dashboard/tasks",
        actionLabel: "Open task queue",
      });
    } else if (openTasks >= 10) {
      signals.push({
        id: "tasks-pile",
        module: "tasks",
        tone: "brand",
        title: `Task queue at ${openTasks}`,
        detail: "Nothing overdue, but the queue is building. Consider assigning or batching this week.",
        href: "/dashboard/tasks",
        actionLabel: "Open task queue",
      });
    }

    // Communications delivery health
    if (comms24 > 0) {
      if (commsHealthPct < 90) {
        signals.push({
          id: "comms-health",
          module: "communications",
          tone: "warning",
          title: `Communications delivery at ${commsHealthPct}%`,
          detail: `${commsFailed} of ${comms24} messages failed in the last 24 hours. Worth checking provider health.`,
          href: "/dashboard/communications",
          actionLabel: "Review communications",
        });
      } else if (commsHealthPct >= 98) {
        signals.push({
          id: "comms-healthy",
          module: "communications",
          tone: "positive",
          title: `Communications running smoothly`,
          detail: `${commsHealthPct}% delivery success across ${comms24} message${comms24 === 1 ? "" : "s"} in the last 24 hours.`,
          href: "/dashboard/communications",
          actionLabel: "Open communications",
        });
      }
    }

    // Operational baseline (analytics)
    if (snapshotsRecent.length >= 7) {
      signals.push({
        id: "analytics-baseline",
        module: "analytics",
        tone: "neutral",
        title: `${snapshotsRecent.length}d of operational history available`,
        detail: `Average daily volume: ${Math.round(snapshotAvgBookings)} bookings. Open executive analytics for the full picture.`,
        href: "/dashboard/analytics/executive",
        actionLabel: "Open executive analytics",
      });
    }

    // ── Headline + tone ────────────────────────────────────────────
    let headline = "Operations are calm and balanced today.";
    let tone: Tone = "brand";

    if (cancels48 >= 6) {
      headline = `Cancellation activity is elevated — ${cancels48} in the last 48 hours.`;
      tone = "warning";
    } else if (overdueTasks >= 5) {
      headline = `${overdueTasks} overdue tasks are pulling on the operational layer.`;
      tone = "warning";
    } else if (commsHealthPct < 90 && comms24 > 0) {
      headline = `Communications delivery dropped to ${commsHealthPct}% — worth a quick check.`;
      tone = "warning";
    } else if (loadVsAvg >= 25 && today > 0) {
      headline = `Today's calendar is running ${loadVsAvg}% above your weekly average.`;
      tone = "brand";
    } else if (dormantVips > 0 && vips > 0) {
      headline = `${dormantVips} VIP ${dormantVips === 1 ? "customer needs" : "customers need"} a touchpoint this week.`;
      tone = "brand";
    } else if (today === 0 && next7 > 0) {
      headline = `Quiet day on the calendar — ${next7} ${next7 === 1 ? "appointment" : "appointments"} coming up this week.`;
      tone = "neutral";
    } else if (today > 0) {
      headline = `${today} ${today === 1 ? "booking" : "bookings"} on the schedule today. Operations are running on plan.`;
      tone = "positive";
    }

    // ── Quick actions (global) ─────────────────────────────────────
    const quickActions: QuickAction[] = [
      {
        id: "open-calendar",
        label: "Open calendar",
        description: "Today's schedule and the next 7 days",
        href: "/dashboard/calendar",
        module: "calendar",
      },
      {
        id: "open-tasks",
        label: "Review tasks",
        description: overdueTasks > 0 ? `${overdueTasks} overdue · ${openTasks} open` : `${openTasks} open`,
        href: "/dashboard/tasks",
        module: "tasks",
      },
      {
        id: "open-customers",
        label: "Open customer list",
        description: vips > 0 ? `${vips} VIP · all customers` : "Manage customers and segments",
        href: "/dashboard/customers",
        module: "customers",
      },
      {
        id: "open-communications",
        label: "Review communications",
        description: comms24 > 0 ? `${comms24} message${comms24 === 1 ? "" : "s"} (24h) · ${commsHealthPct}% delivery` : "Operational message stream",
        href: "/dashboard/communications",
        module: "communications",
      },
      {
        id: "open-analytics",
        label: "Open executive analytics",
        description: "Daily brief, KPIs, optimization recommendations",
        href: "/dashboard/analytics/executive",
        module: "analytics",
      },
    ];

    return NextResponse.json({
      brief: {
        headline,
        tone,
        generatedAt: now.toISOString(),
        dayLabel: now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }),
      },
      metrics: {
        todayBookings: today,
        next7dBookings: next7,
        prev7dCompleted: prev7,
        cancels48h: cancels48,
        vips,
        dormantVips,
        openTasks,
        overdueTasks,
        comms24h: comms24,
        commsHealthPct,
        loadVsAvgPct: loadVsAvg,
        snapshotDays: snapshotsRecent.length,
      },
      signals,
      quickActions,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
