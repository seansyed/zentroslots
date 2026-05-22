/**
 * Downgrade action executor.
 *
 * Takes a `DowngradePlan` from the planner and applies each action
 * idempotently. Default is DRY-RUN — operators must explicitly arm
 * the executor to mutate.
 *
 * Idempotency contract:
 *   Every handler marks the rows it touches with `enforcement_event_id`
 *   set to the plan's `eventId`. Re-running with the same eventId on
 *   the same set of rows is a no-op (the WHERE clause filters out
 *   rows already marked with this id).
 *
 *   Cross-event re-runs DO re-mark rows — e.g., a tenant downgraded
 *   twice (once by webhook, once manually by an admin) would have
 *   their series re-paused with the most recent eventId. The
 *   `enforcement_paused_at` timestamp is preserved on the first
 *   pause; subsequent re-pauses are no-ops because the
 *   `IS NULL` predicate filters them out.
 *
 * Failure isolation:
 *   Each action is wrapped in its own try/catch. One feature failing
 *   does NOT abort the rest of the plan. The result envelope records
 *   per-action status so the caller can see partial failures.
 *
 * Audit emission:
 *   For each non-noop action, emits `billing.enforcement_action_applied`
 *   with the affected count and entity ids (truncated to 10 for log
 *   sanity). Failures emit `billing.enforcement_action_failed`.
 *
 *   The orchestrator does NOT call this from the Stripe webhook in
 *   this commit. Auto-firing is a separate operator decision; today
 *   the executor only runs from admin scripts.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import { db as defaultDb } from "@/db/client";
import { bookingSeries } from "@/db/schema";
import { audit } from "@/lib/audit";

import type {
  ActionResult,
  ActionStatus,
  DowngradeAction,
  DowngradePlan,
  ExecutionResult,
} from "./types";

export type ExecutorOptions = {
  /** When true (default) handlers DO NOT mutate. They return what
   *  they WOULD do. Audit emission still happens with `dryRun=true`
   *  metadata so the dry-run leaves a trail. */
  dryRun?: boolean;
  /** Optional db override for tests. */
  db?: typeof defaultDb;
  /** Optional actor label for the audit log ("system:cron:apply-downgrade",
   *  "admin:user_id_xyz"). Defaults to "system:enforcement". */
  actorLabel?: string;
};

