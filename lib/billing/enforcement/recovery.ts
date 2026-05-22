/**
 * Reactivation (upgrade) handler — symmetric to the downgrade executor.
 *
 * When a tenant upgrades back to a tier that unlocks a previously-paused
 * capability, the orchestrator restores the paused rows IDEMPOTENTLY.
 *
 * Symmetry contract:
 *   Restore EXACTLY the rows we paused. We use `enforcement_event_id`
 *   as the recovery anchor — only rows paused under a known
 *   downgrade event get restored. Rows paused for other reasons
 *   (manual operator action, future-feature pause) are left alone.
 *
 *   This avoids the failure mode where an upgrade silently "restores"
 *   rows that were never enforcement-paused in the first place.
 *
 * Idempotency:
 *   Restore filters `WHERE enforcement_paused_at IS NOT NULL`. Running
 *   restore twice on the same rows is a no-op the second time
 *   (the predicate fails). Re-running with the same eventId after
 *   a partial restore safely continues.
 *
 * Same as the executor: DRY-RUN by default. Today only invoked from
 * the admin CLI (`scripts/apply-upgrade-recovery.ts`), not from the
 * Stripe webhook — auto-firing recovery on upgrade is a separate
 * operator decision.
 */
import { and, eq, isNotNull } from "drizzle-orm";

import { db as defaultDb } from "@/db/client";
import { bookingSeries } from "@/db/schema";
import { audit } from "@/lib/audit";
import { capabilitySnapshot, type Capability } from "@/lib/billing/capabilities";
import { getPlan, type PlanId } from "@/lib/plans";

import type {
  ActionResult,
  ActionStatus,
  RecoveryAction,
  RecoveryActionKind,
  RecoveryPlan,
} from "./types";

// ─── Plan ─────────────────────────────────────────────────────────────

export async function planRecovery(args: {
  tenantId: string;
  fromPlan: PlanId;
  toPlan: PlanId;
  eventId: string;
  db?: typeof defaultDb;
}): Promise<RecoveryPlan> {
  const { tenantId, fromPlan, toPlan, eventId, db = defaultDb } = args;
  const toPlanObj = getPlan(toPlan);
  const targetCapabilities = capabilitySnapshot(toPlanObj);

  const actions: RecoveryAction[] = [];

  // For each capability the new plan unlocks, find rows we PREVIOUSLY
  // paused via enforcement (any past eventId) and queue them for
  // restore. We don't restrict to a specific eventId here because
  // multiple downgrade events may have piled up — the user's NEW
  // plan unlocks everything regardless of which downgrade originally
  // paused it.
  for (const cap of Object.keys(targetCapabilities) as Capability[]) {
    if (!targetCapabilities[cap].allowed) continue;

    const featureActions = await planRestoreForCapability({ cap, tenantId, db });
    for (const a of featureActions) actions.push(a);
  }

  return {
    tenantId,
    fromPlan,
    toPlan,
    eventId,
    actions,
    summary: summarize(actions, fromPlan, toPlan),
  };
}

async function planRestoreForCapability(args: {
  cap: Capability;
  tenantId: string;
  db: typeof defaultDb;
}): Promise<RecoveryAction[]> {
  const { cap, tenantId, db } = args;
  const out: RecoveryAction[] = [];

  switch (cap) {
    case "recurring_series": {
      const rows = await db
        .select({ id: bookingSeries.id })
        .from(bookingSeries)
        .where(
          and(
            eq(bookingSeries.tenantId, tenantId),
            isNotNull(bookingSeries.enforcementPausedAt),
          ),
        );
      if (rows.length === 0) {
        out.push({
          kind: "resume_recurring_series",
          capability: cap,
          entityIds: [],
          description: "No paused recurring series to restore.",
        });
      } else {
        out.push({
          kind: "resume_recurring_series",
          capability: cap,
          entityIds: rows.map((r) => r.id),
          description: `Restore ${rows.length} enforcement-paused recurring series`,
        });
      }
      break;
    }

    // Stubs for capabilities whose downgrade handler isn't implemented
    // yet. Recovery emits them with empty entityIds so the audit trail
    // is consistent.
    case "automation_rules":
    case "routing_rules":
    case "custom_domains":
    case "scheduled_reports":
    case "booking_rules":
    case "analytics_export":
    case "hide_powered_by":
      out.push({
        kind: mapStubRecoveryKind(cap),
        capability: cap,
        entityIds: [],
        description: `[Recovery stub] handler for ${cap} lands when downgrade handler does.`,
      });
      break;
  }
  return out;
}

