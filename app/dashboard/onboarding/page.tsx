import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import OnboardingWizard from "@/components/OnboardingWizard";

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  // Already onboarded? Skip.
  if (tenant.onboardingCompletedAt) redirect("/dashboard");

  return (
    <div className="mx-auto max-w-xl px-6 py-12">
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
        {tenant.name}
      </div>
      <h1 className="mt-1 text-2xl font-semibold">Set up your workspace</h1>
      <p className="mt-1 text-sm text-slate-600">A few quick steps and you&rsquo;re ready to take bookings.</p>

      <OnboardingWizard
        defaultTimezone={user.timezone}
        tenantSlug={tenant.slug}
      />
    </div>
  );
}
