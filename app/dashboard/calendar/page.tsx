import { redirect } from "next/navigation";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, calendarEvents, services, tenants, users } from "@/db/schema";
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

  // Phase 17I-2C — operational calendar_events (blocked_time +
  // internal_meeting) for the same window. Visibility rules mirror
  // bookings:
  //   • managerial roles see every event in their tenant
  //   • staff role sees events they own OR are an attendee of (the
  //     jsonb attendee_user_ids array is queried via the @> operator
  //     so internal meetings show on every invitee's calendar).
  const eventTenantOnly = eq(calendarEvents.tenantId, user.tenantId);
  const eventVisibility = isManagerial(user.role)
    ? eventTenantOnly
    : and(
        eventTenantOnly,
        or(
          eq(calendarEvents.staffUserId, user.id),
          sql`${calendarEvents.attendeeUserIds} @> ${JSON.stringify([user.id])}::jsonb`,
        ),
      );

  const eventRowsRaw = await db
    .select({
      id: calendarEvents.id,
      eventType: calendarEvents.eventType,
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt,
      meetLink: calendarEvents.meetLink,
      location: calendarEvents.location,
      attendeeUserIds: calendarEvents.attendeeUserIds,
      staffUserId: calendarEvents.staffUserId,
      staffName: users.name,
    })
    .from(calendarEvents)
    .innerJoin(users, eq(users.id, calendarEvents.staffUserId))
    .where(and(eventVisibility, gte(calendarEvents.startAt, start), lt(calendarEvents.startAt, end)))
    .orderBy(desc(calendarEvents.startAt))
    .limit(1000);

  // Resolve attendee display names for internal meetings in a single
  // round-trip. Empty array for blocked_time rows is the common case.
  const allAttendeeIds = Array.from(
    new Set(
      eventRowsRaw.flatMap((r) =>
        Array.isArray(r.attendeeUserIds)
          ? (r.attendeeUserIds as unknown[]).filter(
              (id): id is string => typeof id === "string",
            )
          : [],
      ),
    ),
  );
  const attendeeNameById = new Map<string, string>();
  if (allAttendeeIds.length > 0) {
    const attendeeRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.tenantId, user.tenantId), inArray(users.id, allAttendeeIds)));
    for (const row of attendeeRows) {
      attendeeNameById.set(row.id, row.name);
    }
  }

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
        calendarEvents={eventRowsRaw.map((e) => {
          const attendeeIds: string[] = Array.isArray(e.attendeeUserIds)
            ? (e.attendeeUserIds as unknown[]).filter(
                (id): id is string => typeof id === "string",
              )
            : [];
          return {
            id: e.id,
            eventType: (e.eventType === "blocked_time"
              ? "blocked_time"
              : "internal_meeting") as "blocked_time" | "internal_meeting",
            title: e.title,
            startAt: e.startAt.toISOString(),
            endAt: e.endAt.toISOString(),
            staffId: e.staffUserId,
            staffName: e.staffName,
            attendeeNames: attendeeIds
              .map((id) => attendeeNameById.get(id))
              .filter((n): n is string => Boolean(n)),
            meetLink: e.meetLink ?? null,
            location: e.location ?? null,
          };
        })}
      />
    </Shell>
  );
}
