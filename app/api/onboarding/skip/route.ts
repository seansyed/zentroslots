import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";
import { recordOnboardingEvent } from "@/lib/onboarding/telemetry";
import { ONBOARDING_EVENTS, readProgress } from "@/lib/onboarding/types";

/**
 * Escape hatch — "Finish later". Sets `onboarding_skipped_at` so the
 * dashboard's redirect gate stops forcing the wizard, BUT does NOT set
 * `onboarding_completed_at`. The wizard remains resumable from
 * /dashboard/onboarding at any time and the progress jsonb is
 * preserved untouched.
 *
 * Idempotent: re-skipping is a no-op (returns 200 ok).
 */
export async function POST() {
  try {
    const admin = await requireRole(["admin"]);

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, admin.tenantId),
      columns: {
        onboardingSkippedAt: true,
        onboardingCompletedAt: true,
        onboardingProgress: true,
      },
    });

    // Refuse to "skip" something already complete — that's a no-op but
    // also a hint that the client is confused. Surface a 200 either way.
    if (tenant?.onboardingCompletedAt) {
      return NextResponse.json({ ok: true, alreadyCompleted: true });
    }
    if (tenant?.onboardingSkippedAt) {
      return NextResponse.json({ ok: true, alreadySkipped: true });
    }

    await db
      .update(tenants)
      .set({ onboardingSkippedAt: new Date(), updatedAt: new Date() })
      .where(eq(tenants.id, admin.tenantId));

    void recordOnboardingEvent({
      tenantId: admin.tenantId,
      actorUserId: admin.id,
      action: ONBOARDING_EVENTS.skipped,
      metadata: {
        // Where in the wizard the user was when they bailed — feeds
        // the "abandonment point" metric in future analytics.
        abandonmentPoint: readProgress(tenant?.onboardingProgress).currentStep ?? null,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
