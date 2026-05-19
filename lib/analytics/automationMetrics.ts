/**
 * Communications/automation metrics from communication_logs.
 *
 * We count by status + event_type:
 *   reminder_emails_sent      — event 'reminder_24h'/'reminder_1h', status 'sent'
 *   reminder_emails_suppressed — same events, status 'skipped'
 *   review_requests_sent       — 'review_request', status 'sent'
 *   followups_sent             — 'followup', status 'sent'
 *   totals (extras.comms)      — generic sent/failed/skipped across all events
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { communicationLogs } from "@/db/schema";

export type AutomationDaily = {
  reminderEmailsSent: number;
  reminderEmailsSuppressed: number;
  reviewRequestsSent: number;
  followupsSent: number;
  totalSent: number;
  totalFailed: number;
  totalSkipped: number;
};

export async function aggregateAutomationMetrics(args: {
  tenantId: string;
  dayStart: Date;
  dayEnd: Date;
}): Promise<AutomationDaily> {
  const rows = await db
    .select({
      eventType: communicationLogs.eventType,
      status: communicationLogs.status,
    })
    .from(communicationLogs)
    .where(
      and(
        eq(communicationLogs.tenantId, args.tenantId),
        gte(communicationLogs.createdAt, args.dayStart),
        lt(communicationLogs.createdAt, args.dayEnd)
      )
    );

  const out: AutomationDaily = {
    reminderEmailsSent: 0,
    reminderEmailsSuppressed: 0,
    reviewRequestsSent: 0,
    followupsSent: 0,
    totalSent: 0,
    totalFailed: 0,
    totalSkipped: 0,
  };

  for (const r of rows) {
    if (r.status === "sent") out.totalSent++;
    else if (r.status === "failed") out.totalFailed++;
    else if (r.status === "skipped") out.totalSkipped++;

    if (r.eventType === "appointment.reminder_24h" || r.eventType === "appointment.reminder_1h") {
      if (r.status === "sent") out.reminderEmailsSent++;
      else if (r.status === "skipped") out.reminderEmailsSuppressed++;
    } else if (r.eventType === "appointment.review_request" && r.status === "sent") {
      out.reviewRequestsSent++;
    } else if (r.eventType === "appointment.followup" && r.status === "sent") {
      out.followupsSent++;
    }
  }

  return out;
}

void sql;
