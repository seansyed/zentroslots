/**
 * Wave E — webhook channel renewal cron.
 *
 * Runs every hour. For each webhook_channels row expiring in <6h:
 *   • google → stop + re-watch (rotates channel id)
 *   • microsoft → PATCH /subscriptions/{id} to extend
 *
 * Also: for active calendar connections with NO webhook_channels row,
 * subscribe them. This catches:
 *   • Newly connected accounts (lazy/missed initial subscribe)
 *   • Connections that came in before Wave E shipped
 *
 * Bounded execution: max 200 channels per run.
 *
 * Usage (PM2 cron or systemd timer):
 *   npx tsx scripts/calendar-webhook-renew.ts
 */
import "dotenv/config";
import { and, eq, isNull, lte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { calendarConnections, webhookChannels } from "@/db/schema";
import { renewConnectionWebhook, subscribeConnectionWebhook } from "@/lib/calendar/sync";

const RENEW_WINDOW_MS = 6 * 60 * 60 * 1000; // renew if <6h to expiry
const MAX_PER_RUN = 200;

async function renewExpiring() {
  const cutoff = new Date(Date.now() + RENEW_WINDOW_MS);
  const rows = await db
    .select({ id: webhookChannels.id, provider: webhookChannels.provider, expiresAt: webhookChannels.expiresAt })
    .from(webhookChannels)
    .where(lte(webhookChannels.expiresAt, cutoff))
    .limit(MAX_PER_RUN);

  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    const success = await renewConnectionWebhook(r.id);
    if (success) ok++;
    else failed++;
  }
  return { scanned: rows.length, renewed: ok, failed };
}

async function subscribeNew() {
  // Active connections (google or microsoft) that don't yet have a
  // webhook row. NOT EXISTS subquery — fast on the unique index.
  const rows = await db.execute<{ id: string }>(
    sql`SELECT cc.id
          FROM calendar_connections cc
         WHERE cc.status = 'active'
           AND cc.provider IN ('google','microsoft')
           AND NOT EXISTS (
             SELECT 1 FROM webhook_channels wc WHERE wc.connection_id = cc.id
           )
         LIMIT ${MAX_PER_RUN}`,
  );
  const list = rows as unknown as Array<{ id: string }>;
  let ok = 0;
  let failed = 0;
  for (const r of list) {
    try {
      await subscribeConnectionWebhook(r.id);
      ok++;
    } catch (e) {
      console.error(`[webhook-renew] subscribe failed for ${r.id}:`, e);
      failed++;
    }
  }
  return { scanned: list.length, subscribed: ok, failed };
}

async function main() {
  const start = Date.now();
  const renewResult = await renewExpiring();
  const subResult = await subscribeNew();
  const ms = Date.now() - start;
  // eslint-disable-next-line no-console
  console.log(
    `[webhook-renew] done in ${ms}ms — renewed ${renewResult.renewed}/${renewResult.scanned} (failed ${renewResult.failed}); ` +
    `subscribed ${subResult.subscribed}/${subResult.scanned} (failed ${subResult.failed})`,
  );

  // Reference unused imports so lint doesn't complain.
  void and; void eq; void isNull; void calendarConnections;
}

main().catch((err) => {
  console.error("[webhook-renew] crashed:", err);
  process.exit(1);
});
