/**
 * Onboarding telemetry — wraps the existing fire-and-forget `audit()`
 * helper with a strict event vocabulary.
 *
 * Why piggyback on `audit_logs`:
 *   • Single retention/governance policy applies to every audit row;
 *     onboarding events get the same treatment for free.
 *   • Cross-action queries ("which step do users bail on most?") become
 *     a simple `WHERE action LIKE 'onboarding.%'` against an already-
 *     indexed table.
 *   • The audit helper never throws — onboarding writes can't be broken
 *     by telemetry failures.
 *
 * Why NOT a dedicated table:
 *   • A separate table would need its own retention, its own indexes,
 *     its own backfill, its own admin UI. For a feature that emits
 *     ~10 events per tenant per onboarding lifetime, that's overkill.
 *
 * This module is intentionally tiny — it exists so callers don't have
 * to remember the event vocabulary or spell `onboarding.step.completed`
 * by hand.
 */
import { audit } from "@/lib/audit";

import type { OnboardingEventAction, OnboardingStep } from "./types";

export type RecordOnboardingEventArgs = {
  tenantId: string;
  action: OnboardingEventAction;
  actorUserId?: string | null;
  actorLabel?: string;
  step?: OnboardingStep;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
};

export async function recordOnboardingEvent(args: RecordOnboardingEventArgs): Promise<void> {
  await audit({
    tenantId: args.tenantId,
    actorUserId: args.actorUserId ?? null,
    actorLabel: args.actorLabel,
    action: args.action,
    entityType: "onboarding",
    metadata: {
      ...(args.step ? { step: args.step } : {}),
      ...(args.metadata ?? {}),
    },
    ipAddress: args.ipAddress ?? null,
  });
}
