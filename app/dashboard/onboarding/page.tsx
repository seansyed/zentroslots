import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import OnboardingWizard from "@/components/OnboardingWizard";
import { loadOnboardingProgress } from "@/lib/onboarding/state";
import { recordOnboardingEvent } from "@/lib/onboarding/telemetry";
import { ONBOARDING_EVENTS } from "@/lib/onboarding/types";

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  // Already onboarded? Skip.
  if (tenant.onboardingCompletedAt) redirect("/dashboard");

  // Load persistent progress so the wizard can resume at the right
  // step after a refresh / OAuth round-trip / "Finish later" return.
  const state = await loadOnboardingProgress(tenant.id);
  const initialProgress = state?.progress ?? {};
  const resumeStep = state?.resumeStep ?? "industry";
  const isResumed = Boolean(state?.startedAt);

  // Telemetry: distinguish a fresh entry from a resume. Both fire-and-
  // forget so they never block the render. `recordOnboardingEvent`
  // never throws.
  void recordOnboardingEvent({
    tenantId: tenant.id,
    actorUserId: user.id,
    action: isResumed ? ONBOARDING_EVENTS.resumed : ONBOARDING_EVENTS.started,
    metadata: { resumeStep },
  });

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
        initialStep={resumeStep}
        initialProgress={initialProgress}
      />
    </div>
  );
}
