import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { customers, tenants } from "@/db/schema";
import { getClientSession } from "@/lib/client-auth";

/**
 * Shared bootstrap for every authed client-portal page.
 *
 * Verifies the session, confirms the tenant slug matches the cookie's
 * tenantId (prevents accidentally rendering one tenant's portal while
 * holding another tenant's session), and re-fetches the customer to
 * pick up any name/email/phone updates.
 *
 * Returns `{ tenant, customer }` or redirects to /login.
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

  return { tenant, customer };
}
