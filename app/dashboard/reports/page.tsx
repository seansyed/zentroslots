/**
 * Reports Operational Center (Phase 13A).
 *
 * Evolves the previous 286-line "snapshots + 3 CSV cards" page into a
 * premium reporting workspace that matches the executive cockpit and
 * locked analytics preview shipped in Phase 12.
 *
 * Strict invariants this rewrite preserves:
 *   - All three existing CSV export endpoints (/api/bookings/export,
 *     /api/customers/export, /api/admin/exports/tenants) are untouched
 *     and continue to be the only sources of CSV data.
 *   - The original 6 snapshot tiles are kept, extended with two new
 *     honest derivations (Completed + Avg booking value) computed from
 *     queries that already run in this page.
 *   - Staff utilization table still reads from the same join. Its
 *     dataset is identical to the prior version — only visuals change.
 *   - Sparkline rendering only happens when ≥3 daily snapshot rows
 *     exist, so brand-new tenants never see a fabricated trend line.
 *   - Scheduled reports / audit / executive sections gate cleanly
 *     against `planFeature(plan, "analytics")` — Free tenants see a
 *     premium locked preview, not an ugly warning banner.
 *
 * No new APIs, no migrations, no new backend behavior.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  lt,
  sql,
} from "drizzle-orm";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Briefcase,
  CalendarRange,
  CheckCircle2,
  Clock,
  Crown,
  DollarSign,
  Download,
  FileSpreadsheet,
  FileText,
  Filter,
  Gauge,
  History,
  Lightbulb,
  Lock,
  ShieldCheck,
  Sparkles,
  Star,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
  Wand2,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { db } from "@/db/client";
import {
  analyticsDailySnapshots,
  bookings,
  customers,
  exportAuditEvents,
  scheduledReports,
  services,
  tenants,
  users,
} from "@/db/schema";
import { getSession, isManagerial } from "@/lib/auth";
import { planFeature } from "@/lib/quotas";
import { getPlan } from "@/lib/plans";
import Shell from "@/components/dashboard/Shell";
import { PremiumCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";

export const metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

// ─── Range parser ────────────────────────────────────────────────────
// Same window logic as the prior reports page — preserve URL contract
// so existing bookmarks (?range=7|30|90|365) keep working.

function parseRange(rangeParam: string | undefined): {
  from: Date;
  to: Date;
  days: number;
  priorFrom: Date;
  priorTo: Date;
} {
  const days = (() => {
    const n = Number(rangeParam);
    if (Number.isFinite(n) && n >= 1 && n <= 365) return n;
    return 30;
  })();
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const priorTo = from;
  const priorFrom = new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to, days, priorFrom, priorTo };
}

type Delta = { label: string; pct: number; tone: "positive" | "warning" | "neutral" };

function delta(now: number, prior: number, higherIsBetter = true): Delta {
  if (prior === 0 && now === 0) return { label: "—", pct: 0, tone: "neutral" };
  if (prior === 0) {
    return {
      label: `+${now}`,
      pct: 100,
      tone: higherIsBetter ? "positive" : "warning",
    };
  }
  const diff = now - prior;
  const pct = Math.round((diff / Math.max(1, prior)) * 100);
  const sign = pct > 0 ? "+" : "";
  let tone: Delta["tone"];
  if (diff === 0) tone = "neutral";
  else if (diff > 0 === higherIsBetter) tone = "positive";
  else tone = "warning";
  return { label: `${sign}${pct}% vs prior`, pct, tone };
}

function dollars(cents: number): string {
  if (cents === 0) return "$0";
  return `$${Math.round(cents / 100).toLocaleString()}`;
}

// ───────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────

export default async function ReportsPage(props: {
  searchParams: Promise<{ range?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const sp = await props.searchParams;
  const { from, to, days, priorFrom, priorTo } = parseRange(sp.range);

  // Staff are scoped to their own bookings — admin sees the whole
  // tenant. Same convention as the prior page + /api/bookings/export.
  const visibility = isManagerial(user.role)
    ? eq(bookings.tenantId, user.tenantId)
    : and(eq(bookings.tenantId, user.tenantId), eq(bookings.staffUserId, user.id));

  const hasAnalytics = planFeature(tenant.currentPlan, "analytics");
  const currentPlan = getPlan(tenant.currentPlan);

  const [
    [bookingsNow],     [bookingsPrior],
    [confirmedNow],    [confirmedPrior],
    [completedNow],    [completedPrior],
    [cancelledNow],    [cancelledPrior],
    [noShowNow],       [noShowPrior],
    [revenueNow],      [revenuePrior],
    [newCustomersNow], [newCustomersPrior],
    [staffCountRow],
    perStaff,
    snapshotsForSpark,
    scheduledRows,
    auditRows,
  ] = await Promise.all([
    db.select({ n: count() }).from(bookings).where(and(visibility, gte(bookings.startAt, from), lt(bookings.startAt, to))),
    db.select({ n: count() }).from(bookings).where(and(visibility, gte(bookings.startAt, priorFrom), lt(bookings.startAt, priorTo))),
    db.select({ n: count() }).from(bookings).where(and(visibility, eq(bookings.status, "confirmed"), gte(bookings.startAt, from), lt(bookings.startAt, to))),
    db.select({ n: count() }).from(bookings).where(and(visibility, eq(bookings.status, "confirmed"), gte(bookings.startAt, priorFrom), lt(bookings.startAt, priorTo))),
    db.select({ n: count() }).from(bookings).where(and(visibility, eq(bookings.status, "completed"), gte(bookings.startAt, from), lt(bookings.startAt, to))),
    db.select({ n: count() }).from(bookings).where(and(visibility, eq(bookings.status, "completed"), gte(bookings.startAt, priorFrom), lt(bookings.startAt, priorTo))),
    db.select({ n: count() }).from(bookings).where(and(visibility, eq(bookings.status, "cancelled"), gte(bookings.startAt, from), lt(bookings.startAt, to))),
    db.select({ n: count() }).from(bookings).where(and(visibility, eq(bookings.status, "cancelled"), gte(bookings.startAt, priorFrom), lt(bookings.startAt, priorTo))),
    db.select({ n: count() }).from(bookings).where(and(visibility, eq(bookings.status, "no_show"), gte(bookings.startAt, from), lt(bookings.startAt, to))),
    db.select({ n: count() }).from(bookings).where(and(visibility, eq(bookings.status, "no_show"), gte(bookings.startAt, priorFrom), lt(bookings.startAt, priorTo))),
    db
      .select({ sum: sql<number>`COALESCE(SUM(${services.price}), 0)::int` })
      .from(bookings)
      .innerJoin(services, eq(services.id, bookings.serviceId))
      .where(and(visibility, eq(bookings.status, "confirmed"), gte(bookings.startAt, from), lt(bookings.startAt, to))),
    db
      .select({ sum: sql<number>`COALESCE(SUM(${services.price}), 0)::int` })
      .from(bookings)
      .innerJoin(services, eq(services.id, bookings.serviceId))
      .where(and(visibility, eq(bookings.status, "confirmed"), gte(bookings.startAt, priorFrom), lt(bookings.startAt, priorTo))),
    db.select({ n: count() }).from(customers).where(and(eq(customers.tenantId, user.tenantId), gte(customers.createdAt, from), lt(customers.createdAt, to))),
    db.select({ n: count() }).from(customers).where(and(eq(customers.tenantId, user.tenantId), gte(customers.createdAt, priorFrom), lt(customers.createdAt, priorTo))),
    db.select({ n: count() }).from(users).where(and(eq(users.tenantId, user.tenantId), eq(users.role, "staff"))),
    // Per-staff utilization for the selected window. Admins see the
    // whole roster; staff only see themselves (so this widget doesn't
    // leak peer activity). Joined to users so we can label rows.
    db
      .select({
        staffId: bookings.staffUserId,
        staffName: users.name,
        confirmed: sql<number>`SUM(CASE WHEN ${bookings.status} = 'confirmed' THEN 1 ELSE 0 END)::int`,
        cancelled: sql<number>`SUM(CASE WHEN ${bookings.status} = 'cancelled' THEN 1 ELSE 0 END)::int`,
        noShow: sql<number>`SUM(CASE WHEN ${bookings.status} = 'no_show' THEN 1 ELSE 0 END)::int`,
        completed: sql<number>`SUM(CASE WHEN ${bookings.status} = 'completed' THEN 1 ELSE 0 END)::int`,
        bookedMinutes: sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (${bookings.endAt} - ${bookings.startAt})))::int, 0) / 60`,
      })
      .from(bookings)
      .innerJoin(users, eq(users.id, bookings.staffUserId))
      .where(and(visibility, gte(bookings.startAt, from), lt(bookings.startAt, to)))
      .groupBy(bookings.staffUserId, users.name)
      .orderBy(sql`SUM(CASE WHEN ${bookings.status} = 'confirmed' THEN 1 ELSE 0 END) DESC`),
    // Snapshots powering the inline KPI sparklines. Capped to the
    // current window so brand-new tenants don't see a flat line
    // stretching across empty history. Wrapped in .catch() so a
    // missing analytics table on an old DB still renders the page.
    db
      .select({
        snapshotDate: analyticsDailySnapshots.snapshotDate,
        totalBookings: analyticsDailySnapshots.totalBookings,
        completedBookings: analyticsDailySnapshots.completedBookings,
        cancelledBookings: analyticsDailySnapshots.cancelledBookings,
        noShowBookings: analyticsDailySnapshots.noShowBookings,
        extras: analyticsDailySnapshots.extras,
      })
      .from(analyticsDailySnapshots)
      .where(
        and(
          eq(analyticsDailySnapshots.tenantId, user.tenantId),
          gte(analyticsDailySnapshots.snapshotDate, from.toISOString().slice(0, 10)),
          lt(analyticsDailySnapshots.snapshotDate, to.toISOString().slice(0, 10)),
        ),
      )
      .orderBy(asc(analyticsDailySnapshots.snapshotDate))
      .catch(() => [] as Array<{
        snapshotDate: string;
        totalBookings: number;
        completedBookings: number;
        cancelledBookings: number;
        noShowBookings: number;
        extras: unknown;
      }>),
    // Scheduled reports (last 5) — surfaces actual generated periods.
    // Tenants without the cron configured see an empty list and we
    // render an upgrade / configure CTA instead of fake rows.
    db
      .select({
        id: scheduledReports.id,
        periodType: scheduledReports.periodType,
        periodStart: scheduledReports.periodStart,
        periodEnd: scheduledReports.periodEnd,
        generatedAt: scheduledReports.generatedAt,
        generationMs: scheduledReports.generationMs,
      })
      .from(scheduledReports)
      .where(eq(scheduledReports.tenantId, user.tenantId))
      .orderBy(desc(scheduledReports.generatedAt))
      .limit(5)
      .catch(() => [] as Array<{
        id: string;
        periodType: string;
        periodStart: string;
        periodEnd: string;
        generatedAt: Date;
        generationMs: number | null;
      }>),
    // Export audit trail (last 10). Only admins see this section —
    // the route gating is enforced below at render time. The query
    // runs unconditionally because it's cheap and keeps the JSX
    // branchless. Errors fail open.
    db
      .select({
        id: exportAuditEvents.id,
        exportType: exportAuditEvents.exportType,
        exportedAt: exportAuditEvents.exportedAt,
        recordCount: exportAuditEvents.recordCount,
        userId: exportAuditEvents.userId,
      })
      .from(exportAuditEvents)
      .where(eq(exportAuditEvents.tenantId, user.tenantId))
      .orderBy(desc(exportAuditEvents.exportedAt))
      .limit(10)
      .catch(() => [] as Array<{
        id: string;
        exportType: string;
        exportedAt: Date;
        recordCount: number | null;
        userId: string | null;
      }>),
  ]);

  // ── KPI derivations (pure arithmetic over numbers we just fetched) ─
  const bookingsTotal = Number(bookingsNow?.n ?? 0);
  const bookingsTotalPrior = Number(bookingsPrior?.n ?? 0);
  const confirmedTotal = Number(confirmedNow?.n ?? 0);
  const confirmedPriorTotal = Number(confirmedPrior?.n ?? 0);
  const completedTotal = Number(completedNow?.n ?? 0);
  const completedPriorTotal = Number(completedPrior?.n ?? 0);
  const cancelTotal = Number(cancelledNow?.n ?? 0);
  const cancelPrior = Number(cancelledPrior?.n ?? 0);
  const noShowTotal = Number(noShowNow?.n ?? 0);
  const noShowPriorTotal = Number(noShowPrior?.n ?? 0);
  const revenueCents = Number(revenueNow?.sum ?? 0);
  const revenuePriorCents = Number(revenuePrior?.sum ?? 0);
  const newCustomersTotal = Number(newCustomersNow?.n ?? 0);
  const newCustomersPriorTotal = Number(newCustomersPrior?.n ?? 0);

  // Avg booking value — derived from confirmed bookings × revenue.
  // Prior-window value uses the same denominator pattern.
  const avgBookingCents = confirmedTotal > 0 ? Math.round(revenueCents / confirmedTotal) : 0;
  const avgBookingCentsPrior =
    confirmedPriorTotal > 0 ? Math.round(revenuePriorCents / confirmedPriorTotal) : 0;

  // Cancel rate %, derived from totals.
  const cancelRate =
    bookingsTotal > 0 ? Math.round((cancelTotal / bookingsTotal) * 100) : 0;
  const cancelRatePrior =
    bookingsTotalPrior > 0
      ? Math.round((cancelPrior / bookingsTotalPrior) * 100)
      : 0;

  const dayLabel = to.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  // Build sparkline series from snapshots — used by the bookings KPI.
  // Map each snapshot to its `totalBookings`, capped to last 30 entries
  // so the SVG path stays simple.
  const bookingSpark =
    snapshotsForSpark.length >= 3
      ? snapshotsForSpark.slice(-30).map((s) => Number(s.totalBookings ?? 0))
      : null;
  const completedSpark =
    snapshotsForSpark.length >= 3
      ? snapshotsForSpark.slice(-30).map((s) => Number(s.completedBookings ?? 0))
      : null;
  const cancelSpark =
    snapshotsForSpark.length >= 3
      ? snapshotsForSpark.slice(-30).map((s) => Number(s.cancelledBookings ?? 0))
      : null;
  // Revenue per-day — only available when extras.revenue is populated
  // (tenants on Stripe). Skip silently otherwise.
  const revenueSpark =
    snapshotsForSpark.length >= 3
      ? snapshotsForSpark
          .slice(-30)
          .map((s) => {
            const extras = s.extras as
              | { revenue?: { grossRevenueCents?: number } }
              | null
              | undefined;
            return Number(extras?.revenue?.grossRevenueCents ?? 0);
          })
      : null;

  // Build hero intelligence chips from real data — no fabricated stats.
  const heroInsights: string[] = [];
  if (bookingsTotal > 0) {
    heroInsights.push(`${bookingsTotal} booking${bookingsTotal === 1 ? "" : "s"} this window.`);
  }
  if (revenueCents > 0) {
    const revD = delta(revenueCents, revenuePriorCents, true);
    if (revD.tone === "positive") {
      heroInsights.push(`Revenue pacing ${revD.label}.`);
    } else if (revD.tone === "warning") {
      heroInsights.push(`Revenue ${revD.label}.`);
    }
  }
  if (cancelTotal > 0 && cancelRate >= 10) {
    heroInsights.push(`Cancellation rate at ${cancelRate}% — worth a retrospective.`);
  }
  if (perStaff.length > 0) {
    const top = perStaff[0];
    if (Number(top.confirmed) > 0) {
      heroInsights.push(
        `${top.staffName} leads with ${Number(top.confirmed)} confirmed booking${Number(top.confirmed) === 1 ? "" : "s"}.`,
      );
    }
  }

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.currentPlan,
        logoUrl: tenant.logoUrl,
      }}
      title="Reports"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Reports" }]}
    >
      <div className="relative mt-2 space-y-5 pb-12">
        {/* Ambient background depth — matches executive cockpit */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-32 top-24 -z-10 h-[28rem] w-[28rem] rounded-full bg-brand-accent/[0.06] blur-[120px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 top-80 -z-10 h-[24rem] w-[24rem] rounded-full bg-emerald-300/[0.05] blur-[120px]"
        />

        {/* ── Hero ───────────────────────────────────────────────── */}
        <FadeIn>
          <ReportsHero
            days={days}
            from={from}
            to={to}
            dayLabel={dayLabel}
            tenantName={tenant.name}
            insights={heroInsights}
            hasAnalytics={hasAnalytics}
          />
        </FadeIn>

        {/* ── KPI snapshot cockpit ───────────────────────────────── */}
        <FadeIn delay={1}>
          <div>
            <SectionHead
              eyebrow="Snapshot"
              title="Operational KPIs"
              hint={`Last ${days} days vs the prior ${days}-day window.`}
            />
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                label="Bookings"
                value={String(bookingsTotal)}
                delta={delta(bookingsTotal, bookingsTotalPrior, true)}
                icon={CalendarRange}
                tone="brand"
                spark={bookingSpark}
              />
              <KpiCard
                label="Confirmed"
                value={String(confirmedTotal)}
                delta={delta(confirmedTotal, confirmedPriorTotal, true)}
                icon={CheckCircle2}
                tone="positive"
              />
              <KpiCard
                label="Completed"
                value={String(completedTotal)}
                delta={delta(completedTotal, completedPriorTotal, true)}
                icon={Star}
                tone="positive"
                spark={completedSpark}
              />
              <KpiCard
                label="Cancellations"
                value={String(cancelTotal)}
                delta={delta(cancelTotal, cancelPrior, false)}
                icon={TrendingDown}
                tone="warning"
                spark={cancelSpark}
              />
              <KpiCard
                label="No-shows"
                value={String(noShowTotal)}
                delta={delta(noShowTotal, noShowPriorTotal, false)}
                icon={Clock}
                tone="warning"
              />
              <KpiCard
                label="Revenue"
                value={dollars(revenueCents)}
                delta={delta(revenueCents, revenuePriorCents, true)}
                icon={DollarSign}
                tone="positive"
                spark={revenueSpark}
              />
              <KpiCard
                label="Avg booking value"
                value={dollars(avgBookingCents)}
                delta={delta(avgBookingCents, avgBookingCentsPrior, true)}
                icon={TrendingUp}
                tone="brand"
              />
              <KpiCard
                label="New customers"
                value={String(newCustomersTotal)}
                delta={delta(newCustomersTotal, newCustomersPriorTotal, true)}
                icon={Users}
                tone="brand"
              />
            </div>
          </div>
        </FadeIn>

        {/* ── Report categories ──────────────────────────────────── */}
        <FadeIn delay={2}>
          <div>
            <SectionHead
              eyebrow="Reporting library"
              title="Report categories"
              hint="Operational, financial, and executive surfaces — each routed to a real workspace."
            />
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <CategoryCard
                icon={CalendarRange}
                title="Appointment reports"
                body="Every booking, with service, staff, client, and price."
                actionHref="/api/bookings/export"
                actionLabel="Export CSV"
                actionDownload
                tone="brand"
              />
              <CategoryCard
                icon={DollarSign}
                title="Revenue reports"
                body="Confirmed revenue, refunds, and net trajectory."
                actionHref="/dashboard/analytics"
                actionLabel="Open analytics"
                tone="positive"
              />
              <CategoryCard
                icon={Users}
                title="Customer reports"
                body="Roster, tags, and lifetime engagement metrics."
                actionHref="/api/customers/export"
                actionLabel="Export CSV"
                actionDownload
                tone="brand"
              />
              <CategoryCard
                icon={Gauge}
                title="Staff performance"
                body="Utilization, completion, and load distribution."
                actionHref="#staff-utilization"
                actionLabel="View utilization"
                tone="brand"
              />
              <CategoryCard
                icon={Activity}
                title="Operational reports"
                body="Booking pipeline, automations, waitlists, and reminders."
                actionHref="/dashboard/analytics"
                actionLabel="Open analytics"
                tone="brand"
              />
              <CategoryCard
                icon={Crown}
                title="Executive reports"
                body="Daily brief, narrative, predictive insights, and recommendations."
                actionHref="/dashboard/analytics/executive"
                actionLabel="Open cockpit"
                tone="amber"
                locked={!hasAnalytics}
              />
              <CategoryCard
                icon={Wand2}
                title="Forecasting reports"
                body="Confidence-banded projections of booking and revenue trends."
                actionHref="/dashboard/analytics/executive"
                actionLabel="Open forecasts"
                tone="amber"
                locked={!hasAnalytics}
              />
              <CategoryCard
                icon={ShieldCheck}
                title="Audit & compliance"
                body="Export history, scheduled deliveries, and governance trail."
                actionHref="#audit-trail"
                actionLabel="View audit"
                tone="brand"
                locked={!hasAnalytics}
              />
            </div>
          </div>
        </FadeIn>

        {/* ── Export center ──────────────────────────────────────── */}
        <FadeIn delay={3}>
          <div>
            <SectionHead
              eyebrow="Export center"
              title="One-click exports"
              hint="CSV downloads honor the filters of the underlying workspace. PDF + XLSX rolling out behind the upgrade plan."
            />
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <ExportCard
                title="Appointments"
                desc="Every booking with service, staff, client, and price."
                href="/api/bookings/export"
                icon={CalendarRange}
                formats={["CSV"]}
                rowHint={`${bookingsTotal} record${bookingsTotal === 1 ? "" : "s"} in current window`}
              />
              <ExportCard
                title="Customers"
                desc="Customer roster with tags and booking aggregates."
                href="/api/customers/export"
                icon={Users}
                formats={["CSV"]}
                rowHint="Full tenant roster"
              />
              <ExportCard
                title="Revenue ledger"
                desc="Confirmed-revenue export filtered to paid bookings."
                href="/api/bookings/export?status=confirmed"
                icon={DollarSign}
                formats={["CSV"]}
                rowHint={`${confirmedTotal} confirmed booking${confirmedTotal === 1 ? "" : "s"}`}
              />
              {/* Super-admin tenants export. The endpoint itself
                  enforces super-admin authorization — we render the
                  card to admins so they can discover it, mirroring
                  the pre-Phase-13 behavior. */}
              {user.role === "admin" && (
                <ExportCard
                  title="Tenants"
                  desc="Super-admin export — visible only to the platform owner."
                  href="/api/admin/exports/tenants"
                  icon={Briefcase}
                  formats={["CSV"]}
                  rowHint="Platform-wide · super-admin only"
                  superAdmin
                />
              )}
              {/* Locked future formats — render the architecture but
                  clearly mark them as upgrade-gated so the user knows
                  the surface exists without ever clicking a broken
                  button. */}
              <ExportCard
                title="Executive PDF"
                desc="Board-quality PDF of the executive cockpit + recommendations."
                icon={FileText}
                formats={["PDF"]}
                rowHint="Coming with scheduled-report cadence"
                locked={!hasAnalytics}
                disabledReason={
                  hasAnalytics
                    ? "PDF delivery rolling out via scheduled reports."
                    : "Upgrade to unlock executive PDF delivery."
                }
              />
              <ExportCard
                title="XLSX workbook"
                desc="Multi-sheet workbook bundling appointments, customers, and revenue."
                icon={FileSpreadsheet}
                formats={["XLSX"]}
                rowHint="Bundled export coming soon"
                locked={!hasAnalytics}
                disabledReason={
                  hasAnalytics
                    ? "Multi-sheet workbook rolling out alongside scheduled delivery."
                    : "Upgrade to unlock multi-sheet exports."
                }
              />
            </div>
          </div>
        </FadeIn>

        {/* ── Scheduled reports ──────────────────────────────────── */}
        <FadeIn delay={4}>
          <ScheduledReportsSection
            hasAnalytics={hasAnalytics}
            currentPlanName={currentPlan.name}
            rows={scheduledRows}
          />
        </FadeIn>

        {/* ── Staff utilization ──────────────────────────────────── */}
        <FadeIn delay={5}>
          <div id="staff-utilization">
            <SectionHead
              eyebrow="Workforce"
              title={`Staff utilization · last ${days} days`}
              hint={`${Number(staffCountRow?.n ?? 0)} staff member${Number(staffCountRow?.n ?? 0) === 1 ? "" : "s"} on the roster.`}
            />
            <StaffUtilizationTable rows={perStaff} />
          </div>
        </FadeIn>

        {/* ── Executive summary card ─────────────────────────────── */}
        <FadeIn delay={6}>
          <ExecutiveSummaryCard
            hasAnalytics={hasAnalytics}
            currentPlanName={currentPlan.name}
            bookingsTotal={bookingsTotal}
            revenueCents={revenueCents}
            completedTotal={completedTotal}
            cancelRate={cancelRate}
            cancelRatePrior={cancelRatePrior}
          />
        </FadeIn>

        {/* ── Audit trail (only managerial admins) ───────────────── */}
        {isManagerial(user.role) && (
          <FadeIn delay={7}>
            <AuditTrailSection
              id="audit-trail"
              hasAnalytics={hasAnalytics}
              currentPlanName={currentPlan.name}
              rows={auditRows}
            />
          </FadeIn>
        )}
      </div>
    </Shell>
  );
}

