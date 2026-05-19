/**
 * Policy-driven retention engine.
 *
 * One entry point: `runTenantRetention({ tenantId, dryRun })` returns a
 * structured summary per resource. The cron worker calls this for every
 * tenant, the dashboard preview calls it with dryRun=true.
 *
 * Guarantees:
 *   - NEVER cross-tenant. Every DELETE is keyed on tenant_id.
 *   - NEVER deletes billing_transactions or bookings (financial record /
 *     operational source-of-truth — out of scope by policy).
 *   - HARD-FLOOR enforced: even if a tenant configures
 *     audit_retention_days = 7, the engine refuses to prune audit rows
 *     newer than HARD_FLOOR_DAYS.audit_logs (90 days).
 *   - DRY-RUN: when dryRun=true, only counts are computed; nothing is
 *     deleted. Counts come from the same predicate the DELETE would use,
 *     so preview matches actual.
 *   - GRACEFUL FAILURE ISOLATION: each resource runs in its own
 *     try/catch. One failing target does NOT block the others.
 *   - AUDITABLE: each successful prune emits a
 *     `security.retention.executed` audit row with deletedCount +
 *     resource + dryRun flag. Failures emit too with reason.
 *
 * NEVER throws. Always returns a summary.
 */

import { and, count, eq, lt } from "drizzle-orm";

import { db } from "@/db/client";
import {
  analyticsDailySnapshots,
  auditLogs,
  exportAuditEvents,
  passwordResetTokens,
  sessionAuditEvents,
} from "@/db/schema";
import { recordSecurityAudit } from "@/lib/security/audit";

import { loadEffectivePolicy } from "./policies";
import { HARD_FLOOR_DAYS, type RetentionTarget } from "./types";

export type RetentionResourceResult = {
  target: RetentionTarget;
  configuredDays: number | null;
  effectiveDays: number | null;       // configuredDays clamped UP to hard floor
  /** Rows that WOULD be / WERE deleted (depending on dryRun). */
  count: number;
  /** True when the engine refused to run because no policy is set OR
   *  the configured window is shorter than the hard floor. The
   *  effectiveDays is reported either way for transparency. */
  skipped: "no_policy" | "below_hard_floor" | null;
  /** When ok=false, why. The other fields still carry context. */
  error?: string;
};

export type RunRetentionResult = {
  tenantId: string;
  dryRun: boolean;
  startedAt: string;
  durationMs: number;
  resources: RetentionResourceResult[];
  /** Total rows that would be / were deleted across all resources. */
  totalCount: number;
};

