import { redirect } from "next/navigation";
import { and, desc, eq, gte, lt } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, tenants, users } from "@/db/schema";
import { getSession, isManagerial } from "@/lib/auth";
import { loadTenantFeatures } from "@/lib/features";
import Shell from "@/components/dashboard/Shell";
import AppointmentsTable from "@/components/dashboard/AppointmentsTable";

const PAGE_SIZE = 30;

export default async function AppointmentsPage(props: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  const sp = await props.searchParams;
  const status = sp.status ?? "";
  const cursorAt = sp.cursor ? new Date(sp.cursor) : null;

  const tenantOnly = eq(bookings.tenantId, user.tenantId);
  const visibility =
    isManagerial(user.role) ? tenantOnly : and(tenantOnly, eq(bookings.staffUserId, user.id));

  const ninetyDaysAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 90);

  const conds = [visibility, gte(bookings.startAt, ninetyDaysAgo)];
  const validStatuses = ["pending", "confirmed", "cancelled", "completed", "no_show"] as const;
  if (status && (validStatuses as readonly string[]).includes(status)) {
    conds.push(eq(bookings.status, status as typeof validStatuses[number]));
  }
  if (cursorAt && !Number.isNaN(cursorAt.getTime())) {
    conds.push(lt(bookings.startAt, cursorAt));
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
      notes: bookings.notes,
      serviceId: services.id,
      serviceName: services.name,
      staffId: users.id,
      staffName: users.name,
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .innerJoin(users, eq(users.id, bookings.staffUserId))
    .where(and(...conds))
    .orderBy(desc(bookings.startAt))
    .limit(PAGE_SIZE + 1);

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor = hasMore ? page[page.length - 1].startAt.toISOString() : null;

  // Resolve tenant feature flags once and pass relevant ones into the
  // client table so the drawer can hide buttons whose actions are
  // disabled at the API layer. The API stays the security boundary —
  // this just keeps the UI honest.
  const features = await loadTenantFeatures(user.tenantId);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Appointments"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Appointments" }]}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-heading font-semibold text-ink">Appointments</h1>
          <p className="mt-1 text-sm text-ink-muted">Manage every booking across your workspace.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={`/api/bookings/export${status ? `?status=${status}` : ""}`}
            download
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-inset"
          >
            ↓ Export CSV
          </a>
          <a
            href="/dashboard/calendar"
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-inset"
          >
            Open calendar
          </a>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5 text-sm">
        {[
          { slug: "",          label: "All" },
          { slug: "confirmed", label: "Confirmed" },
          { slug: "pending",   label: "Pending" },
          { slug: "cancelled", label: "Cancelled" },
          { slug: "completed", label: "Completed" },
          { slug: "no_show",   label: "No-show" },
        ].map((chip) => {
          const isActive = (status || "") === chip.slug;
          const href = chip.slug ? `/dashboard/appointments?status=${chip.slug}` : "/dashboard/appointments";
          return (
            <a
              key={chip.slug || "all"}
              href={href}
              className={
                "rounded-md border px-3 py-1.5 " +
                (isActive
                  ? "border-brand-accent bg-brand-accent text-white"
                  : "border-border bg-surface text-ink-muted hover:bg-surface-inset")
              }
            >
              {chip.label}
            </a>
          );
        })}
      </div>

      <AppointmentsTable
        rows={page.map((r) => ({
          ...r,
          startAt: r.startAt.toISOString(),
          endAt: r.endAt.toISOString(),
          status: r.status as "pending" | "confirmed" | "cancelled" | "completed" | "no_show",
        }))}
        timezone={user.timezone}
        canManage={user.role === "admin" || user.role === "staff" || user.role === "manager"}
        canCancel={features.cancellations}
        currentStatus={status}
        nextCursor={nextCursor}
      />
    </Shell>
  );
}
