import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import OnboardingWizard from "@/components/OnboardingWizard";
import { loadOnboardingProgress } from "@/lib/onboarding/state";
import { recordOnboardingEvent } from "@/lib/onboarding/telemetry";
import { ONBOARDING_EVENTS } from "@/lib/onboarding/types";

export const dynamic = "force-dynamic";

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
  // forget so they never block the render.
  void recordOnboardingEvent({
    tenantId: tenant.id,
    actorUserId: user.id,
    action: isResumed ? ONBOARDING_EVENTS.resumed : ONBOARDING_EVENTS.started,
    metadata: { resumeStep },
  });

  return (
    <OnboardingWizard
      defaultTimezone={user.timezone}
      tenantName={tenant.name}
      tenantSlug={tenant.slug}
      tenantPlan={tenant.currentPlan ?? tenant.plan ?? "free"}
      userEmail={user.email}
      userName={user.name}
      initialStep={resumeStep}
      initialProgress={initialProgress}
      hasGoogleConnected={Boolean(user.googleRefreshToken)}
    />
  );
}
