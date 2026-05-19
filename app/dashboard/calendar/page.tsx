import { redirect } from "next/navigation";
import { and, desc, eq, gte, lt } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, tenants, users } from "@/db/schema";
import { getSession, isManagerial } from "@/lib/auth";
import CalendarView from "@/components/CalendarView";
import Shell from "@/components/dashboard/Shell";

export default async function CalendarPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");

  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  // Fetch ±60 day window of tenant bookings. Pure client-side rendering
  // chooses which view + which dates to display.
  const now = new Date();
  const start = new Date(now); start.setDate(start.getDate() - 60);
  const end = new Date(now); end.setDate(end.getDate() + 60);

  const tenantOnly = eq(bookings.tenantId, user.tenantId);
  const visibility =
    isManagerial(user.role)
      ? tenantOnly
      : and(tenantOnly, eq(bookings.staffUserId, user.id));

  const rows = await db
    .select({
      id: bookings.id,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      status: bookings.status,
      clientName: bookings.clientName,
      clientEmail: bookings.clientEmail,
      meetLink: bookings.meetLink,
      serviceId: services.id,
      serviceName: services.name,
      serviceColor: services.color,
      staffId: users.id,
      staffName: users.name,
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .innerJoin(users, eq(users.id, bookings.staffUserId))
    .where(and(visibility, gte(bookings.startAt, start), lt(bookings.startAt, end)))
    .orderBy(desc(bookings.startAt))
    .limit(1000);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.plan, logoUrl: tenant.logoUrl } : undefined}
      title="Calendar"
      subtitle={user.timezone}
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Calendar" }]}
    >
      <CalendarView
        timezone={user.timezone}
        canManage={user.role === "admin" || user.role === "staff" || user.role === "manager"}
        bookings={rows.map((r) => ({
          id: r.id,
          startAt: r.startAt.toISOString(),
          endAt: r.endAt.toISOString(),
          status: r.status as "pending" | "confirmed" | "cancelled" | "completed" | "no_show",
          serviceId: r.serviceId,
          serviceName: r.serviceName,
          serviceColor: r.serviceColor ?? null,
          staffId: r.staffId,
          staffName: r.staffName,
          clientName: r.clientName,
          clientEmail: r.clientEmail,
          meetLink: r.meetLink ?? null,
        }))}
      />
    </Shell>
  );
}