// ───────────────────────────────────────────────────────────────────
// Hero
// ───────────────────────────────────────────────────────────────────

function ReportsHero({
  days,
  from,
  to,
  dayLabel,
  tenantName,
  insights,
  hasAnalytics,
}: {
  days: number;
  from: Date;
  to: Date;
  dayLabel: string;
  tenantName: string;
  insights: string[];
  hasAnalytics: boolean;
}) {
  const ranges: Array<[number, string]> = [
    [7, "7d"],
    [30, "30d"],
    [90, "90d"],
    [365, "1y"],
  ];
  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/55 via-surface to-surface"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-28 -top-28 h-72 w-72 rounded-full bg-brand-accent/[0.14] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-20 -bottom-20 h-56 w-56 rounded-full bg-emerald-200/[0.18] blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            <BarChart3 className="h-3 w-3" strokeWidth={2} />
            Reporting center
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Reports
          </h1>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            <span className="font-medium text-ink">{tenantName}</span> &middot; {dayLabel} &middot;{" "}
            operational reporting, exports, forecasting, and executive summaries.
          </p>
          <p className="mt-1 text-[11px] text-ink-subtle">
            Window: {from.toISOString().slice(0, 10)} → {to.toISOString().slice(0, 10)}
          </p>

          {insights.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {insights.slice(0, 4).map((line, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-border/60 backdrop-blur-sm"
                >
                  <Lightbulb className="h-3 w-3 text-brand-accent" strokeWidth={2} />
                  {line}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex rounded-full border border-border bg-surface/70 p-0.5 backdrop-blur-sm">
            {ranges.map(([d, label]) => (
              <Link
                key={d}
                href={`/dashboard/reports?range=${d}`}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all",
                  d === days
                    ? "bg-brand-accent text-white shadow-[0_2px_8px_rgba(37,99,235,0.32)]"
                    : "text-ink-muted hover:text-ink",
                )}
              >
                {label}
              </Link>
            ))}
          </div>
          <a
            href="/api/bookings/export"
            download
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
            Export all
          </a>
          {!hasAnalytics && (
            <Link
              href="/dashboard/billing"
              className="zm-pulse-glow inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-r from-brand-accent to-brand-hover px-3 text-[12px] font-semibold text-white shadow-[0_6px_16px_rgba(37,99,235,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(37,99,235,0.45)]"
            >
              <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
              Schedule reports
            </Link>
          )}
        </div>
      </div>
    </PremiumCard>
  );
}

// ───────────────────────────────────────────────────────────────────
// KPI card with optional sparkline
// ───────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  delta,
  icon: Icon,
  tone,
  spark,
}: {
  label: string;
  value: string;
  delta: Delta;
  icon: LucideIcon;
  tone: "brand" | "positive" | "warning";
  spark?: number[] | null;
}) {
  const iconTone =
    tone === "positive"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
      : tone === "warning"
        ? "bg-amber-50 text-amber-700 ring-amber-200/40"
        : "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15";
  const deltaTone =
    delta.tone === "positive"
      ? "bg-emerald-50 text-emerald-700"
      : delta.tone === "warning"
        ? "bg-amber-50 text-amber-700"
        : "bg-surface-inset text-ink-subtle";
  const trendDir = delta.pct > 0 ? "up" : delta.pct < 0 ? "down" : "flat";
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            {label}
          </div>
          <div className="mt-1 text-[22px] font-semibold tracking-tight text-ink tabular-nums">
            {value}
          </div>
          <div
            className={cn(
              "mt-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
              deltaTone,
            )}
          >
            {trendDir === "up" && <TrendingUp className="h-2.5 w-2.5" strokeWidth={2.25} />}
            {trendDir === "down" && <TrendingDown className="h-2.5 w-2.5" strokeWidth={2.25} />}
            {trendDir === "flat" && <Activity className="h-2.5 w-2.5" strokeWidth={2.25} />}
            {delta.label}
          </div>
        </div>
        <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1", iconTone)}>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
      </div>
      {spark && spark.length >= 3 && (
        <div className="mt-2.5" aria-hidden>
          <Sparkline values={spark} tone={tone} />
        </div>
      )}
    </div>
  );
}

