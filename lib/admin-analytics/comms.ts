/**
 * SA-3 Section C — Communications monitoring.
 *
 * 8 KPI tiles + 24-hour hourly graph series. All values from real
 * DB queries.
 *
 *   • Emails sent today
 *   • Reminder emails sent today
 *   • SMS sent today (always 0 today — SMS not yet wired; honest
 *     'not_configured' detail)
 *   • Failed reminders today
 *   • Bounced emails today
 *   • Delayed reminders (bookings past their reminder window with
 *     no send)
 *   • Queue retries — currently 0 (we don't retry; surfaced for
 *     future)
 *   • Reminder success %
 *
 * Hourly series: 3 datasets over the last 24 hours bucketed hourly.
 */

import { sql } from "drizzle-orm";

import { memoize } from "./cache";
import { db } from "@/db/client";

export type CommsTile = {
  key: string;
  label: string;
  value: number | null;
  unit: "count" | "percent" | "string";
  status: "green" | "amber" | "red" | "neutral";
  detail: string;
  tooltip: string;
};

export type HourPoint = { hour: string; sent: number; failed: number; retries: number };

export type CommsMonitoring = {
  tiles: CommsTile[];
  hourly: HourPoint[];
  generatedAt: string;
  computedInMs: number;
};

function lastNHours(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60_000);
    const h = `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:00`;
    out.push(h);
  }
  return out;
}

async function safe<T>(producer: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await producer();
  } catch (err) {
    try {
      console.error(JSON.stringify({ evt: "comms_compute_fail", reason: err instanceof Error ? err.message.slice(0, 200) : "unknown" }));
    } catch {}
    return fallback;
  }
}

