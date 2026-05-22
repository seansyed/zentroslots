import { redirect } from "next/navigation";
import { and, count, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { announcements, availability, bookings, services, tasks, tenants, users } from "@/db/schema";
import { getSession, isManagerial } from "@/lib/auth";
import { getGoogleHealth } from "@/lib/calendar/connections";
import DashboardBookings from "@/components/DashboardBookings";
import Shell from "@/components/dashboard/Shell";
import OnboardingChecklist, { type ChecklistItem } from "@/components/dashboard/OnboardingChecklist";
import { getDashboardChecklistSummary } from "@/lib/onboarding/integrity";
import TenantAnnouncementBanner from "@/components/dashboard/TenantAnnouncementBanner";
import DashboardHero from "@/components/dashboard/DashboardHero";
import DashboardKpiGrid from "@/components/dashboard/DashboardKpiGrid";
import DashboardSidePanel from "@/components/dashboard/DashboardSidePanel";
import MiniSchedule from "@/components/dashboard/MiniSchedule";
import { FadeIn } from "@/components/ui/Motion";

export default async function DashboardPage(props: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");

  const sp = await props.searchParams;
  const tab = (["today", "upcoming", "cancelled", "completed"].includes(sp.tab ?? "")
    ? sp.tab
    : "upcoming") as "today" | "upcoming" | "cancelled" | "completed";

  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  // First-time admin? Push to the onboarding wizard — UNLESS they
  // explicitly chose "Finish later" (the escape hatch). That choice
  // sets `onboardingSkippedAt` so the wizard becomes opt-in instead
  // of forced. The wizard itself remains resumable from
  // /dashboard/onboarding any time. Completion still requires the
  // terminal `complete` action, which sets `onboardingCompletedAt`.
  if (
    user.role === "admin" &&
    tenant &&
    !tenant.onboardingCompletedAt &&
    !tenant.onboardingSkippedAt
  ) {
    redirect("/dashboard/onboarding");
  }

  // KPI windows
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()); // Sun-based
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 7);
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const tenantOnly = eq(bookings.tenantId, user.tenantId);
  const visibility = isManagerial(user.role) ? tenantOnly : and(tenantOnly, eq(bookings.staffUserId, user.id));

  const [
    [todayCount],
    [weekCount],
    [cancelledCount],
    [staffCountRow],
    [bookingCountRow],
    [bookedSecondsRow],
    [noShowCount],
    [confirmed30dCount],
    [weekRevenueRow],
    [pendingTasksRow],
    pendingTasks,
    topServices,
    activeAnnouncements,
  ] = await Promise.all([
    db.select({ n: count() }).from(bookings).where(and(visibility, eq(bookings.status, "confirmed"), gte(bookings.startAt, startOfToday), lt(bookings.startAt, startOfTomorrow))),
    db.select({ n: count() }).from(bookings).where(and(visibility, eq(bookings.status, "confirmed"), gte(bookings.startAt, startOfWeek), lt(bookings.startAt, endOfWeek))),
    db.select({ n: count() }).from(bookings).where(and(visibility, eq(bookings.status, "cancelled"), gte(bookings.startAt, thirtyDaysAgo))),
    db.select({ n: count() }).from(users).where(and(eq(users.tenantId, user.tenantId), eq(users.role, "staff"))),
    db.select({ n: count() }).from(bookings).where(tenantOnly),
    db
      .select({
        secs: sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (${bookings.endAt} - ${bookings.startAt})))::int, 0)`,
      })
      .from(bookings)
      .where(and(visibility, eq(bookings.status, "confirmed"), gte(bookings.startAt, startOfWeek), lt(bookings.startAt, endOfWeek))),
    db.select({ n: count() }).from(bookings).where(and(visibility, eq(bookings.status, "no_show"), gte(bookings.startAt, thirtyDaysAgo))),
    // Denominator for no-show rate: actually-occurred meetings (completed
    // + no_show). Excludes cancellations since they were never expected
    // to happen.
    db.select({ n: count() }).from(bookings).where(and(visibility, inArray(bookings.status, ["completed", "no_show"]), gte(bookings.startAt, thirtyDaysAgo))),
    // Revenue estimate this week: sum of service.price for confirmed
    // bookings whose start is in this week. Price is stored as cents.
    db
      .select({ sum: sql<number>`COALESCE(SUM(${services.price}), 0)::int` })
      .from(bookings)
      .innerJoin(services, eq(services.id, bookings.serviceId))
      .where(and(visibility, eq(bookings.status, "confirmed"), gte(bookings.startAt, startOfWeek), lt(bookings.startAt, endOfWeek))),
    db.select({ n: count() }).from(tasks).where(and(eq(tasks.tenantId, user.tenantId), eq(tasks.status, "open"))),
    // Show up to 5 most-relevant pending tasks: ones assigned to me, plus
    // overdue ones. Admins see everything; staff see only their own.
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        dueAt: tasks.dueAt,
        assignedUserId: tasks.assignedUserId,
      })
      .from(tasks)
      .where(and(
        eq(tasks.tenantId, user.tenantId),
        eq(tasks.status, "open"),
        ...(isManagerial(user.role) ? [] : [or(eq(tasks.assignedUserId, user.id), eq(tasks.createdByUserId, user.id))!]),
      ))
      .orderBy(sql`${tasks.dueAt} ASC NULLS LAST`)
      .limit(5),
    // Top 5 services in last 30d by confirmed booking count.
    db
      .select({
        id: services.id,
        name: services.name,
        n: sql<number>`COUNT(*)::int`,
        revenue: sql<number>`SUM(${services.price})::int`,
      })
      .from(bookings)
      .innerJoin(services, eq(services.id, bookings.serviceId))
      .where(and(eq(bookings.tenantId, user.tenantId), eq(bookings.status, "confirmed"), gte(bookings.startAt, thirtyDaysAgo)))
      .groupBy(services.id, services.name)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(5),
    // Active announcements targeting this tenant's plan or 'all'.
    // Newest first; the banner component shows just the top one.
    db
      .select({
        id: announcements.id,
        title: announcements.title,
        body: announcements.body,
        severity: announcements.severity,
        linkUrl: announcements.linkUrl,
        linkLabel: announcements.linkLabel,
      })
      .from(announcements)
      .where(and(
        eq(announcements.active, true),
        or(eq(announcements.audience, "all"), eq(announcements.audience, tenant?.currentPlan ?? "free"))!,
        or(sql`${announcements.expiresAt} IS NULL`, sql`${announcements.expiresAt} > NOW()`)!,
      ))
      .orderBy(desc(announcements.publishedAt))
      .limit(1),
  ]);

  const noShow30d = Number(noShowCount?.n ?? 0);
  const confirmed30d = Number(confirmed30dCount?.n ?? 0);
  const noShowRatePct = confirmed30d > 0 ? Math.round((noShow30d / confirmed30d) * 100) : null;
  const weekRevenueCents = Number(weekRevenueRow?.sum ?? 0);
  const pendingTasksCount = Number(pendingTasksRow?.n ?? 0);
  const topAnnouncement = activeAnnouncements[0] ?? null;

  // Utilization = booked hours / available hours this week (weekly rule only).
  let availableSeconds = 0;
  const rules = await db
    .select({
      startTime: availability.startTime,
      endTime: availability.endTime,
    })
    .from(availability)
    .where(isManagerial(user.role) ? eq(availability.tenantId, user.tenantId) : and(eq(availability.tenantId, user.tenantId), eq(availability.userId, user.id)));
  for (const r of rules) {
    const [sh, sm] = r.startTime.split(":").map(Number);
    const [eh, em] = r.endTime.split(":").map(Number);
    availableSeconds += Math.max(0, ((eh * 60 + em) - (sh * 60 + sm))) * 60;
  }
  const booked = Number(bookedSecondsRow?.secs ?? 0);
  const utilizationPct =
    availableSeconds > 0 ? Math.min(100, Math.round((booked / availableSeconds) * 100)) : 0;

  // Tab data — server-rendered, the client component below adds inline actions.
  let dateFilter;
  let statusFilter;
  switch (tab) {
    case "today":
      dateFilter = and(gte(bookings.startAt, startOfToday), lt(bookings.startAt, startOfTomorrow));
      statusFilter = eq(bookings.status, "confirmed");
      break;
    case "cancelled":
      statusFilter = eq(bookings.status, "cancelled");
      break;
    case "completed":
      statusFilter = eq(bookings.status, "completed");
      break;
    case "upcoming":
    default:
      dateFilter = gte(bookings.startAt, now);
      statusFilter = eq(bookings.status, "confirmed");
  }

  const rows = await db
    .select({
      id: bookings.id,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      status: bookings.status,
      clientName: bookings.clientName,
      clientEmail: bookings.clientEmail,
      meetLink: bookings.meetLink,
      serviceName: services.name,
      staffUserId: bookings.staffUserId,
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .where(and(visibility, ...(statusFilter ? [statusFilter] : []), ...(dateFilter ? [dateFilter] : [])))
    .orderBy(desc(bookings.startAt))
    .limit(100);

  const staffCount = Number(staffCountRow?.n ?? 0);
  const bookingCount = Number(bookingCountRow?.n ?? 0);

  // Today's confirmed bookings for the MiniSchedule preview in the hero.
  // Small, specific query — independent of the active tab filter so the
  // user always sees today regardless of which tab they last clicked.
  const todayRows = await db
    .select({
      id: bookings.id,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      clientName: bookings.clientName,
      serviceName: services.name,
      meetLink: bookings.meetLink,
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .where(
      and(
        visibility,
        eq(bookings.status, "confirmed"),
        gte(bookings.startAt, startOfToday),
        lt(bookings.startAt, startOfTomorrow)
      )
    )
    .orderBy(bookings.startAt)
    .limit(6);

  // Onboarding checklist (only shown when something is incomplete).
  // Consolidated to ONE round-trip via lib/onboarding/integrity.ts —
  // EXISTS short-circuits on first row, unlike the two COUNT(*) scans
  // we used before. Wave A: Google connectivity is now resolved via
  // `getGoogleHealth` against the encrypted connections table (see
  // below). `logoUrl` and `tagline` are already loaded into
  // `user` / `tenant`, so no extra query is needed for those.
  const checklistSummary = await getDashboardChecklistSummary(user.tenantId, user.id);
  // Wave A — `users.google_refresh_token` is being phased out (migration
  // 0044). The encrypted `calendar_connections` table is now canonical.
  // `getGoogleHealth` returns `{ connected, status, needsReconnect }`
  // — one query, used by both the checklist tile and the reconnect
  // banner below so we don't double-fetch.
  const googleHealth = await getGoogleHealth(user.id);
  const checklistItems: ChecklistItem[] = [
    { id: "google",   label: "Connect Google Calendar",          href: "/dashboard/settings/integrations", done: googleHealth.connected },
    { id: "service",  label: "Add at least one service",         href: "/dashboard/services",              done: checklistSummary.hasServices },
    { id: "hours",    label: "Set your weekly working hours",    href: "/dashboard/availability",          done: checklistSummary.hasAvailability },
    { id: "booking",  label: "Receive your first booking",       href: "/dashboard/calendar",              done: bookingCount > 0 },
    { id: "branding", label: "Customize your booking page",      href: "/dashboard/settings/branding",     done: Boolean(tenant?.logoUrl || tenant?.tagline) },
  ];

  // Google reconnect banner — appears when the orchestrator flipped
  // the encrypted connection into `needs_reconnect`. Sourced from the
  // single `getGoogleHealth()` call above (avoids reading from the
  // legacy `users.googleStatus` column that we no longer write).
  const showGoogleReconnect = googleHealth.needsReconnect;

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.plan, logoUrl: tenant.logoUrl } : undefined}
      title="Dashboard"
      subtitle={user.timezone}
    >
      <TenantAnnouncementBanner announcement={topAnnouncement} />

      {showGoogleReconnect && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden>
            <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="flex-1">
            <div className="font-medium">Google Calendar needs to be reconnected.</div>
            <div className="mt-0.5 text-xs">
              The last calendar sync failed. New bookings will be created without Meet links until you reconnect.
            </div>
          </div>
          <a href="/api/google/connect" className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800">
            Reconnect Google
          </a>
        </div>
      )}

      <OnboardingChecklist items={checklistItems} />

      {/* ── HERO ────────────────────────────────────────────────── */}
      <FadeIn delay={0} as="section">
        <DashboardHero
          userName={user.name}
          userRole={user.role}
          tenantName={tenant?.name ?? "Workspace"}
          timezone={user.timezone}
          todayCount={Number(todayCount?.n ?? 0)}
          weekCount={Number(weekCount?.n ?? 0)}
          utilizationPct={utilizationPct}
          showGoogleConnect={!googleHealth.connected && (user.role === "admin" || user.role === "staff")}
          miniSchedule={
            <MiniSchedule rows={todayRows} timezone={user.timezone} />
          }
        />
      </FadeIn>

      {/* ── KPI GRID ────────────────────────────────────────────── */}
      <FadeIn delay={1} className="mt-8">
        <DashboardKpiGrid
          todayCount={Number(todayCount?.n ?? 0)}
          weekCount={Number(weekCount?.n ?? 0)}
          weekRevenueCents={weekRevenueCents}
          utilizationPct={utilizationPct}
          noShowRatePct={noShowRatePct}
          staffCount={staffCount}
          cancellationsCount={Number(cancelledCount?.n ?? 0)}
          openTasksCount={pendingTasksCount}
        />
      </FadeIn>

      {/* ── MAIN GRID: timeline + side panel ───────────────────── */}
      <FadeIn delay={2} className="mt-8">
        <div className="grid gap-6 lg:grid-cols-3">
          <section className="lg:col-span-2">
            <div className="rounded-2xl border border-border bg-surface p-5 shadow-soft sm:p-6">
              <div className="mb-4 flex items-baseline justify-between gap-3">
                <div>
                  <h3 className="text-[15px] font-semibold tracking-tight text-ink">
                    Upcoming appointments
                  </h3>
                  <p className="mt-0.5 text-[12px] text-ink-muted">
                    Today and the next 7 days
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  <TabLink active={tab === "today"} label="Today" href="?tab=today" />
                  <TabLink active={tab === "upcoming"} label="Upcoming" href="?tab=upcoming" />
                  <TabLink active={tab === "cancelled"} label="Cancelled" href="?tab=cancelled" />
                  <TabLink active={tab === "completed"} label="Completed" href="?tab=completed" />
                </div>
              </div>
              <DashboardBookings
                rows={rows.map((r) => ({ ...r, startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString() }))}
                canManage={user.role === "admin" || user.role === "staff" || user.role === "manager"}
                userTimezone={user.timezone}
              />
            </div>
          </section>

          <DashboardSidePanel
            pendingTasks={pendingTasks.map((t) => ({
              id: t.id,
              title: t.title,
              dueAt: t.dueAt ? t.dueAt.toISOString() : null,
            }))}
            topServices={topServices.map((s) => ({
              id: s.id,
              name: s.name,
              bookings: Number(s.n),
              revenueCents: Number(s.revenue),
            }))}
            totalBookings={bookingCount}
            plan={tenant?.plan ?? "free"}
          />
        </div>
      </FadeIn>
    </Shell>
  );
}

function TabLink({ active, label, href }: { active: boolean; label: string; href: string }) {
  return (
    <a
      href={href}
      className={
        "rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors " +
        (active
          ? "bg-brand-subtle text-brand-accent"
          : "text-ink-muted hover:bg-surface-inset hover:text-ink")
      }
    >
      {label}
    </a>
  );
}