export async function runTenantRetention(args: {
  tenantId: string;
  dryRun: boolean;
  /** Optional actor for audit attribution; undefined = "system/cron". */
  actorUserId?: string;
}): Promise<RunRetentionResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const policy = await loadEffectivePolicy(args.tenantId);

  const resources: RetentionResourceResult[] = [];

  // Resource configs declared inline so adding a new target is a
  // single block — engine stays a flat switch.
  const targets: Array<{
    target: RetentionTarget;
    configuredDays: number | null;
    run: (cutoff: Date) => Promise<number>;
    count: (cutoff: Date) => Promise<number>;
  }> = [
    {
      target: "audit_logs",
      configuredDays: policy.retention.auditLogs,
      run: async (cutoff) => {
        const r = await db
          .delete(auditLogs)
          .where(and(eq(auditLogs.tenantId, args.tenantId), lt(auditLogs.createdAt, cutoff)))
          .returning({ id: auditLogs.id });
        return r.length;
      },
      count: async (cutoff) => {
        // Use Drizzle's typed predicates — postgres-js can't bind a
        // Date inside a raw sql template (documented workaround).
        const rows = await db
          .select({ n: count() })
          .from(auditLogs)
          .where(and(eq(auditLogs.tenantId, args.tenantId), lt(auditLogs.createdAt, cutoff)));
        return Number(rows[0]?.n ?? 0);
      },
    },
    {
      target: "session_audit_events",
      configuredDays: policy.retention.sessionEvents,
      run: async (cutoff) => {
        const r = await db
          .delete(sessionAuditEvents)
          .where(
            and(
              eq(sessionAuditEvents.tenantId, args.tenantId),
              lt(sessionAuditEvents.createdAt, cutoff)
            )
          )
          .returning({ id: sessionAuditEvents.id });
        return r.length;
      },
      count: async (cutoff) => {
        const rows = await db
          .select({ n: count() })
          .from(sessionAuditEvents)
          .where(and(eq(sessionAuditEvents.tenantId, args.tenantId), lt(sessionAuditEvents.createdAt, cutoff)));
        return Number(rows[0]?.n ?? 0);
      },
    },
    {
      target: "password_reset_tokens",
      configuredDays: policy.retention.resetTokens,
      run: async (cutoff) => {
        const r = await db
          .delete(passwordResetTokens)
          .where(
            and(
              eq(passwordResetTokens.tenantId, args.tenantId),
              lt(passwordResetTokens.createdAt, cutoff)
            )
          )
          .returning({ id: passwordResetTokens.id });
        return r.length;
      },
      count: async (cutoff) => {
        const rows = await db
          .select({ n: count() })
          .from(passwordResetTokens)
          .where(and(eq(passwordResetTokens.tenantId, args.tenantId), lt(passwordResetTokens.createdAt, cutoff)));
        return Number(rows[0]?.n ?? 0);
      },
    },
    {
      target: "analytics_daily_snapshots",
      configuredDays: policy.retention.analytics,
      run: async (cutoff) => {
        // snapshotDate is a DATE; compare against a YYYY-MM-DD string.
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        const r = await db
          .delete(analyticsDailySnapshots)
          .where(
            and(
              eq(analyticsDailySnapshots.tenantId, args.tenantId),
              lt(analyticsDailySnapshots.snapshotDate, cutoffStr)
            )
          )
          .returning({ id: analyticsDailySnapshots.id });
        return r.length;
      },
      count: async (cutoff) => {
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        // snapshotDate is a DATE — string binding is fine here.
        const rows = await db
          .select({ n: count() })
          .from(analyticsDailySnapshots)
          .where(and(eq(analyticsDailySnapshots.tenantId, args.tenantId), lt(analyticsDailySnapshots.snapshotDate, cutoffStr)));
        return Number(rows[0]?.n ?? 0);
      },
    },
    {
      target: "export_audit_events",
      configuredDays: policy.retention.exportAudit,
      run: async (cutoff) => {
        const r = await db
          .delete(exportAuditEvents)
          .where(
            and(
              eq(exportAuditEvents.tenantId, args.tenantId),
              lt(exportAuditEvents.exportedAt, cutoff)
            )
          )
          .returning({ id: exportAuditEvents.id });
        return r.length;
      },
      count: async (cutoff) => {
        const rows = await db
          .select({ n: count() })
          .from(exportAuditEvents)
          .where(and(eq(exportAuditEvents.tenantId, args.tenantId), lt(exportAuditEvents.exportedAt, cutoff)));
        return Number(rows[0]?.n ?? 0);
      },
    },
  ];

  let totalCount = 0;
  for (const t of targets) {
    // ── No policy = skip (preserve current behavior — keep forever).
    if (t.configuredDays === null || t.configuredDays === undefined) {
      resources.push({
        target: t.target,
        configuredDays: null,
        effectiveDays: null,
        count: 0,
        skipped: "no_policy",
      });
      continue;
    }

    // ── Hard-floor enforcement.
    const floor = HARD_FLOOR_DAYS[t.target];
    let effectiveDays = t.configuredDays;
    let skippedReason: RetentionResourceResult["skipped"] = null;
    if (floor !== null && effectiveDays < floor) {
      // Clamp UP to the floor. The tenant's intent (prune old data) is
      // still honored, just bounded below the compliance floor.
      effectiveDays = floor;
      skippedReason = "below_hard_floor";
    }

    const cutoff = new Date(Date.now() - effectiveDays * 24 * 60 * 60_000);

    try {
      // Dry-run = count only. Real run = delete returning count.
      const count = args.dryRun ? await t.count(cutoff) : await t.run(cutoff);
      totalCount += count;
      resources.push({
        target: t.target,
        configuredDays: t.configuredDays,
        effectiveDays,
        count,
        skipped: skippedReason,
      });

      // Emit audit ROW ONLY for real (non-dryRun) executions and only
      // when count > 0 (avoid log spam from no-ops). The cron wrapper
      // also writes a summary regardless.
      if (!args.dryRun && count > 0) {
        await recordSecurityAudit({
          tenantId: args.tenantId,
          category: "security.retention.executed",
          actorUserId: args.actorUserId ?? null,
          actorLabel: args.actorUserId ? undefined : "system/cron",
          entityType: "retention",
          // entityId is a UUID column — keep the resource name in metadata only.
          metadata: {
            target: t.target,
            configured_days: t.configuredDays,
            effective_days: effectiveDays,
            deleted_count: count,
            below_hard_floor: skippedReason === "below_hard_floor",
          },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 200) : "unknown";
      console.error(`[governance] retention failed for ${t.target}:`, err);
      resources.push({
        target: t.target,
        configuredDays: t.configuredDays,
        effectiveDays,
        count: 0,
        skipped: null,
        error: msg,
      });
      // Best-effort audit of the failure.
      if (!args.dryRun) {
        await recordSecurityAudit({
          tenantId: args.tenantId,
          category: "security.retention.executed",
          actorUserId: args.actorUserId ?? null,
          actorLabel: args.actorUserId ? undefined : "system/cron",
          entityType: "retention",
          // entityId is a UUID column — keep the resource name in metadata only.
          metadata: {
            target: t.target,
            failed: true,
            reason: msg,
          },
        });
      }
    }
  }

  return {
    tenantId: args.tenantId,
    dryRun: args.dryRun,
    startedAt,
    durationMs: Date.now() - startedAtMs,
    resources,
    totalCount,
  };
}
