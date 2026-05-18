import { redirect } from "next/navigation";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, communicationLogs, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import CommunicationLogsClient from "@/components/dashboard/CommunicationLogsClient";

export const metadata = { title: "Delivery logs" };
export const dynamic = "force-dynamic";

const STATUS_OPTIONS = ["all", "sent", "failed", "skipped"] as const;

export default async function DeliveryLogsPage(props: {
  searchParams: Promise<{ status?: string; event?: string; q?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || (user.role !== "admin" && user.role !== "manager")) redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const sp = await props.searchParams;
  const statusFilter = (STATUS_OPTIONS as readonly string[]).includes(sp.status ?? "")
    ? sp.status
    : "all";
  const eventFilter = (sp.event ?? "").trim();
  const search = (sp.q ?? "").trim();

  const conds = [eq(communicationLogs.tenantId, tenant.id)];
  if (statusFilter && statusFilter !== "all") {
    conds.push(eq(communicationLogs.status, statusFilter));
  }
  if (eventFilter) {
    conds.push(eq(communicationLogs.eventType, eventFilter));
  }

  // Search: matches booking_id prefix OR a booking's client_email substring.
  // We pre-resolve email→booking-ids since communication_logs doesn't
  // store the email directly. Tenant isolation enforced — booking
  // join also filtered by tenant_id.
  if (search) {
    // Booking-id prefix path: short circuits if user typed a UUID-y thing.
    const looksLikeId = /^[0-9a-fA-F-]{4,}$/.test(search);

    const matchingBookings = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, tenant.id),
          or(
            ilike(bookings.clientEmail, `%${search}%`),
            ilike(bookings.clientName, `%${search}%`),
            // Booking id startsWith — guard with looksLikeId to avoid
            // accidentally matching everything when the user typed a
            // single letter.
            looksLikeId ? sql`${bookings.id}::text ILIKE ${search + "%"}` : sql`false`
          )
        )
      )
      .limit(500);

    const ids = matchingBookings.map((r) => r.id);

    if (ids.length === 0 && !looksLikeId) {
      // No bookings match — force empty result rather than ignoring
      // the search clause.
      conds.push(sql`false`);
    } else if (ids.length === 0 && looksLikeId) {
      // Maybe they pasted a partial communication-log id directly.
      conds.push(sql`${communicationLogs.bookingId}::text ILIKE ${search + "%"}`);
    } else {
      // sql.join would be cleaner, but inArray is the right primitive.
      // Use a raw IN with parameter binding via sql template.
      conds.push(sql`${communicationLogs.bookingId} = ANY(${ids})`);
    }
  }

  const rows = await db
    .select()
    .from(communicationLogs)
    .where(and(...conds))
    .orderBy(desc(communicationLogs.createdAt))
    .limit(200);

  // Distinct event types seen in tenant history — drives the filter
  // dropdown. Pulled from a separate query so we still show the
  // dropdown after the search narrows results to zero.
  const eventTypeRows = await db
    .selectDistinct({ eventType: communicationLogs.eventType })
    .from(communicationLogs)
    .where(eq(communicationLogs.tenantId, tenant.id));
  const eventTypes = eventTypeRows.map((r) => r.eventType).sort();

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Delivery logs"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Communications" },
        { label: "Delivery logs" },
      ]}
    >
      <CommunicationLogsClient
        rows={rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          sentAt: r.sentAt?.toISOString() ?? null,
        }))}
        statusFilter={statusFilter ?? "all"}
        eventFilter={eventFilter}
        search={search}
        eventTypes={eventTypes}
      />
    </Shell>
  );
}
