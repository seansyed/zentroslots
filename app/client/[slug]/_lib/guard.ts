import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { auditLogs, bookings, customers, tenants } from "@/db/schema";
import { getClientSession } from "@/lib/client-auth";

/**
 * Shared bootstrap for every authed client-portal page.
 *
 * Verifies the session, confirms the tenant slug matches the cookie's
 * tenantId (prevents accidentally rendering one tenant's portal while
 * holding another tenant's session), and re-fetches the customer to
 * pick up any name/email/phone updates.
 *
 * Returns `{ tenant, customer, hasUnread }` or redirects to /login.
 *
 * Wave 4 — `hasUnread` is a single EXISTS check over audit_logs for
 * any booking-lifecycle / email event newer than the customer's
 * `notifications_last_seen_at`. It powers the dot indicator on the
 * Alerts tab in ClientPortalShell. EXISTS short-circuits on first
 * match — cheap even for power users.
 */
export async function requireClientPortalContext(slug: string) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant || !tenant.active) redirect(`/client/${slug}/login`);

  const session = await getClientSession();
  if (!session || session.tenantId !== tenant.id) {
    redirect(`/client/${slug}/login`);
  }

  const customer = await db.query.customers.findFirst({
    where: and(eq(customers.id, session.customerId), eq(customers.tenantId, tenant.id)),
  });
  if (!customer) {
    // Customer was deleted out from under the session — force a clean re-login.
    redirect(`/client/${slug}/login`);
  }

  // ── F32 unread indicator ──
  // EXISTS over audit_logs for any event (booking lifecycle + email
  // ops) tied to one of this customer's bookings, newer than the
  // customer's last seen timestamp. Returns false fast when there's
  // no activity at all.
  const lastSeen = customer.notificationsLastSeenAt ?? new Date(0);
  const [row] = await db.execute<{ has_unread: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
        FROM ${auditLogs}
       WHERE ${auditLogs.tenantId} = ${tenant.id}
         AND ${auditLogs.entityType} = 'booking'
         AND ${auditLogs.action} = ANY(ARRAY[
           'booking.create',
           'booking.cancel',
           'booking.reschedule',
           'email.sent',
           'email.failed'
         ])
         AND ${auditLogs.createdAt} > ${lastSeen}
         AND ${auditLogs.entityId} IN (
           SELECT id FROM ${bookings}
            WHERE ${bookings.tenantId} = ${tenant.id}
              AND lower(${bookings.clientEmail}) = ${customer.email.toLowerCase()}
         )
    ) AS has_unread
  `);
  const hasUnread = Boolean(row?.has_unread);

  return { tenant, customer, hasUnread };
}