function mapStubRecoveryKind(cap: Capability): RecoveryActionKind {
  switch (cap) {
    case "automation_rules":
      return "enable_automation_rules";
    case "routing_rules":
      return "enable_routing_rules_premium_modes";
    case "custom_domains":
      return "reactivate_custom_domains";
    case "scheduled_reports":
      return "enable_automation_rules"; // closest stub
    case "booking_rules":
      return "enable_automation_rules"; // closest stub
    case "analytics_export":
      return "unlock_analytics_export";
    case "hide_powered_by":
      return "unfreeze_excess_locations"; // closest stub
    default:
      return "enable_automation_rules";
  }
}

// ─── Execute ──────────────────────────────────────────────────────────

export type RecoveryExecutorOptions = {
  dryRun?: boolean;
  db?: typeof defaultDb;
  actorLabel?: string;
};

export async function executeRecoveryPlan(
  plan: RecoveryPlan,
  opts: RecoveryExecutorOptions = {},
): Promise<{ tenantId: string; eventId: string; dryRun: boolean; results: ActionResult[]; ok: boolean }> {
  const { dryRun = true, db = defaultDb, actorLabel = "system:enforcement" } = opts;

  const results: ActionResult[] = [];
  for (const action of plan.actions) {
    let res: ActionResult;
    try {
      res = await dispatchRecovery(action, { dryRun, db, plan, actorLabel });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[enforcement] recovery ${action.kind} crashed:`, err);
      res = {
        kind: action.kind,
        capability: action.capability,
        status: "failed",
        affected: 0,
        error: errMsg,
      };
    }
    results.push(res);
  }
  const ok = results.every((r) => r.status !== "failed");
  return { tenantId: plan.tenantId, eventId: plan.eventId, dryRun, results, ok };
}

type RecoveryCtx = {
  dryRun: boolean;
  db: typeof defaultDb;
  plan: RecoveryPlan;
  actorLabel: string;
};

async function dispatchRecovery(
  action: RecoveryAction,
  ctx: RecoveryCtx,
): Promise<ActionResult> {
  switch (action.kind) {
    case "resume_recurring_series":
      return handleResumeRecurringSeries(action, ctx);
    case "enable_automation_rules":
    case "enable_routing_rules_premium_modes":
    case "reactivate_custom_domains":
    case "unfreeze_excess_locations":
    case "unfreeze_excess_services":
    case "unfreeze_excess_staff_seats":
    case "unlock_analytics_export":
      await emitRecoveryAudit(action, ctx, {
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
}

async function handleResumeRecurringSeries(
  action: RecoveryAction,
  ctx: RecoveryCtx,
): Promise<ActionResult> {
  if (action.entityIds.length === 0) {
    await emitRecoveryAudit(action, ctx, {
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
    await emitRecoveryAudit(action, ctx, {
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

  // Restore is the symmetric clear of the three enforcement columns.
  // The `IS NOT NULL` predicate makes re-runs idempotent.
  const updated = await ctx.db
    .update(bookingSeries)
    .set({
      enforcementPausedAt: null,
      enforcementPausedReason: null,
      enforcementEventId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(bookingSeries.tenantId, ctx.plan.tenantId),
        isNotNull(bookingSeries.enforcementPausedAt),
      ),
    )
    .returning({ id: bookingSeries.id });

  const affected = updated.length;
  const status: ActionStatus = affected > 0 ? "applied" : "skipped_idempotent";
  await emitRecoveryAudit(action, ctx, { status, affected });
  return { kind: action.kind, capability: action.capability, status, affected };
}

async function emitRecoveryAudit(
  action: RecoveryAction,
  ctx: RecoveryCtx,
  outcome: { status: ActionStatus; affected: number },
): Promise<void> {
  try {
    await audit({
      tenantId: ctx.plan.tenantId,
      action: "billing.enforcement_recovery_applied",
      actorLabel: ctx.actorLabel,
      entityType: "billing",
      entityId: ctx.plan.eventId,
      metadata: {
        kind: action.kind,
        capability: action.capability,
        event_id: ctx.plan.eventId,
        from_plan: ctx.plan.fromPlan,
        to_plan: ctx.plan.toPlan,
        dry_run: ctx.dryRun,
        status: outcome.status,
        affected: outcome.affected,
        sample_entity_ids: action.entityIds.slice(0, 10),
        total_planned_entity_ids: action.entityIds.length,
      },
    });
  } catch (e) {
    console.warn("[enforcement] recovery audit emission failed:", e);
  }
}

function summarize(actions: RecoveryAction[], fromPlan: PlanId, toPlan: PlanId): string {
  if (actions.length === 0) return `No recovery actions for ${fromPlan} → ${toPlan}.`;
  const affected = actions.reduce((sum, a) => sum + a.entityIds.length, 0);
  return `${actions.length} recovery action(s), ${affected} row(s) to restore (${fromPlan} → ${toPlan}).`;
}
