/**
 * Phase Onboarding-UX — pure plan-aware completion math.
 *
 * Given the dashboard checklist items + the tenant's plan, returns:
 *   • required[]    tasks that count toward "Workspace setup complete"
 *   • premium[]     tasks gated by a higher plan; surfaced as
 *                   "Unlock more" cards with an upgrade CTA. NEVER
 *                   counted against completion.
 *   • requiredDone  how many required tasks are done
 *   • requiredTotal how many required tasks exist
 *   • isReady       true iff requiredDone === requiredTotal (and > 0)
 *   • pct           round(100 * requiredDone / requiredTotal)
 *
 * Pure function — no DB, no Date.now, no Math.random. Same inputs
 * always produce same outputs.
 *
 * Plan-awareness contract: a task with no `requiredCapability` is
 * required for every tenant. A task with a `requiredCapability` is
 * required only if the tenant's plan has that capability (per
 * lib/plans.hasCapability); otherwise it goes to `premium[]`.
 */

import {
  hasCapability,
  type Plan,
  type PlanCapability,
} from "@/lib/plans";

/** The minimal task shape the math operates on. Components extend
 *  this with `label`, `href`, `done`, icons, etc. */
export type ChecklistTaskInput = {
  id: string;
  done: boolean;
  /** When set, the task is REQUIRED only when the plan has this
   *  capability. When unset, the task is required for every plan. */
  requiredCapability?: PlanCapability;
};

export type CompletionPartitioned<T extends ChecklistTaskInput> = {
  required: T[];
  premium: T[];
  requiredDone: number;
  requiredTotal: number;
  /** True when every required task is done AND there is at least
   *  one required task. The minimum-1 guard prevents an "empty
   *  checklist passes as complete" edge case if a future plan
   *  somehow has zero required tasks. */
  isReady: boolean;
  /** Percentage 0..100 computed against REQUIRED tasks only. */
  pct: number;
};

export function partitionByPlan<T extends ChecklistTaskInput>(
  tasks: readonly T[],
  plan: Plan,
): CompletionPartitioned<T> {
  const required: T[] = [];
  const premium: T[] = [];

  for (const t of tasks) {
    if (!t.requiredCapability) {
      // No capability gate → required for every plan.
      required.push(t);
      continue;
    }
    // Capability gate → required only when the plan has it.
    if (hasCapability(plan, t.requiredCapability)) {
      required.push(t);
    } else {
      premium.push(t);
    }
  }

  const requiredDone = required.filter((t) => t.done).length;
  const requiredTotal = required.length;
  const isReady = requiredTotal > 0 && requiredDone === requiredTotal;
  const pct =
    requiredTotal === 0 ? 0 : Math.round((requiredDone / requiredTotal) * 100);

  return {
    required,
    premium,
    requiredDone,
    requiredTotal,
    isReady,
    pct,
  };
}
