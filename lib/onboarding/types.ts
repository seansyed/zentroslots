/**
 * Onboarding state taxonomy — shared by the lib/, API, and UI layers.
 *
 * This file is the *only* place that knows the shape of
 * `tenants.onboarding_progress`. Everything else imports from here.
 *
 * Why JSONB instead of a relational onboarding_steps table:
 *   • The wizard step set evolves frequently; a column-per-step or
 *     row-per-step model would generate constant migrations.
 *   • Per-step state is never joined or aggregated across tenants — it
 *     only ever reads back into the same tenant's wizard.
 *   • JSONB keeps the surface area small and avoids cross-table fk
 *     churn during the planned UX redesign that will follow this phase.
 *
 * If we ever need cross-tenant analytics (e.g. "what step do users bail
 * on most"), telemetry already flows into `audit_logs` with a stable
 * action vocabulary — querying THAT is the right path, not querying
 * the progress jsonb.
 */

// The closed-union of every step the wizard can be on. KEEP IN SYNC with
// the STEPS array in components/OnboardingWizard.tsx — if you add a step
// here, the wizard component will fail typecheck until it's added there
// too (the discriminant is intentional).
export const ONBOARDING_STEPS = [
  "industry",
  "service",
  "hours",
  "google",
  "done",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export type OnboardingStepStatus =
  | "pending"     // never touched
  | "in_progress" // viewed but not finished
  | "complete"    // finished successfully
  | "skipped";    // explicitly skipped by user

export type OnboardingStepState = {
  status: OnboardingStepStatus;
  /** Last update timestamp, ISO. */
  at?: string;
  /** Optional per-step blob the wizard might want to round-trip. */
  data?: Record<string, unknown>;
};

export type OnboardingTelemetry = {
  /** ms spent per step (set on completion). */
  stepDurations?: Partial<Record<OnboardingStep, number>>;
  /** Last step the user was on when they abandoned (if they did). */
  abandonmentPoint?: OnboardingStep;
  /** Total ms from first step seen to terminal state. */
  totalTimeMs?: number;
};

export type OnboardingProgress = {
  /** Wizard step the user is currently on; resume target on reload. */
  currentStep?: OnboardingStep;
  /** Per-step state map. Missing keys are treated as `pending`. */
  steps?: Partial<Record<OnboardingStep, OnboardingStepState>>;
  /** If a template was applied, its id is recorded here for idempotency. */
  templateApplied?: string | null;
  /** Optional ISO of the first time the wizard recorded ANY state. */
  firstSeenAt?: string;
  /** Telemetry bag (kept here so we can render time-to-complete later). */
  telemetry?: OnboardingTelemetry;
};

/** Safe accessor — `tenants.onboarding_progress` may be `{}` from migration. */
export function readProgress(raw: unknown): OnboardingProgress {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as OnboardingProgress;
  }
  return {};
}

/** Returns the step a freshly-loaded wizard should resume at. */
export function resolveResumeStep(progress: OnboardingProgress): OnboardingStep {
  // Honor an explicit currentStep if it's still a known step.
  if (
    progress.currentStep &&
    (ONBOARDING_STEPS as readonly string[]).includes(progress.currentStep)
  ) {
    return progress.currentStep;
  }
  // Otherwise, scan forward and stop at the first non-complete step.
  for (const step of ONBOARDING_STEPS) {
    const state = progress.steps?.[step];
    if (!state || (state.status !== "complete" && state.status !== "skipped")) {
      return step;
    }
  }
  return "done";
}

/** Percentage of finishable steps (complete + skipped) over all non-terminal. */
export function computeProgressPercent(progress: OnboardingProgress): number {
  // "done" is the terminal acknowledgment step, not a unit of work — exclude
  // it from the denominator so the bar reads 100% the moment the last real
  // step is finished.
  const workSteps = ONBOARDING_STEPS.filter((s) => s !== "done");
  if (workSteps.length === 0) return 0;
  const done = workSteps.filter((s) => {
    const st = progress.steps?.[s]?.status;
    return st === "complete" || st === "skipped";
  }).length;
  return Math.round((done / workSteps.length) * 100);
}

/** Telemetry action vocabulary — single source of truth, audited. */
export const ONBOARDING_EVENTS = {
  started: "onboarding.started",
  stepViewed: "onboarding.step.viewed",
  stepCompleted: "onboarding.step.completed",
  stepSkipped: "onboarding.step.skipped",
  templateApplied: "onboarding.template.applied",
  templateRepeated: "onboarding.template.repeated", // idempotent re-apply
  skipped: "onboarding.skipped",
  resumed: "onboarding.resumed",
  completed: "onboarding.completed",
  integrityBlocked: "onboarding.integrity.blocked",
} as const;

export type OnboardingEventAction =
  (typeof ONBOARDING_EVENTS)[keyof typeof ONBOARDING_EVENTS];
