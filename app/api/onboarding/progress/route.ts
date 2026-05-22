import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import {
  loadOnboardingProgress,
  markStep,
  markStepViewed,
} from "@/lib/onboarding/state";
import { recordOnboardingEvent } from "@/lib/onboarding/telemetry";
import {
  ONBOARDING_EVENTS,
  ONBOARDING_STEPS,
  type OnboardingStep,
  type OnboardingStepStatus,
} from "@/lib/onboarding/types";

/**
 * Onboarding progress API — read + per-step write surface used by the
 * wizard so a refresh / OAuth round-trip / tab close never loses state.
 *
 * GET   /api/onboarding/progress
 *   Returns { progress, startedAt, skippedAt, completedAt, resumeStep }.
 *
 * PATCH /api/onboarding/progress
 *   Body:
 *     { step: OnboardingStep, status: "in_progress" | "complete" | "skipped",
 *       data?: Record<string, unknown> }
 *   Writes the single step's status atomically. The "in_progress" status
 *   is special — it short-circuits if the step is already complete/skipped,
 *   so the wizard can safely call it on mount without clobbering history.
 *
 * Admin-only for both verbs — same gate as the rest of the onboarding
 * surface.
 */

const VALID_STEPS = ONBOARDING_STEPS as readonly string[];
const VALID_STATUSES: readonly OnboardingStepStatus[] = [
  "pending",
  "in_progress",
  "complete",
  "skipped",
];

const patchSchema = z.object({
  step: z.enum([
    ONBOARDING_STEPS[0],
    ...ONBOARDING_STEPS.slice(1),
  ] as [OnboardingStep, ...OnboardingStep[]]),
  status: z.enum([VALID_STATUSES[0], ...VALID_STATUSES.slice(1)] as [
    OnboardingStepStatus,
    ...OnboardingStepStatus[],
  ]),
  data: z.record(z.string(), z.unknown()).optional(),
});

export async function GET() {
  try {
    const admin = await requireRole(["admin"]);
    const result = await loadOnboardingProgress(admin.tenantId);
    if (!result) throw new HttpError(404, "Workspace not found");

    return NextResponse.json({
      progress: result.progress,
      startedAt: result.startedAt?.toISOString() ?? null,
      skippedAt: result.skippedAt?.toISOString() ?? null,
      completedAt: result.completedAt?.toISOString() ?? null,
      resumeStep: result.resumeStep,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireRole(["admin"]);
    const body = patchSchema.parse(await req.json());

    // Reject step strings we don't know about (defense-in-depth — zod
    // already enforces this).
    if (!VALID_STEPS.includes(body.step)) {
      throw new HttpError(400, "Unknown step");
    }

    if (body.status === "in_progress") {
      const next = await markStepViewed(admin.tenantId, body.step);
      void recordOnboardingEvent({
        tenantId: admin.tenantId,
        actorUserId: admin.id,
        action: ONBOARDING_EVENTS.stepViewed,
        step: body.step,
      });
      return NextResponse.json({ ok: true, progress: next });
    }

    const next = await markStep(admin.tenantId, body.step, body.status, body.data);

    void recordOnboardingEvent({
      tenantId: admin.tenantId,
      actorUserId: admin.id,
      action:
        body.status === "skipped"
          ? ONBOARDING_EVENTS.stepSkipped
          : body.status === "complete"
            ? ONBOARDING_EVENTS.stepCompleted
            : ONBOARDING_EVENTS.stepViewed,
      step: body.step,
    });

    return NextResponse.json({ ok: true, progress: next });
  } catch (err) {
    return errorResponse(err);
  }
}
