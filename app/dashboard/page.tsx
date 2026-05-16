import { redirect } from "next/navigation";
import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { availability, bookings, services, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import DashboardBookings from "@/components/DashboardBookings";
import Shell from "@/components/dashboard/Shell";
import OnboardingChecklist, { type ChecklistItem } from "@/components/dashboard/OnboardingChecklist";

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

  // First-time admin? Push to the onboarding wizard.
  if (user.role === "admin" && tenant && !tenant.onboardingCompletedAt) {
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
  const visibility = user.role === "admin" ? tenantOnly : and(tenantOnly, eq(bookings.staffUserId, user.id));

  const [
    [todayCount],
    [weekCount],
    [cancelledCount],
    [staffCountRow],
    [bookingCountRow],
    [bookedSecondsRow],
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
  ]);

  // Utilization = booked hours / available hours this week (weekly rule only).
  let availableSeconds = 0;
  const rules = await db
    .select({
      startTime: availability.startTime,
      endTime: availability.endTime,
    })
    .from(availability)
    .where(user.role === "admin" ? eq(availability.tenantId, user.tenantId) : and(eq(availability.tenantId, user.tenantId), eq(availability.userId, user.id)));
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

  // Onboarding checklist (only shown when something is incomplete).
  const hasServices = (await db.select({ n: count() }).from(services).where(eq(services.tenantId, user.tenantId)))[0]?.n ?? 0;
  const hasAvailability = (await db.select({ n: count() }).from(availability).where(eq(availability.userId, user.id)))[0]?.n ?? 0;
  const checklistItems: ChecklistItem[] = [
    { id: "google",   label: "Connect Google Calendar",          href: "/dashboard/settings/integrations", done: Boolean(user.googleRefreshToken) },
    { id: "service",  label: "Add at least one service",         href: "/dashboard/services",              done: Number(hasServices) > 0 },
    { id: "hours",    label: "Set your weekly working hours",    href: "/dashboard/availability",          done: Number(hasAvailability) > 0 },
    { id: "booking",  label: "Receive your first booking",       href: "/dashboard/calendar",              done: bookingCount > 0 },
    { id: "branding", label: "Customize your booking page",      href: "/dashboard/settings/branding",     done: Boolean(tenant?.logoUrl || tenant?.tagline) },
  ];

  // Google reconnect banner — appears when a previous booking attempt
  // detected an expired token.
  const showGoogleReconnect = user.googleStatus === "expired" || user.googleStatus === "error";

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.plan, logoUrl: tenant.logoUrl } : undefined}
      title="Dashboard"
      subtitle={`${user.role} · ${user.timezone}`}
    >
      {showGoogleReconnect && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden>
            <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="flex-1">
            <div className="font-medium">Google Calendar needs to be reconnected.</div>
            <div className="mt-0.5 text-xs">
              The last calendar sync failed at {user.googleLastErrorAt?.toISOString() ?? "an unknown time"}. New bookings will be created without Meet links until you reconnect.
            </div>
          </div>
          <a href="/api/google/connect" className="rounded-md bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800">
            Reconnect Google
          </a>
        </div>
      )}

      <OnboardingChecklist items={checklistItems} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
            {tenant?.name ?? "Workspace"}
          </div>
          <h2 className="mt-1 text-heading font-semibold text-ink">Overview</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Signed in as {user.name} ({user.role}) • {user.timezone}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="/dashboard/calendar" className="rounded-md border bg-white px-3 py-2 text-sm hover:bg-slate-50">Calendar</a>
          <a href="/dashboard/availability" className="rounded-md border bg-white px-3 py-2 text-sm hover:bg-slate-50">Weekly hours</a>
          <a href="/dashboard/availability/overrides" className="rounded-md border bg-white px-3 py-2 text-sm hover:bg-slate-50">Overrides</a>
          <a href="/dashboard/analytics" className="rounded-md border bg-white px-3 py-2 text-sm hover:bg-slate-50">Analytics</a>
          {user.role === "admin" && (
            <>
              <a href="/dashboard/billing" className="rounded-md border bg-white px-3 py-2 text-sm hover:bg-slate-50">Billing</a>
              <a href="/dashboard/settings/branding" className="rounded-md border bg-white px-3 py-2 text-sm hover:bg-slate-50">Branding</a>
            </>
          )}
          {!user.googleRefreshToken && (user.role === "admin" || user.role === "staff") && (
            <a href="/api/google/connect" className="rounded-md border bg-white px-3 py-2 text-sm hover:bg-slate-50">Connect Google</a>
          )}
          <form action="/api/auth/logout" method="POST">
            <button className="rounded-md border bg-white px-3 py-2 text-sm hover:bg-slate-50">Sign out</button>
          </form>
        </div>
      </div>

      {/* KPI cards */}
      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Today" value={String(Number(todayCount?.n ?? 0))} />
        <KpiCard label="This week" value={String(Number(weekCount?.n ?? 0))} />
        <KpiCard label="Cancellations (30d)" value={String(Number(cancelledCount?.n ?? 0))} />
        <KpiCard label="Utilization" value={`${utilizationPct}%`} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <KpiCard label="Plan" value={tenant?.plan ?? "free"} muted />
        <KpiCard label="Staff" value={String(staffCount)} muted />
        <KpiCard label="Bookings total" value={String(bookingCount)} muted />
      </div>

      {/* Tabs */}
      <div className="mt-10 flex gap-1 border-b">
        <TabLink active={tab === "today"} label="Today" href="?tab=today" />
        <TabLink active={tab === "upcoming"} label="Upcoming" href="?tab=upcoming" />
        <TabLink active={tab === "cancelled"} label="Cancelled" href="?tab=cancelled" />
        <TabLink active={tab === "completed"} label="Completed" href="?tab=completed" />
      </div>

      <DashboardBookings
        rows={rows.map((r) => ({ ...r, startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString() }))}
        canManage={user.role === "admin" || user.role === "staff"}
        userTimezone={user.timezone}
      />
    </Shell>
  );
}

function KpiCard({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={"rounded-lg border bg-white p-4 shadow-sm " + (muted ? "opacity-90" : "")}>
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold capitalize">{value}</div>
    </div>
  );
}

function TabLink({ active, label, href }: { active: boolean; label: string; href: string }) {
  return (
    <a
      href={href}
      className={
        "border-b-2 px-3 py-2 text-sm " +
        (active ? "border-brand-accent font-medium text-brand-accent" : "border-transparent text-slate-600 hover:text-slate-900")
      }
    >
      {label}
    </a>
  );
}
