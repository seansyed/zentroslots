import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import BrandingForm from "@/components/BrandingForm";
import { planFeature } from "@/lib/quotas";
import Shell from "@/components/dashboard/Shell";

export default async function BrandingPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const allowed = planFeature(tenant.currentPlan, "customBranding");

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Branding"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Settings" }, { label: "Branding" }]}
    >
      <h1 className="text-heading font-semibold text-ink">Branding</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Customize how your public booking page looks at <code className="rounded bg-surface-inset px-1.5 py-0.5">/u/{tenant.slug}</code>.
      </p>

      {!allowed && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Custom branding is a Pro feature. <a href="/dashboard/billing" className="font-medium underline">Upgrade your plan</a> to edit these fields.
        </div>
      )}

      <BrandingForm
        disabled={!allowed}
        tenantSlug={tenant.slug}
        initial={{
          name: tenant.name,
          logoUrl: tenant.logoUrl ?? "",
          primaryColor: tenant.primaryColor,
          tagline: tenant.tagline ?? "",
          description: tenant.description ?? "",
          bookingHeadline: tenant.bookingHeadline ?? "",
        }}
      />
    </Shell>
  );
}
