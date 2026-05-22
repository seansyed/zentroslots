import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { loadCapabilitiesForTenant } from "@/lib/billing/loadCapabilities";
import Shell from "@/components/dashboard/Shell";
import WaitlistsClient from "@/components/dashboard/WaitlistsClient";
import { CapabilityProvider } from "@/components/billing/CapabilityProvider";

export const metadata = { title: "Waitlists" };
export const dynamic = "force-dynamic";

export default async function WaitlistsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || (user.role !== "admin" && user.role !== "manager")) redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  // Phase 3 capability hydration — server-fetched payload feeds
  // <CapabilityProvider> so children can consume capabilities via
  // useCapability() (e.g., future "waitlists Pro+" gates).
  const capabilities = await loadCapabilitiesForTenant(tenant.id);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Waitlists"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Waitlists" },
      ]}
    >
      <CapabilityProvider initial={capabilities}>
        {/* Hero + page chrome live inside the client now — single
            source of truth for header + KPIs + engine panel. */}
        <WaitlistsClient />
      </CapabilityProvider>
    </Shell>
  );
}
