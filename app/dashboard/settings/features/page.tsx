import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantFeatureSettings, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAGS,
  FEATURE_FLAG_META,
  mergeFlags,
} from "@/lib/features";
import Shell from "@/components/dashboard/Shell";
import FeatureControlsClient from "@/components/dashboard/FeatureControlsClient";

export const metadata = { title: "Feature controls" };

export default async function FeatureControlsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  // Admin-only — managers don't have the keys to the workspace switches.
  if (!user || user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const row = await db.query.tenantFeatureSettings.findFirst({
    where: eq(tenantFeatureSettings.tenantId, tenant.id),
  });
  const initial = mergeFlags(row?.flags);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Feature controls"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Feature controls" },
      ]}
    >
      <h1 className="text-heading font-semibold text-ink">Feature controls</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        Turn features on or off for your entire workspace. Every toggle
        here enforces real runtime behavior — APIs reject the action,
        UI hides the controls, and automated emails skip the event.
      </p>

      <FeatureControlsClient
        initialFlags={initial}
        defaults={DEFAULT_FEATURE_FLAGS}
        meta={FEATURE_FLAG_META}
        keys={FEATURE_FLAGS as unknown as string[]}
      />
    </Shell>
  );
}
