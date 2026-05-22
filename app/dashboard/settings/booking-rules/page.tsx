import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { loadCapabilitiesForTenant } from "@/lib/billing/loadCapabilities";
import Shell from "@/components/dashboard/Shell";
import BookingRulesClient from "@/components/dashboard/BookingRulesClient";
import { CapabilityProvider } from "@/components/billing/CapabilityProvider";

export const metadata = { title: "Booking rules" };
export const dynamic = "force-dynamic";

export default async function BookingRulesPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || (user.role !== "admin" && user.role !== "manager")) redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  // Phase 3 capability hydration — server-fetched payload so the
  // client tree can read booking_rules / plan state via the hook.
  const capabilities = await loadCapabilitiesForTenant(tenant.id);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Booking rules"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Booking rules" },
      ]}
    >
      <CapabilityProvider initial={capabilities}>
        {/* Hero + page chrome live in the client now (Phase 15-BR
            refinement) — gives a single source of truth for the
            policy-page header + scope badge + insights strip. */}
        <BookingRulesClient />
      </CapabilityProvider>
    </Shell>
  );
}
