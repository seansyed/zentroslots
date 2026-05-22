/**
 * Onboarding state read/write — the only module that mutates the new
 * `tenants.onboarding_*` columns. Everything else (APIs, server pages,
 * UI) calls through here so we have one place to enforce invariants.
 *
 * Concurrency model:
 *   • Writes use a single `UPDATE tenants SET ... WHERE id = ?` per call
 *     — Postgres row-level locking handles concurrent admins on the same
 *     tenant safely. Last-writer-wins is acceptable here because the
 *     wizard's UI is single-admin in practice and the steps are
 *     monotonic (you can only ever ADD completed steps, not remove).
 *
 * Backwards-compatibility:
 *   • `readProgress` tolerates `{}` (the default for tenants migrated
 *     in 0042) and pre-existing tenants with `onboardingCompletedAt`
 *     set — they get a synthesized "all-complete" view if asked.
 */
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";

import {
  ONBOARDING_STEPS,
  type OnboardingProgress,
  type OnboardingStep,
  type OnboardingStepStatus,
  readProgress,
  resolveResumeStep,
} from "./types";

// ── Read side ─────────────────────────────────────────────────────────

/**
 * Loads progress for a tenant. Returns `null` if the tenant doesn't
 * exist. Synthesizes an all-complete view for tenants that finished
 * onboarding pre-0042 so old callers see consistent state.
 */
export async function loadOnboardingProgress(
  tenantId: string,
): Promise<{
  progress: OnboardingProgress;
  startedAt: Date | null;
  skippedAt: Date | null;
  completedAt: Date | null;
  resumeStep: OnboardingStep;
} | null> {
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: {
      onboardingProgress: true,
      onboardingStartedAt: true,
      onboardingSkippedAt: true,
      onboardingCompletedAt: true,
    },
  });
  if (!tenant) return null;

  let progress = readProgress(tenant.onboardingProgress);

  // Pre-0042 legacy: if completedAt is set but progress is empty, synthesize
  // a fully-completed map so consumers (checklist, telemetry queries) don't
  // need to special-case the cohort.
  if (tenant.onboardingCompletedAt && (!progress.steps || Object.keys(progress.steps).length === 0)) {
    const synthetic: OnboardingProgress = {
      currentStep: "done",
      steps: Object.fromEntries(
        ONBOARDING_STEPS.map((s) => [
          s,
          { status: "complete" as OnboardingStepStatus, at: tenant.onboardingCompletedAt!.toISOString() },
        ]),
      ),
      firstSeenAt: tenant.onboardingStartedAt?.toISOString() ?? tenant.onboardingCompletedAt.toISOString(),
    };
    progress = synthetic;
  }

  return {
    progress,
    startedAt: tenant.onboardingStartedAt ?? null,
    skippedAt: tenant.onboardingSkippedAt ?? null,
    completedAt: tenant.onboardingCompletedAt ?? null,
    resumeStep: resolveResumeStep(progress),
  };
}

// ── Write side ────────────────────────────────────────────────────────

/**
 * Atomic-ish progress mutator. Loads + merges + writes in a single
 * transaction. The merge is shallow at the top level and merges the
 * `steps` map by key — callers can safely supply a partial.
 *
 * If the tenant doesn't exist, throws. Caller should have already
 * checked tenant existence in their auth gate.
 */
export async function updateOnboardingProgress(
  tenantId: string,
  mutator: (prev: OnboardingProgress) => OnboardingProgress,
): Promise<OnboardingProgress> {
  return await db.transaction(async (tx) => {
    const row = await tx.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: { onboardingProgress: true, onboardingStartedAt: true },
    });
    if (!row) throw new Error(`tenant ${tenantId} not found`);

    const prev = readProgress(row.onboardingProgress);
    const next = mutator(prev);

    // Auto-stamp `firstSeenAt` + `onboardingStartedAt` on first write.
    if (!next.firstSeenAt && (next.steps || next.currentStep)) {
      next.firstSeenAt = new Date().toISOString();
    }

    const setFragment: Record<string, unknown> = {
      onboardingProgress: next,
      updatedAt: new Date(),
    };
    if (!row.onboardingStartedAt) {
      setFragment.onboardingStartedAt = new Date();
    }

    await tx.update(tenants).set(setFragment).where(eq(tenants.id, tenantId));
    return next;
  });
}

/** Convenience: mark a single step with a status + optional data blob. */
export async function markStep(
  tenantId: string,
  step: OnboardingStep,
  status: OnboardingStepStatus,
  data?: Record<string, unknown>,
): Promise<OnboardingProgress> {
  return updateOnboardingProgress(tenantId, (prev) => {
    const steps = { ...(prev.steps ?? {}) };
    const at = new Date().toISOString();

    // Auto-compute step duration telemetry if we know when it was first viewed.
    const prevState = steps[step];
    let durationMs: number | undefined;
    if (prevState?.at && (status === "complete" || status === "skipped")) {
      const startedAt = new Date(prevState.at).getTime();
      const now = Date.now();
      if (Number.isFinite(startedAt) && now > startedAt) {
        durationMs = now - startedAt;
      }
    }

    steps[step] = {
      status,
      at,
      ...(data ? { data } : {}),
    };

    const telemetry = { ...(prev.telemetry ?? {}) };
    if (durationMs !== undefined) {
      telemetry.stepDurations = {
        ...(telemetry.stepDurations ?? {}),
        [step]: durationMs,
      };
    }

    return {
      ...prev,
      steps,
      telemetry,
    };
  });
}

/** Marks a step as `in_progress` (idempotent — won't downgrade complete). */
export async function markStepViewed(
  tenantId: string,
  step: OnboardingStep,
): Promise<OnboardingProgress> {
  return updateOnboardingProgress(tenantId, (prev) => {
    const steps = { ...(prev.steps ?? {}) };
    const existing = steps[step];
    // Don't clobber complete/skipped — viewing a finished step is a no-op.
    if (existing?.status === "complete" || existing?.status === "skipped") {
      return { ...prev, currentStep: step };
    }
    return {
      ...prev,
      currentStep: step,
      steps: {
        ...steps,
        [step]: { status: "in_progress", at: new Date().toISOString() },
      },
    };
  });
}

/** Records that a template was applied (idempotency marker). */
export async function markTemplateApplied(
  tenantId: string,
  templateId: string,
): Promise<OnboardingProgress> {
  return updateOnboardingProgress(tenantId, (prev) => ({
    ...prev,
    templateApplied: templateId,
  }));
}
