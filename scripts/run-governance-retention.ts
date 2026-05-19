#!/usr/bin/env tsx
/**
 * run-governance-retention.ts
 *
 * For every tenant: runs the retention engine (NOT dry-run). Per-tenant
 * try/catch — one tenant failure NEVER stops the batch. Writes a
 * structured summary to stdout for the cron operator + a security
 * audit row per (tenant, resource) with deleted_count.
 *
 *   Linux cron:  30 2 * * *  (cd /app && npm run governance:retention)
 *
 * Tenants without a tenant_governance_settings row are scanned but the
 * engine returns "no_policy" for every resource (no deletion). Safe
 * to enable on day-1; it does nothing until a tenant opts in.
 */

import "dotenv/config";

import { db } from "../db/client";
import { tenants } from "../db/schema";
import { runTenantRetention } from "../lib/governance/retention";

(async () => {
  try {
    const tenantRows = await db.select({ id: tenants.id, name: tenants.name }).from(tenants);
    let okCount = 0;
    let failCount = 0;
    let totalDeleted = 0;

    for (const t of tenantRows) {
      try {
        const summary = await runTenantRetention({ tenantId: t.id, dryRun: false });
        const resourceCounts = summary.resources
          .filter((r) => r.count > 0)
          .map((r) => `${r.target}=${r.count}`)
          .join(",");
        console.log(
          JSON.stringify({
            evt: "governance_retention",
            tenant: t.name,
            tenant_id: t.id,
            duration_ms: summary.durationMs,
            total_deleted: summary.totalCount,
            details: resourceCounts || "no_policy",
            ts: new Date().toISOString(),
          })
        );
        totalDeleted += summary.totalCount;
        okCount++;
      } catch (err) {
        console.error(
          JSON.stringify({
            evt: "governance_retention_failed",
            tenant: t.name,
            tenant_id: t.id,
            err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
            ts: new Date().toISOString(),
          })
        );
        failCount++;
      }
    }

    console.log(
      `[governance] tenants=${tenantRows.length} ok=${okCount} failed=${failCount} deleted=${totalDeleted}`
    );
    process.exit(0);
  } catch (e) {
    console.error("[governance] worker crashed:", e);
    process.exit(1);
  }
})();
