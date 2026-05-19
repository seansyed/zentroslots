/**
 * Communications Hub — Operational Communication Intelligence (Phase 7A).
 *
 * Top-level operational view of the existing outbound communication
 * pipeline. Reads from communication_logs (the same source the existing
 * /settings/communications/logs page uses) and presents it as a
 * customer-grouped conversation stream rather than a flat audit table.
 *
 * No backend changes — server component does a direct, tenant-scoped
 * query identical in shape to the existing logs view. All UI work
 * happens in CommunicationsClient.
 */
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, communicationLogs, customers, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import CommunicationsClient from "@/components/dashboard/CommunicationsClient";

export const dynamic = "force-dynamic";

export default async function CommunicationsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  // Fetch the last 200 communication touchpoints for the tenant,
  // joined to customer + booking so the UI can group by relationship.
  const rows = await db
    .select({
      id: communicationLogs.id,
      channel: communicationLogs.channel,
      eventType: communicationLogs.eventType,
      status: communicationLogs.status,
      provider: communicationLogs.provider,
      failureReason: communicationLogs.failureReason,
      skippedReason: communicationLogs.skippedReason,
      sentAt: communicationLogs.sentAt,
      createdAt: communicationLogs.createdAt,
      customerId: communicationLogs.customerId,
      bookingId: communicationLogs.bookingId,
      customerName: customers.name,
      customerEmail: customers.email,
      customerStatus: customers.status,
      bookingStartAt: bookings.startAt,
    })
    .from(communicationLogs)
    .leftJoin(customers, eq(customers.id, communicationLogs.customerId))
    .leftJoin(bookings, eq(bookings.id, communicationLogs.bookingId))
    .where(and(eq(communicationLogs.tenantId, user.tenantId)))
    .orderBy(desc(communicationLogs.createdAt))
    .limit(200);

  const serialized = rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    eventType: r.eventType,
    status: r.status,
    provider: r.provider,
    failureReason: r.failureReason,
    skippedReason: r.skippedReason,
    sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    customerId: r.customerId,
    bookingId: r.bookingId,
    customerName: r.customerName ?? null,
    customerEmail: r.customerEmail ?? null,
    customerStatus: r.customerStatus ?? null,
    bookingStartAt: r.bookingStartAt ? r.bookingStartAt.toISOString() : null,
  }));

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Communications"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Communications" }]}
    >
      <CommunicationsClient initial={serialized} userTimezone={user.timezone} />
    </Shell>
  );
}
