/**
 * Wave I — Settings → Intake forms (server entry).
 */

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { getPlan } from "@/lib/plans";
import { resolveIntakeLimits } from "@/lib/plans/intakeLimits";
import Shell from "@/components/dashboard/Shell";
import IntakeFormsClient from "@/components/dashboard/IntakeFormsClient";

export const dynamic = "force-dynamic";

export default async function IntakeFormsPage() {
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

  const plan = getPlan(tenant.currentPlan);
  const limits = resolveIntakeLimits(tenant.currentPlan);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.currentPlan,
        logoUrl: tenant.logoUrl,
      }}
      title="Intake forms"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Intake forms" },
      ]}
    >
      <IntakeFormsClient
        planId={plan.id}
        planName={plan.name}
        maxFields={limits.maxIntakeFields}
        typeWhitelist={limits.typeWhitelist}
      />
    </Shell>
  );
}
