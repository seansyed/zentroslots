import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";
import { checkActivationIntegrity, ACTIVATION_BLOCKER_COPY } from "@/lib/onboarding/integrity";
import { markStep, updateOnboardingProgress } from "@/lib/onboarding/state";
import { recordOnboardingEvent } from "@/lib/onboarding/telemetry";
import { ONBOARDING_EVENTS, readProgress } from "@/lib/onboarding/types";

/**
 * Finalize onboarding. Enforces activation integrity invariants — a
 * tenant cannot be marked "complete" without the minimums in place
 * (at least one service + at least one availability rule). The
 * "Finish later" escape hatch (POST /api/onboarding/skip) is the
 * release valve for users who genuinely want to come back later.
 *
 * Idempotent: re-calling complete on an already-completed tenant is
 * a no-op (returns 200 ok). This matters because the wizard's final
 * step does a hard navigation; a refresh-during-redirect mustn't blow
 * up.
 */
export async function POST() {
  try {
    const admin = await requireRole(["admin"]);

    // Idempotency: if already complete, return ok without re-writing.
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, admin.tenantId),
      columns: {
        onboardingCompletedAt: true,
        onboardingProgress: true,
        onboardingStartedAt: true,
      },
    });
    if (tenant?.onboardingCompletedAt) {
      return NextResponse.json({ ok: true, alreadyCompleted: true });
    }

    // Integrity check — same invariants the public booking page needs.
    const integrity = await checkActivationIntegrity(admin.tenantId, admin.id);
    if (!integrity.ok) {
      void recordOnboardingEvent({
        tenantId: admin.tenantId,
        actorUserId: admin.id,
        action: ONBOARDING_EVENTS.integrityBlocked,
        metadata: { blockers: integrity.blockers },
      });
      return NextResponse.json(
        {
          error: "Onboarding incomplete",
          blockers: integrity.blockers,
          blockerMessages: integrity.blockers.map((b) => ACTIVATION_BLOCKER_COPY[b]),
        },
        { status: 400 },
      );
    }

    // Mark the terminal "done" step + close out telemetry.
    const startedAtMs = tenant?.onboardingStartedAt?.getTime() ?? Date.now();
    const totalTimeMs = Math.max(0, Date.now() - startedAtMs);

    await markStep(admin.tenantId, "done", "complete");
    await updateOnboardingProgress(admin.tenantId, (prev) => ({
      ...prev,
      currentStep: "done",
      telemetry: {
        ...(prev.telemetry ?? {}),
        totalTimeMs,
      },
    }));

    await db
      .update(tenants)
      .set({ onboardingCompletedAt: new Date(), updatedAt: new Date() })
      .where(eq(tenants.id, admin.tenantId));

    void recordOnboardingEvent({
      tenantId: admin.tenantId,
      actorUserId: admin.id,
      action: ONBOARDING_EVENTS.completed,
      metadata: {
        totalTimeMs,
        templateApplied: readProgress(tenant?.onboardingProgress).templateApplied ?? null,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
