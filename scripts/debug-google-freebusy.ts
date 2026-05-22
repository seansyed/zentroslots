/**
 * One-off diagnostic: dump the raw Google freebusy response for the
 * single connected user. Helps disambiguate "parser bug" vs "Google
 * really returns nothing" vs "events on secondary calendar".
 *
 * Run from /var/www/scheduling-saas: npx tsx scripts/debug-google-freebusy.ts
 * Safe to delete after one use.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { google } from "googleapis";

import { db } from "@/db/client";
import { calendarConnections } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { oauthClient } from "@/lib/calendar/google";

async function main() {
  const conn = await db.query.calendarConnections.findFirst({
    where: eq(calendarConnections.provider, "google"),
  });
  if (!conn) throw new Error("no google connection");
  console.log("connection:", { id: conn.id, calendarId: conn.calendarId, accountEmail: conn.accountEmail });

  if (!conn.refreshTokenEncrypted?.startsWith("v1:")) throw new Error("malformed envelope");
  const refreshToken = decryptSecret(conn.refreshTokenEncrypted);

  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const cal = google.calendar({ version: "v3", auth: client });

  // ─── 1. Discover ALL calendars on the account
  const list = await cal.calendarList.list({ minAccessRole: "freeBusyReader" });
  console.log("\n=== calendarList.list ===");
  for (const c of list.data.items ?? []) {
    console.log(`  ${c.id}  primary=${c.primary ?? false}  selected=${c.selected ?? false}  summary="${c.summary}"`);
  }

  // ─── 2. Probe freebusy on PRIMARY only (what our code does today)
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  const windowStart = new Date(tomorrow.getTime() - 24 * 3600 * 1000); // yesterday 00:00 UTC
  const windowEnd = new Date(tomorrow.getTime() + 7 * 24 * 3600 * 1000); // +7d

  console.log(`\n=== freebusy on PRIMARY, window ${windowStart.toISOString()} → ${windowEnd.toISOString()} ===`);
  const fb1 = await cal.freebusy.query({
    requestBody: {
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      items: [{ id: "primary" }],
    },
  });
  console.log("response.calendars keys:", Object.keys(fb1.data.calendars ?? {}));
  for (const [k, v] of Object.entries(fb1.data.calendars ?? {})) {
    console.log(`  key="${k}"  busy.length=${v?.busy?.length ?? 0}`);
    for (const b of v?.busy ?? []) console.log(`    ${b.start}  →  ${b.end}`);
  }

  // ─── 3. Probe freebusy on EVERY calendar to see if events live elsewhere
  const allIds = (list.data.items ?? []).map((c) => c.id!).filter(Boolean);
  if (allIds.length > 0) {
    console.log(`\n=== freebusy across ALL ${allIds.length} calendars ===`);
    const fb2 = await cal.freebusy.query({
      requestBody: {
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        items: allIds.map((id) => ({ id })),
      },
    });
    for (const [k, v] of Object.entries(fb2.data.calendars ?? {})) {
      const n = v?.busy?.length ?? 0;
      const errors = v?.errors ?? [];
      console.log(`  ${k}  busy=${n}  errors=${JSON.stringify(errors)}`);
      for (const b of v?.busy ?? []) console.log(`    ${b.start}  →  ${b.end}`);
    }
  }

  // ─── 4. Also list events directly so we see TITLES/transparency
  console.log(`\n=== events.list on PRIMARY (next 7 days, raw) ===`);
  const evs = await cal.events.list({
    calendarId: "primary",
    timeMin: windowStart.toISOString(),
    timeMax: windowEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
  });
  for (const e of evs.data.items ?? []) {
    console.log(`  ${e.start?.dateTime ?? e.start?.date}  "${e.summary}"  transparency=${e.transparency ?? "opaque"}  status=${e.status}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