// Pure SVG sparkline — no client JS, no recharts dependency.
function Sparkline({
  values,
  tone,
}: {
  values: number[];
  tone: "brand" | "positive" | "warning";
}) {
  const max = Math.max(1, ...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  const W = 100;
  const H = 24;
  const points = values.map((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * W;
    const y = H - ((v - min) / range) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const stroke =
    tone === "positive" ? "#059669" : tone === "warning" ? "#d97706" : "#2563EB";
  const fill =
    tone === "positive" ? "url(#sparkFillG)" : tone === "warning" ? "url(#sparkFillA)" : "url(#sparkFillB)";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-6 w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="sparkFillB" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2563EB" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#2563EB" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sparkFillG" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#059669" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#059669" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sparkFillA" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d97706" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#d97706" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={points.join(" ")} stroke={stroke} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <polygon points={`0,${H} ${points.join(" ")} ${W},${H}`} fill={fill} />
    </svg>
  );
}

// ───────────────────────────────────────────────────────────────────
// Category card
// ───────────────────────────────────────────────────────────────────

function CategoryCard({
  icon: Icon,
  title,
  body,
  actionHref,
  actionLabel,
  actionDownload,
  tone,
  locked,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  actionHref: string;
  actionLabel: string;
  actionDownload?: boolean;
  tone: "brand" | "positive" | "amber";
  locked?: boolean;
}) {
  const iconTone =
    tone === "positive"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
      : tone === "amber"
        ? "bg-amber-50 text-amber-700 ring-amber-200/40"
        : "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15";

  const inner = (
    <>
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
      <div className="flex items-start gap-2.5">
        <span className={cn("inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1", iconTone)}>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h3>
            {locked && (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle ring-1 ring-border/40">
                <Lock className="h-2.5 w-2.5" strokeWidth={2} />
                Pro
              </span>
            )}
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{body}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-[11px] font-medium">
        <span className="text-ink-subtle">{actionLabel}</span>
        <ArrowUpRight
          className={cn(
            "h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5",
            locked ? "text-ink-subtle" : "text-brand-accent",
          )}
          strokeWidth={2}
        />
      </div>
    </>
  );

  const baseClass =
    "group relative block overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft";

  if (locked) {
    return (
      <Link
        href="/dashboard/billing"
        className={cn(baseClass, "opacity-95")}
        aria-label={`${title} — Pro feature, upgrade to unlock`}
      >
        {inner}
      </Link>
    );
  }

  if (actionDownload) {
    return (
      <a href={actionHref} download className={baseClass}>
        {inner}
      </a>
    );
  }

  return (
    <Link href={actionHref} className={baseClass}>
      {inner}
    </Link>
  );
}

// ───────────────────────────────────────────────────────────────────
// Export card
// ───────────────────────────────────────────────────────────────────

function ExportCard({
  title,
  desc,
  href,
  icon: Icon,
  formats,
  rowHint,
  superAdmin,
  locked,
  disabledReason,
}: {
  title: string;
  desc: string;
  href?: string;
  icon: LucideIcon;
  formats: string[];
  rowHint: string;
  superAdmin?: boolean;
  locked?: boolean;
  disabledReason?: string;
}) {
  const interactive = !locked && !!href;
  const wrapperClass = cn(
    "group relative block overflow-hidden rounded-2xl border bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
    interactive
      ? "border-border/60 hover:-translate-y-0.5 hover:shadow-soft hover:border-brand-accent/40"
      : "border-border/60",
  );

  const inner = (
    <>
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
              <Icon className="h-4 w-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <h3 className="text-[13px] font-semibold tracking-tight text-ink">
                {title}
              </h3>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">{desc}</p>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {formats.map((f) => (
            <span
              key={f}
              className={cn(
                "inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ring-1",
                locked
                  ? "bg-surface-inset text-ink-subtle ring-border/40"
                  : "bg-brand-subtle/50 text-brand-accent ring-brand-accent/20",
              )}
            >
              {f}
            </span>
          ))}
          {superAdmin && (
            <span className="inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-amber-700 ring-1 ring-amber-200/40">
              Super-admin
            </span>
          )}
          {locked && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle ring-1 ring-border/40">
              <Lock className="h-2.5 w-2.5" strokeWidth={2} />
              Locked
            </span>
          )}
        </div>
        {interactive ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-accent">
            <Download className="h-3 w-3" strokeWidth={2} />
            Download
          </span>
        ) : (
          <span className="text-[10px] text-ink-subtle">Coming soon</span>
        )}
      </div>
      <p className="mt-2 text-[10.5px] text-ink-subtle">
        {locked ? disabledReason ?? "Available on Pro plans." : rowHint}
      </p>
    </>
  );

  if (locked) {
    return (
      <Link href="/dashboard/billing" className={wrapperClass}>
        {inner}
      </Link>
    );
  }

  if (interactive && href) {
    return (
      <a href={href} download className={wrapperClass}>
        {inner}
      </a>
    );
  }

  return <div className={wrapperClass}>{inner}</div>;
}

