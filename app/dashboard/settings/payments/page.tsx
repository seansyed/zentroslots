/**
 * Wave H Phase 5 — Settings → Payments page (server entry).
 *
 * Admin-only. Loads the tenant's configured payment providers + the
 * tenant-level use_tenant_payment_providers flag, then hands off to
 * the client component for all interactivity.
 *
 * The client component reloads via the API on every mutation, so the
 * server-side initial data is just for first paint — the source of
 * truth always comes back from /api/tenant/payment-providers.
 */

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { listProvidersForTenant } from "@/lib/payments/connections";
import Shell from "@/components/dashboard/Shell";
import PaymentsClient from "@/components/dashboard/PaymentsClient";

export const dynamic = "force-dynamic";

export default async function PaymentsPage() {
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

  const providers = await listProvidersForTenant(tenant.id);

  // The receiver URL the tenant pastes into their Stripe / PayPal
  // dashboards. Built once on the server so client never has to
  // guess at process.env.
  const appBaseUrl = (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.currentPlan,
        logoUrl: tenant.logoUrl,
      }}
      title="Payments"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Payments" },
      ]}
    >
      <PaymentsClient
        initialProviders={providers.map((p) => ({
          ...p,
          // Date → string for client serialization.
          lastVerifiedAt: p.lastVerifiedAt?.toISOString() ?? null,
          lastErrorAt: p.lastErrorAt?.toISOString() ?? null,
          lastPaymentEventAt: p.lastPaymentEventAt?.toISOString() ?? null,
          lastWebhookVerifiedAt: p.lastWebhookVerifiedAt?.toISOString() ?? null,
          lastWebhookErrorAt: p.lastWebhookErrorAt?.toISOString() ?? null,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
        }))}
        appBaseUrl={appBaseUrl}
        useTenantPaymentProviders={tenant.useTenantPaymentProviders}
      />
    </Shell>
  );
}
