import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { loadCapabilitiesForTenant } from "@/lib/billing/loadCapabilities";
import Shell from "@/components/dashboard/Shell";
import RecurringClient from "@/components/dashboard/RecurringClient";
import { CapabilityProvider } from "@/components/billing/CapabilityProvider";

export const metadata = { title: "Recurring bookings" };
export const dynamic = "force-dynamic";

export default async function RecurringBookingsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || (user.role !== "admin" && user.role !== "manager")) redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  // Phase 3 capability hydration — server-fetched payload feeds
  // <CapabilityProvider> below so any child can read recurring_series
  // / plan state via useCapability() without a client fetch.
  const capabilities = await loadCapabilitiesForTenant(tenant.id);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Recurring bookings"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Recurring bookings" },
      ]}
    >
      <CapabilityProvider initial={capabilities}>
        {/* Hero + page chrome live inside the client now — single
            source of truth for the header + KPIs + engine panel. */}
        <RecurringClient />
      </CapabilityProvider>
    </Shell>
  );
}