export async function computeCommsMonitoring(): Promise<CommsMonitoring> {
  return memoize(
    "admin:comms:v1",
    async () => {
      const t0 = Date.now();
      const tiles: CommsTile[] = [];

      // Aggregate counts in a single grouped query — much cheaper
      // than 8 round trips.
      const today = await safe(
        async () =>
          (await db.execute(
            sql`SELECT
                  SUM(CASE WHEN status='sent'    AND created_at::date = CURRENT_DATE THEN 1 ELSE 0 END)::int AS sent_today,
                  SUM(CASE WHEN status='failed'  AND created_at::date = CURRENT_DATE THEN 1 ELSE 0 END)::int AS failed_today,
                  SUM(CASE WHEN status='sent'    AND event_type LIKE 'appointment.reminder%' AND created_at::date = CURRENT_DATE THEN 1 ELSE 0 END)::int AS reminders_today,
                  SUM(CASE WHEN channel='sms'    AND created_at::date = CURRENT_DATE THEN 1 ELSE 0 END)::int AS sms_today
                FROM communication_logs`,
          )) as unknown as Array<{ sent_today: number; failed_today: number; reminders_today: number; sms_today: number }>,
        [{ sent_today: 0, failed_today: 0, reminders_today: 0, sms_today: 0 }],
      );
      const t = today[0];
      const sentToday = Number(t?.sent_today ?? 0);
      const failedToday = Number(t?.failed_today ?? 0);
      const remindersToday = Number(t?.reminders_today ?? 0);
      const smsToday = Number(t?.sms_today ?? 0);

      const bounces = await safe(
        async () =>
          (await db.execute(
            sql`SELECT COUNT(*)::int AS n FROM email_suppressions WHERE kind='bounce' AND last_seen_at::date = CURRENT_DATE`,
          )) as unknown as Array<{ n: number }>,
        [{ n: 0 }],
      );
      const bouncedToday = Number(bounces[0]?.n ?? 0);

      const delayed = await safe(
        async () =>
          (await db.execute(
            sql`SELECT COUNT(*)::int AS n FROM bookings
                 WHERE status='confirmed'
                   AND start_at < NOW()
                   AND start_at > NOW() - INTERVAL '24 hours'
                   AND reminder_1h_sent_at IS NULL`,
          )) as unknown as Array<{ n: number }>,
        [{ n: 0 }],
      );
      const delayedReminders = Number(delayed[0]?.n ?? 0);

      const reminderSuccess =
        remindersToday + failedToday > 0
          ? Math.round((remindersToday / (remindersToday + failedToday)) * 1000) / 10
          : null;

      tiles.push(
        {
          key: "emails_sent_today",
          label: "Emails sent today",
          value: sentToday,
          unit: "count",
          status: "green",
          detail: `${sentToday}`,
          tooltip: "communication_logs status='sent' since midnight UTC.",
        },
        {
          key: "reminder_emails",
          label: "Reminder emails today",
          value: remindersToday,
          unit: "count",
          status: "green",
          detail: `${remindersToday}`,
          tooltip: "Emails with event_type LIKE 'appointment.reminder%' since midnight UTC.",
        },
        {
          key: "sms_sent",
          label: "SMS sent today",
          value: smsToday,
          unit: "count",
          status: smsToday === 0 ? "neutral" : "green",
          detail: smsToday === 0 ? "Not configured" : `${smsToday}`,
          tooltip:
            "SMS infrastructure exists at the schema level (channel='sms') but is not wired into the reminder cron yet — always 0 today.",
        },
        {
          key: "failed_reminders",
          label: "Failed sends today",
          value: failedToday,
          unit: "count",
          status: failedToday === 0 ? "green" : failedToday < 5 ? "amber" : "red",
          detail: `${failedToday}`,
          tooltip:
            "communication_logs status='failed' since midnight UTC. Any non-zero value is investigated automatically by admin-notify.",
        },
        {
          key: "bounced_emails",
          label: "Bounces today",
          value: bouncedToday,
          unit: "count",
          status: bouncedToday === 0 ? "green" : bouncedToday < 3 ? "amber" : "red",
          detail: `${bouncedToday}`,
          tooltip: "New permanent-bounce rows in email_suppressions since midnight UTC.",
        },
        {
          key: "delayed_reminders",
          label: "Past-due reminders",
          value: delayedReminders,
          unit: "count",
          status: delayedReminders === 0 ? "green" : delayedReminders < 3 ? "amber" : "red",
          detail: `${delayedReminders}`,
          tooltip:
            "Confirmed bookings whose start time has passed in the last 24h but never received a 1h reminder. Should hover at zero.",
        },
        {
          key: "queue_retries",
          label: "Queue retries today",
          value: 0,
          unit: "count",
          status: "neutral",
          detail: "Not configured",
          tooltip:
            "The current architecture is single-attempt cron — no retry layer yet. This tile reserved for when retry is wired (planned roadmap).",
        },
        {
          key: "reminder_success",
          label: "Reminder success rate",
          value: reminderSuccess,
          unit: "percent",
          status:
            reminderSuccess === null
              ? "neutral"
              : reminderSuccess >= 98
              ? "green"
              : reminderSuccess >= 90
              ? "amber"
              : "red",
          detail: reminderSuccess === null ? "No sends today" : `${reminderSuccess}%`,
          tooltip:
            "Reminder sends ÷ (reminder sends + failed sends) today. Below 90% triggers SES sandbox investigation.",
        },
      );

      // Hourly graph series — last 24 hours bucketed.
      const hourlyRows = await safe(
        async () =>
          (await db.execute(
            sql`SELECT date_trunc('hour', created_at) AS hr,
                       SUM(CASE WHEN status='sent'   THEN 1 ELSE 0 END)::int AS sent,
                       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END)::int AS failed
                  FROM communication_logs
                 WHERE created_at > NOW() - INTERVAL '24 hours'
                 GROUP BY 1
                 ORDER BY 1`,
          )) as unknown as Array<{ hr: string; sent: number; failed: number }>,
        [],
      );
      const hourMap = new Map(
        hourlyRows.map((r) => {
          const d = new Date(r.hr);
          const k = `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:00`;
          return [k, { sent: Number(r.sent), failed: Number(r.failed) }];
        }),
      );
      const hourly = lastNHours(24).map((h) => ({
        hour: h,
        sent: hourMap.get(h)?.sent ?? 0,
        failed: hourMap.get(h)?.failed ?? 0,
        retries: 0,
      }));

      return {
        tiles,
        hourly,
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    30_000,
  );
}