export async function executeDowngradePlan(
  plan: DowngradePlan,
  opts: ExecutorOptions = {},
): Promise<ExecutionResult> {
  const { dryRun = true, db = defaultDb, actorLabel = "system:enforcement" } = opts;

  const results: ActionResult[] = [];

  for (const action of plan.actions) {
    let result: ActionResult;
    try {
      result = await dispatch(action, { dryRun, db, plan, actorLabel });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[enforcement] action ${action.kind} for ${plan.tenantId} crashed:`, err);
      result = {
        kind: action.kind,
        capability: action.capability,
        status: "failed",
        affected: 0,
        error: errMsg,
      };
      // Audit the failure best-effort — never let audit emission throw.
      try {
        await audit({
          tenantId: plan.tenantId,
          action: "billing.enforcement_action_failed",
          actorLabel,
          entityType: "billing",
          entityId: plan.eventId,
          metadata: {
            kind: action.kind,
            capability: action.capability,
            mode: action.mode,
            event_id: plan.eventId,
            from_plan: plan.fromPlan,
            to_plan: plan.toPlan,
            error: errMsg,
          },
        });
      } catch (auditErr) {
        console.warn("[enforcement] failure audit emission also failed:", auditErr);
      }
    }
    results.push(result);
  }

  const ok = results.every((r) => r.status !== "failed");
  return { tenantId: plan.tenantId, eventId: plan.eventId, dryRun, results, ok };
}

// ─── Dispatcher ───────────────────────────────────────────────────────

type DispatchCtx = {
  dryRun: boolean;
  db: typeof defaultDb;
  plan: DowngradePlan;
  actorLabel: string;
};

async function dispatch(
  action: DowngradeAction,
  ctx: DispatchCtx,
): Promise<ActionResult> {
  switch (action.kind) {
    case "pause_recurring_series":
      return handlePauseRecurringSeries(action, ctx);

    // Planned-only — these handlers are stubs awaiting their migrations.
    // They emit `not_implemented` so the executor is honest about what
    // did NOT happen, and the audit trail records the intent.
    case "disable_automation_rules":
    case "disable_routing_rules_premium_modes":
    case "deactivate_custom_domains":
    case "freeze_excess_locations":
    case "freeze_excess_services":
    case "freeze_excess_staff_seats":
    case "lock_analytics_export":
      return emitNotImplemented(action, ctx);
  }
}

// ─── Handler: pause_recurring_series (worked example) ────────────────

async function handlePauseRecurringSeries(
  action: DowngradeAction,
  ctx: DispatchCtx,
): Promise<ActionResult> {
  if (action.entityIds.length === 0) {
    // Either grandfathered (no-op by design) or just no active series.
    await emitAuditIfApplicable(action, ctx, {
      status: ctx.dryRun ? "skipped_dry_run" : "skipped_idempotent",
      affected: 0,
    });
    return {
      kind: action.kind,
      capability: action.capability,
      status: ctx.dryRun ? "skipped_dry_run" : "skipped_idempotent",
      affected: 0,
    };
  }

  if (ctx.dryRun) {
    await emitAuditIfApplicable(action, ctx, {
      status: "skipped_dry_run",
      affected: action.entityIds.length,
    });
    return {
      kind: action.kind,
      capability: action.capability,
      status: "skipped_dry_run",
      affected: action.entityIds.length,
    };
  }

  // Idempotent mutation:
  //   - Only UPDATE rows still ACTIVE and not already paused.
  //   - Restrict to the planned entityIds — guards against the planner
  //     and executor seeing different snapshots (someone might have
  //     added or removed a series between plan + execute).
  //   - Re-running with same eventId is a no-op because the
  //     IS NULL predicate filters out rows we already marked.
  const updated = await ctx.db
    .update(bookingSeries)
    .set({
      enforcementPausedAt: new Date(),
      enforcementPausedReason: deriveReason(ctx.plan),
      enforcementEventId: ctx.plan.eventId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(bookingSeries.tenantId, ctx.plan.tenantId),
        inArray(bookingSeries.id, action.entityIds),
        eq(bookingSeries.status, "active"),
        isNull(bookingSeries.enforcementPausedAt),
      ),
    )
    .returning({ id: bookingSeries.id });

  const affected = updated.length;
  const status: ActionStatus = affected > 0 ? "applied" : "skipped_idempotent";

  await emitAuditIfApplicable(action, ctx, { status, affected });

  return {
    kind: action.kind,
    capability: action.capability,
    status,
    affected,
  };
}

// ─── Stub handler: not implemented ────────────────────────────────────

async function emitNotImplemented(
  action: DowngradeAction,
  ctx: DispatchCtx,
): Promise<ActionResult> {
  await emitAuditIfApplicable(action, ctx, {
    status: "not_implemented",
    affected: 0,
  });
  return {
    kind: action.kind,
    capability: action.capability,
    status: "not_implemented",
    affected: 0,
  };
}

// ─── Audit emission helper ────────────────────────────────────────────

async function emitAuditIfApplicable(
  action: DowngradeAction,
  ctx: DispatchCtx,
  outcome: { status: ActionStatus; affected: number },
): Promise<void> {
  try {
    await audit({
      tenantId: ctx.plan.tenantId,
      action: "billing.enforcement_action_applied",
      actorLabel: ctx.actorLabel,
      entityType: "billing",
      entityId: ctx.plan.eventId,
      metadata: {
        kind: action.kind,
        capability: action.capability,
        mode: action.mode,
        event_id: ctx.plan.eventId,
        from_plan: ctx.plan.fromPlan,
        to_plan: ctx.plan.toPlan,
        dry_run: ctx.dryRun,
        status: outcome.status,
        affected: outcome.affected,
        // Cap the id list at 10 so audit_logs metadata stays small.
        // Operators can grep for the eventId to find the full list
        // on the touched feature tables.
        sample_entity_ids: action.entityIds.slice(0, 10),
        total_planned_entity_ids: action.entityIds.length,
      },
    });
  } catch (e) {
    // Audit failure NEVER fails the executor.
    console.warn("[enforcement] action audit emission failed:", e);
  }
}

function deriveReason(plan: DowngradePlan): string {
  // 60-char varchar; closed-set string for downstream grep.
  // Format: `downgrade_<from>_to_<to>` — operators can grep by
  // either side.
  return `downgrade_${plan.fromPlan}_to_${plan.toPlan}`.slice(0, 60);
}