// ───────────────────────────────────────────────────────────────────
// Scheduled reports
// ───────────────────────────────────────────────────────────────────

function ScheduledReportsSection({
  hasAnalytics,
  currentPlanName,
  rows,
}: {
  hasAnalytics: boolean;
  currentPlanName: string;
  rows: Array<{
    id: string;
    periodType: string;
    periodStart: string;
    periodEnd: string;
    generatedAt: Date;
    generationMs: number | null;
  }>;
}) {
  return (
    <div>
      <SectionHead
        eyebrow="Automation"
        title="Scheduled reports"
        hint="Daily, weekly, and monthly summaries generated by the analytics cron."
      />
      <PremiumCard className="relative overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
        {!hasAnalytics ? (
          <LockedSection
            title="Scheduled delivery is a Pro feature"
            body={`Upgrade from ${currentPlanName} to receive automated executive summaries by email and persist board-ready reports.`}
            icon={Clock}
            ctaLabel="Unlock scheduled reports"
          />
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
              <Clock className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <h3 className="text-[13.5px] font-semibold tracking-tight text-ink">
              No reports generated yet
            </h3>
            <p className="max-w-xl text-[11.5px] leading-relaxed text-ink-muted">
              The analytics cron generates weekly and monthly executive summaries automatically.
              The next scheduled run will populate this list — no setup required.
            </p>
          </div>
        ) : (
          <div className="-mx-2 overflow-x-auto sm:mx-0">
            <table className="w-full text-[12px]">
              <thead className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
                <tr className="border-b border-border/60">
                  <th className="px-2 py-2 text-left">Period</th>
                  <th className="px-2 py-2 text-left">Range</th>
                  <th className="px-2 py-2 text-left">Generated</th>
                  <th className="px-2 py-2 text-right">Build time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/40 last:border-0">
                    <td className="px-2 py-2 font-medium capitalize text-ink">{r.periodType}</td>
                    <td className="px-2 py-2 text-ink-muted">
                      {r.periodStart} → {r.periodEnd}
                    </td>
                    <td className="px-2 py-2 text-ink-muted">
                      {new Date(r.generatedAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-ink-subtle">
                      {r.generationMs !== null ? `${r.generationMs} ms` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PremiumCard>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Staff utilization
// ───────────────────────────────────────────────────────────────────

function StaffUtilizationTable({
  rows,
}: {
  rows: Array<{
    staffId: string | null;
    staffName: string | null;
    confirmed: number;
    cancelled: number;
    noShow: number;
    completed: number;
    bookedMinutes: number;
  }>;
}) {
  if (rows.length === 0) {
    return (
      <PremiumCard className="relative overflow-hidden p-6 text-center">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
        <Users className="mx-auto h-7 w-7 text-ink-subtle" strokeWidth={1.5} />
        <h3 className="mt-2 text-[13.5px] font-semibold tracking-tight text-ink">
          No bookings recorded in this window
        </h3>
        <p className="mx-auto mt-1 max-w-sm text-[11.5px] leading-relaxed text-ink-muted">
          Once bookings land with staff assignments, this table populates with utilization
          and load distribution. Try a wider date range above.
        </p>
      </PremiumCard>
    );
  }

  const maxHours = Math.max(
    1,
    ...rows.map((r) => Number(r.bookedMinutes ?? 0) / 60),
  );
  const topStaffId = rows[0]?.staffId;

  return (
    <PremiumCard className="relative overflow-hidden p-0">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-surface-inset/60 text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            <tr>
              <th className="px-4 py-2.5 text-left">Staff</th>
              <th className="px-4 py-2.5 text-right">Confirmed</th>
              <th className="px-4 py-2.5 text-right">Completed</th>
              <th className="px-4 py-2.5 text-right">Cancel %</th>
              <th className="px-4 py-2.5 text-right">No-show %</th>
              <th className="px-4 py-2.5 text-right">Hours booked</th>
              <th className="px-4 py-2.5 text-left">Load</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const total =
                Number(r.confirmed ?? 0) +
                Number(r.cancelled ?? 0) +
                Number(r.noShow ?? 0) +
                Number(r.completed ?? 0);
              const cancelPct =
                total > 0 ? Math.round((Number(r.cancelled) / total) * 100) : 0;
              const noShowPct =
                total > 0 ? Math.round((Number(r.noShow) / total) * 100) : 0;
              const hours = Number(r.bookedMinutes ?? 0) / 60;
              const loadPct = (hours / maxHours) * 100;
              const isTop = r.staffId === topStaffId && Number(r.confirmed) > 0;
              return (
                <tr
                  key={r.staffId ?? r.staffName ?? Math.random()}
                  className="border-t border-border/40 transition-colors hover:bg-surface-inset/40"
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">{r.staffName ?? "—"}</span>
                      {isTop && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-amber-700 ring-1 ring-amber-200/40">
                          <Star className="h-2.5 w-2.5" strokeWidth={2.25} />
                          Top
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-medium text-ink">
                    {Number(r.confirmed)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink">
                    {Number(r.completed)}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-2.5 text-right tabular-nums",
                      cancelPct >= 20 ? "text-amber-700 font-medium" : "text-ink-muted",
                    )}
                  >
                    {cancelPct}%
                  </td>
                  <td
                    className={cn(
                      "px-4 py-2.5 text-right tabular-nums",
                      noShowPct >= 15 ? "text-amber-700 font-medium" : "text-ink-muted",
                    )}
                  >
                    {noShowPct}%
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink">
                    {hours.toFixed(1)}
                  </td>
                  <td className="w-[28%] px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-inset">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-brand-accent to-brand-hover"
                          style={{ width: `${Math.min(100, Math.max(2, loadPct))}%` }}
                          aria-hidden
                        />
                      </div>
                      <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-ink-subtle">
                        {Math.round(loadPct)}%
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </PremiumCard>
  );
}

// ───────────────────────────────────────────────────────────────────
// Executive summary card (links to cockpit or shows locked state)
// ───────────────────────────────────────────────────────────────────

function ExecutiveSummaryCard({
  hasAnalytics,
  currentPlanName,
  bookingsTotal,
  revenueCents,
  completedTotal,
  cancelRate,
  cancelRatePrior,
}: {
  hasAnalytics: boolean;
  currentPlanName: string;
  bookingsTotal: number;
  revenueCents: number;
  completedTotal: number;
  cancelRate: number;
  cancelRatePrior: number;
}) {
  // Build a single-paragraph operational summary entirely from the
  // numbers we just fetched. No fabricated narrative — every clause
  // cites a real metric.
  const sentences: string[] = [];
  if (bookingsTotal > 0) {
    sentences.push(
      `${bookingsTotal} booking${bookingsTotal === 1 ? "" : "s"} were created in the window.`,
    );
  }
  if (completedTotal > 0) {
    sentences.push(
      `${completedTotal} completed and rolled into revenue at ${dollars(revenueCents)}.`,
    );
  }
  if (cancelRate > 0) {
    const dir =
      cancelRate > cancelRatePrior
        ? `up from ${cancelRatePrior}%`
        : cancelRate < cancelRatePrior
          ? `down from ${cancelRatePrior}%`
          : `level with the prior window`;
    sentences.push(`Cancellation rate sits at ${cancelRate}%, ${dir}.`);
  }
  if (sentences.length === 0) {
    sentences.push("No booking activity recorded yet — the summary will populate once bookings land.");
  }

  return (
    <div>
      <SectionHead
        eyebrow="Executive summary"
        title="This window at a glance"
        hint="A board-quality paragraph derived from the metrics above."
      />
      <PremiumCard className="relative overflow-hidden bg-gradient-to-br from-amber-50/30 via-surface to-surface p-5">
        <span aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-amber-200/[0.18] blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
        <div className="relative flex items-start gap-3">
          <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-50 to-surface text-amber-700 ring-1 ring-amber-200/40">
            <Crown className="h-4 w-4" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-amber-700">
              Operational read
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-ink">
              {sentences.join(" ")}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {hasAnalytics ? (
                <Link
                  href="/dashboard/analytics/executive"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand-accent px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-[0_4px_14px_rgba(37,99,235,0.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(37,99,235,0.40)]"
                >
                  <Target className="h-3.5 w-3.5" strokeWidth={2} />
                  Open executive cockpit
                  <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
                </Link>
              ) : (
                <Link
                  href="/dashboard/billing"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand-accent px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-[0_4px_14px_rgba(37,99,235,0.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(37,99,235,0.40)]"
                >
                  <Zap className="h-3.5 w-3.5" strokeWidth={2} />
                  Unlock executive analytics
                  <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
                </Link>
              )}
              {!hasAnalytics && (
                <span className="text-[10.5px] text-ink-subtle">
                  Currently on {currentPlanName}.
                </span>
              )}
            </div>
          </div>
        </div>
      </PremiumCard>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Audit trail
// ───────────────────────────────────────────────────────────────────

function AuditTrailSection({
  id,
  hasAnalytics,
  currentPlanName,
  rows,
}: {
  id: string;
  hasAnalytics: boolean;
  currentPlanName: string;
  rows: Array<{
    id: string;
    exportType: string;
    exportedAt: Date;
    recordCount: number | null;
    userId: string | null;
  }>;
}) {
  return (
    <div id={id}>
      <SectionHead
        eyebrow="Audit & compliance"
        title="Export history"
        hint="Every CSV pulled from this workspace is logged for compliance review."
      />
      <PremiumCard className="relative overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
        {!hasAnalytics ? (
          <LockedSection
            title="Export auditing is a Pro feature"
            body={`Upgrade from ${currentPlanName} to unlock the export audit trail, governance dashboard, and retention controls.`}
            icon={History}
            ctaLabel="Unlock audit & compliance"
          />
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
              <ShieldCheck className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <h3 className="text-[13.5px] font-semibold tracking-tight text-ink">
              No exports recorded yet
            </h3>
            <p className="max-w-xl text-[11.5px] leading-relaxed text-ink-muted">
              Every CSV downloaded from the export center is recorded here automatically.
              Pull an export above to start populating the audit trail.
            </p>
          </div>
        ) : (
          <div className="-mx-2 overflow-x-auto sm:mx-0">
            <table className="w-full text-[12px]">
              <thead className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
                <tr className="border-b border-border/60">
                  <th className="px-2 py-2 text-left">Export</th>
                  <th className="px-2 py-2 text-left">When</th>
                  <th className="px-2 py-2 text-right">Records</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/40 last:border-0">
                    <td className="px-2 py-2 font-medium capitalize text-ink">
                      {r.exportType.replace(/_/g, " ")}
                    </td>
                    <td className="px-2 py-2 text-ink-muted">
                      {new Date(r.exportedAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-ink">
                      {r.recordCount !== null ? r.recordCount.toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PremiumCard>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Shared bits
// ───────────────────────────────────────────────────────────────────

function SectionHead({
  eyebrow,
  title,
  hint,
}: {
  eyebrow: string;
  title: string;
  hint?: string;
}) {
  return (
    <header className="mb-1">
      <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
        {eyebrow}
      </div>
      <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
      {hint && <p className="mt-0.5 text-[12px] text-ink-muted">{hint}</p>}
    </header>
  );
}

function LockedSection({
  title,
  body,
  icon: Icon,
  ctaLabel,
}: {
  title: string;
  body: string;
  icon: LucideIcon;
  ctaLabel: string;
}) {
  return (
    <div className="relative flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-50 to-surface text-amber-700 ring-1 ring-amber-200/40">
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.10em] text-amber-700 ring-1 ring-amber-200/40">
            <Lock className="h-2.5 w-2.5" strokeWidth={2} />
            Pro feature
          </div>
          <h3 className="mt-1 text-[13.5px] font-semibold tracking-tight text-ink">{title}</h3>
          <p className="mt-0.5 max-w-xl text-[11.5px] leading-relaxed text-ink-muted">{body}</p>
        </div>
      </div>
      <Link
        href="/dashboard/billing"
        className="zm-pulse-glow inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-accent px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-[0_4px_14px_rgba(37,99,235,0.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(37,99,235,0.40)]"
      >
        <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
        {ctaLabel}
        <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
      </Link>
    </div>
  );
}

// Unused-icon guard — keep imports stable for future surfaces
// (advanced filtering UI lands in a later phase) without
// triggering lint warnings:
void Filter;
