import { redirect } from "next/navigation";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, customers, services, tenants, users } from "@/db/schema";
import { getSession, isManagerial } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";

export const metadata = { title: "Reports" };

// Two-week comparison: this period vs the same length prior period.
// Powers a tiny "Δ vs prior" badge under each snapshot stat.
function parseRange(rangeParam: string | undefined): { from: Date; to: Date; days: number; priorFrom: Date; priorTo: Date } {
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

function deltaTone(now: number, prior: number, higherIsBetter = true): { label: string; tone: "green" | "red" | "neutral" } {
  if (prior === 0 && now === 0) return { label: "—", tone: "neutral" };
  if (prior === 0) return { label: `+${now}`, tone: higherIsBetter ? "green" : "red" };
  const diff = now - prior;
  const pct = Math.round((diff / Math.max(1, prior)) * 100);
  const sign = pct > 0 ? "+" : "";
  const positive = diff > 0;
  const tone: "green" | "red" | "neutral" =
    diff === 0 ? "neutral" : positive === higherIsBetter ? "green" : "red";
  return { label: `${sign}${pct}% vs prior`, tone };
}

export default async function ReportsPage(props: {
  searchParams: Promise<{ range?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  const sp = await props.searchParams;
  const { from, to, days, priorFrom, priorTo } = parseRange(sp.range);

  // Staff are scoped to their own bookings — admin sees the whole tenant.
  // Same convention as the /dashboard home and /api/bookings/export.
  const visibility = isManagerial(user.role)
    ? eq(bookings.tenantId, user.tenantId)
    : and(eq(bookings.tenantId, user.tenantId), eq(bookings.staffUserId, user.id));

  const [
    [bookingsNow],     [bookingsPrior],
    [confirmedNow],    [confirmedPrior],
    [cancelledNow],    [cancelledPrior],
    [noShowNow],       [noShowPrior],
    [revenueNow],      [revenuePrior],
    [newCustomersNow], [newCustomersPrior],
    [staffCountRow],
    perStaff,
  ] = await Promise.all([
    db.select({ n: count() }).from(bookings).where(and(visibility, gte(bookings.startAt, from), lt(bookings.startAt, to))),
    db.select({ n: count() }).from(bookings).where(and(visibility, gte(bookings.startAt, priorFrom), lt(bookings.startAt, priorTo))),
    db.select({ n: count() }).from(bookings).where(and(visibility, eq(bookings.status, "confirmed"), gte(bookings.startAt, from), lt(bookings.startAt, to))),
    db.select({ n: count() }).from(bookings).where(and(visibility, eq(bookings.status, "confirmed"), gte(bookings.startAt, priorFrom), lt(bookings.startAt, priorTo))),
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
  ]);

  const bookingsTotal = Number(bookingsNow?.n ?? 0);
  const bookingsTotalPrior = Number(bookingsPrior?.n ?? 0);
  const cancelTotal = Number(cancelledNow?.n ?? 0);
  const cancelPrior = Number(cancelledPrior?.n ?? 0);
  const noShowTotal = Number(noShowNow?.n ?? 0);
  const noShowPriorTotal = Number(noShowPrior?.n ?? 0);
  const revenueCents = Number(revenueNow?.sum ?? 0);
  const revenuePriorCents = Number(revenuePrior?.sum ?? 0);
  const newCustomersTotal = Number(newCustomersNow?.n ?? 0);
  const newCustomersPriorTotal = Number(newCustomersPrior?.n ?? 0);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Reports"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Reports" }]}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-heading font-semibold text-ink">Reports</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Operational snapshots and CSV exports for {days}-day window ({from.toISOString().slice(0, 10)} → {to.toISOString().slice(0, 10)}).
          </p>
        </div>
        <div className="flex gap-1.5 text-sm">
          {[7, 30, 90, 365].map((d) => (
            <a
              key={d}
              href={`/dashboard/reports?range=${d}`}
              className={
                "rounded-md border px-3 py-1.5 " +
                (d === days
                  ? "border-brand-accent bg-brand-accent text-white"
                  : "border-border bg-surface text-ink-muted hover:bg-surface-inset")
              }
            >
              {d === 365 ? "1y" : `${d}d`}
            </a>
          ))}
        </div>
      </div>

      {/* Snapshot grid */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Snapshot
          label="Bookings"
          value={String(bookingsTotal)}
          delta={deltaTone(bookingsTotal, bookingsTotalPrior, true)}
        />
        <Snapshot
          label="Confirmed"
          value={String(Number(confirmedNow?.n ?? 0))}
          delta={deltaTone(Number(confirmedNow?.n ?? 0), Number(confirmedPrior?.n ?? 0), true)}
        />
        <Snapshot
          label="Cancellations"
          value={String(cancelTotal)}
          delta={deltaTone(cancelTotal, cancelPrior, false)}
        />
        <Snapshot
          label="No-shows"
          value={String(noShowTotal)}
          delta={deltaTone(noShowTotal, noShowPriorTotal, false)}
        />
        <Snapshot
          label="Revenue est"
          value={"$" + Math.round(revenueCents / 100).toLocaleString()}
          delta={deltaTone(revenueCents, revenuePriorCents, true)}
        />
        <Snapshot
          label="New customers"
          value={String(newCustomersTotal)}
          delta={deltaTone(newCustomersTotal, newCustomersPriorTotal, true)}
        />
      </div>

      {/* Exports */}
      <h2 className="mt-10 text-lg font-medium">Exports</h2>
      <p className="mt-1 text-sm text-ink-muted">Download data in CSV. Filters honored.</p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <ExportCard
          title="Appointments"
          desc="Every booking with service, staff, client, price."
          href="/api/bookings/export"
        />
        <ExportCard
          title="Customers"
          desc="Customer roster with tags + booking aggregates."
          href="/api/customers/export"
        />
        <ExportCard
          title="Tenants"
          desc="Super-admin export (visible only to platform owner)."
          href="/api/admin/exports/tenants"
          hint="Requires super-admin"
        />
      </div>

      {/* Staff utilization */}
      <h2 className="mt-10 text-lg font-medium">Staff utilization (last {days}d)</h2>
      <div className="mt-3 overflow-hidden rounded-lg border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Staff</th>
              <th className="px-4 py-2 text-right">Confirmed</th>
              <th className="px-4 py-2 text-right">Completed</th>
              <th className="px-4 py-2 text-right">Cancelled</th>
              <th className="px-4 py-2 text-right">No-show</th>
              <th className="px-4 py-2 text-right">Hours booked</th>
            </tr>
          </thead>
          <tbody>
            {perStaff.length === 0 && (
              <tr><td colSpan={6} className="p-8 text-center text-sm text-slate-500">No bookings in this window.</td></tr>
            )}
            {perStaff.map((r) => {
              const hours = (Number(r.bookedMinutes ?? 0) / 60).toFixed(1);
              return (
                <tr key={r.staffId} className="border-t">
                  <td className="px-4 py-2 font-medium">{r.staffName}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(r.confirmed)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(r.completed)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{Number(r.cancelled)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{Number(r.noShow)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{hours}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="border-t bg-slate-50 px-4 py-2 text-xs text-ink-subtle">
          {Number(staffCountRow?.n ?? 0)} staff member{Number(staffCountRow?.n ?? 0) === 1 ? "" : "s"} in workspace
        </div>
      </div>
    </Shell>
  );
}

function Snapshot({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta: { label: string; tone: "green" | "red" | "neutral" };
}) {
  const toneClass =
    delta.tone === "green" ? "text-green-700 bg-green-100" :
    delta.tone === "red" ? "text-red-700 bg-red-100" :
    "text-slate-600 bg-slate-100";
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      <div className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${toneClass}`}>
        {delta.label}
      </div>
    </div>
  );
}

function ExportCard({ title, desc, href, hint }: { title: string; desc: string; href: string; hint?: string }) {
  return (
    <a
      href={href}
      download
      className="block rounded-lg border bg-white p-5 shadow-sm transition hover:border-brand-accent hover:shadow"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-base font-medium">{title}</h3>
        <span className="text-sm text-brand-accent">↓ CSV</span>
      </div>
      <p className="mt-1 text-sm text-ink-muted">{desc}</p>
      {hint && <p className="mt-2 text-[11px] uppercase tracking-wider text-ink-subtle">{hint}</p>}
    </a>
  );
}
