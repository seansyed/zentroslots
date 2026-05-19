import { redirect } from "next/navigation";
import { and, desc, eq, gte, lt } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, tenants, users } from "@/db/schema";
import { getSession, isManagerial } from "@/lib/auth";
import { loadTenantFeatures } from "@/lib/features";
import { effectivePermissions } from "@/lib/security/permissions";
import Shell from "@/components/dashboard/Shell";
import AppointmentsAgenda from "@/components/dashboard/AppointmentsAgenda";
import AppointmentsSidePanel from "@/components/dashboard/AppointmentsSidePanel";
import { FadeIn } from "@/components/ui/Motion";
import { Download, CalendarRange } from "lucide-react";

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

  const features = await loadTenantFeatures(user.tenantId);
  const permissions = effectivePermissions(user);

  const serializedRows = page.map((r) => ({
    ...r,
    startAt: r.startAt.toISOString(),
    endAt: r.endAt.toISOString(),
    status: r.status,
  }));

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role, permissions }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Appointments"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Appointments" }]}
    >
      <FadeIn delay={0}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[26px] font-semibold tracking-tight text-ink sm:text-[28px]">
              Appointments
            </h1>
            <p className="mt-1 text-[13px] text-ink-muted">
              Every booking across your workspace, in a calm scheduling timeline.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="/dashboard/calendar"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow"
            >
              <CalendarRange className="h-3.5 w-3.5" strokeWidth={1.75} />
              Open calendar
            </a>
            <a
              href={`/api/bookings/export${status ? `?status=${status}` : ""}`}
              download
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
              Export CSV
            </a>
          </div>
        </div>
      </FadeIn>

      <FadeIn delay={1} className="mt-6">
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <AppointmentsAgenda
            rows={serializedRows}
            timezone={user.timezone}
            canManage={user.role === "admin" || user.role === "staff" || user.role === "manager"}
            canCancel={features.cancellations}
            currentStatus={status}
            nextCursor={nextCursor}
          />
          <AppointmentsSidePanel
            rows={serializedRows.map((r) => ({
              id: r.id,
              startAt: r.startAt,
              endAt: r.endAt,
              status: r.status,
              clientName: r.clientName,
              serviceName: r.serviceName,
              meetLink: r.meetLink,
            }))}
            timezone={user.timezone}
          />
        </div>
      </FadeIn>
    </Shell>
  );
}
