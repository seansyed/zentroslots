/**
 * Operational Hardening Wave — Payment Ops dashboard (server entry).
 *
 * Admin-only. Enterprise operations console for the tenant payment
 * vault. Distinct from Settings → Payments (which is configuration);
 * this is observability + refund tooling.
 */

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { getTenantPaymentVaultMetrics } from "@/lib/payments/opsMetrics";
import Shell from "@/components/dashboard/Shell";
import PaymentsOpsClient from "@/components/dashboard/PaymentsOpsClient";

export const dynamic = "force-dynamic";

export default async function PaymentsOpsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({
    where: eq(users.id, session.sub),
  });
  if (!user || user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, user.tenantId),
  });
  if (!tenant) redirect("/dashboard");

  const initialMetrics = await getTenantPaymentVaultMetrics(tenant.id);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.currentPlan,
        logoUrl: tenant.logoUrl,
      }}
      title="Payment Operations"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Operations" },
        { label: "Payments" },
      ]}
    >
      <PaymentsOpsClient initialMetrics={initialMetrics} />
    </Shell>
  );
}
