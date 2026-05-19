/**
 * Export audit writer.
 *
 * Wire every CSV / data extract endpoint through this. Best-effort —
 * NEVER fails the export. Failures are logged structurally so an ops
 * pipeline can alert on persistent export-audit drops.
 *
 * Also emits a `security.export.executed` audit row so the existing
 * security audit log carries the same event (one place for security
 * reviewers; the dedicated table makes export-specific queries fast).
 */

import { db } from "@/db/client";
import { exportAuditEvents } from "@/db/schema";
import { recordSecurityAudit } from "@/lib/security/audit";
import type { ExportType } from "./types";

export type ExportAuditArgs = {
  tenantId: string;
  userId: string | null;
  exportType: ExportType;
  recordCount?: number | null;
  fileSizeBytes?: number | null;
  filtersUsed?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function recordExportAudit(args: ExportAuditArgs): Promise<void> {
  // 1. Dedicated table — fast queries / governance dashboards.
  try {
    await db.insert(exportAuditEvents).values({
      tenantId: args.tenantId,
      userId: args.userId,
      exportType: args.exportType,
      recordCount: args.recordCount ?? null,
      fileSizeBytes: args.fileSizeBytes ?? null,
      filtersUsed: sanitizeFilters(args.filtersUsed ?? {}),
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ? args.userAgent.slice(0, 1000) : null,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "export_audit_insert_failed",
        type: args.exportType,
        ts: new Date().toISOString(),
        err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      })
    );
  }

  // 2. Cross-post to the security audit log (existing infrastructure).
  //    Reuses the security.export.executed category that already exists.
  try {
    await recordSecurityAudit({
      tenantId: args.tenantId,
      category: "security.export.executed",
      actorUserId: args.userId ?? null,
      entityType: "export",
      entityId: args.exportType,
      ipAddress: args.ipAddress ?? null,
      metadata: {
        export_type: args.exportType,
        record_count: args.recordCount ?? null,
        file_size_bytes: args.fileSizeBytes ?? null,
      },
    });
  } catch (err) {
    console.error("[governance] export-audit cross-post failed:", err);
  }
}

/** Bounded sanitization — caps keys + value sizes so a filters dict
 *  with massive strings can't bloat the row. */
function sanitizeFilters(filters: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [k, v] of Object.entries(filters)) {
    if (count >= 20) break;
    const key = k.slice(0, 60);
    if (typeof v === "string") out[key] = v.slice(0, 200);
    else if (typeof v === "number" || typeof v === "boolean") out[key] = v;
    else if (v === null) out[key] = null;
    else if (Array.isArray(v)) out[key] = v.slice(0, 20).map((x) => (typeof x === "string" ? x.slice(0, 100) : x));
    else out[key] = "[obj]"; // strip nested objects
    count++;
  }
  return out;
}
