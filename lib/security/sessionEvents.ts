/**
 * Session audit-event writer.
 *
 * Records login/logout/revoke/failure/etc events into
 * session_audit_events. The dashboard reads this for the "active
 * sessions" + "recent logins" + "failed login attempts" sections.
 *
 * NEVER throws — auth flows must not fail because of audit failure.
 * NEVER updates an existing event — append-only.
 */

import { db } from "@/db/client";
import { sessionAuditEvents } from "@/db/schema";

/** Closed enum of session event types. Matches the controlled values
 *  the security dashboard knows how to label + filter. */
export const SESSION_EVENT_TYPES = [
  "login",
  "logout",
  "login_failed",
  "password_reset_requested",
  "password_reset_completed",
  "session_revoked",
  "sessions_revoked_all",
  "device_changed",
  "suspicious_login",
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

export type RecordSessionEventArgs = {
  tenantId: string;
  /** Null for failed logins on unknown users. */
  userId?: string | null;
  eventType: SessionEventType;
  sessionJti?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  deviceLabel?: string | null;
  metadata?: Record<string, unknown>;
};

export async function recordSessionEvent(args: RecordSessionEventArgs): Promise<void> {
  try {
    await db.insert(sessionAuditEvents).values({
      tenantId: args.tenantId,
      userId: args.userId ?? null,
      eventType: args.eventType,
      sessionJti: args.sessionJti ?? null,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      deviceLabel: args.deviceLabel ?? null,
      metadata: args.metadata ?? {},
    });
  } catch (err) {
    console.error("[security] recordSessionEvent failed:", err);
  }
}

export function userAgentFromHeaders(headers: Headers): string | null {
  const ua = headers.get("user-agent");
  return ua ? ua.slice(0, 1000) : null;
}
