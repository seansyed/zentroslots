import { db } from "@/db/client";
import { auditLogs, type NewAuditLog } from "@/db/schema";

/**
 * Fire-and-forget audit logger. NEVER throws to the caller — booking
 * and billing critical paths must not fail because of audit failure.
 */
export async function audit(entry: {
  tenantId: string;
  action: string;
  actorUserId?: string | null;
  actorLabel?: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}): Promise<void> {
  try {
    const row: NewAuditLog = {
      tenantId: entry.tenantId,
      actorUserId: entry.actorUserId ?? null,
      actorLabel: entry.actorLabel,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: entry.metadata ?? {},
      ipAddress: entry.ipAddress ?? null,
    };
    await db.insert(auditLogs).values(row);
  } catch (err) {
    // Last-resort log; never propagate.
    console.error("[audit] write failed:", err);
  }
}

export function ipFromHeaders(headers: Headers): string | null {
  // Common reverse-proxy headers; first non-empty wins.
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return headers.get("x-real-ip");
}
