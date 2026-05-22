/**
 * Wave E — freebusy cache cleanup cron.
 *
 * Deletes expired freebusy_cache rows in bounded batches. The cache's
 * READ path filters out expired rows already (so correctness doesn't
 * depend on this cron), but periodic cleanup keeps the table small
 * and the index lean.
 *
 * Usage (cron, every 15 min):
 *   npx tsx scripts/freebusy-cache-cleanup.ts
 */
import "dotenv/config";
import { cleanupExpired } from "@/lib/calendar/freebusyCache";

const PER_PASS = 5000;
const MAX_PASSES = 5; // bounded total work per invocation

async function main() {
  const start = Date.now();
  let totalDeleted = 0;
  for (let i = 0; i < MAX_PASSES; i++) {
    const deleted = await cleanupExpired(PER_PASS);
    totalDeleted += deleted;
    if (deleted < PER_PASS) break;
  }
  const ms = Date.now() - start;
  // eslint-disable-next-line no-console
  console.log(`[freebusy-cleanup] done in ${ms}ms — deleted ${totalDeleted} expired rows`);
}

main().catch((err) => {
  console.error("[freebusy-cleanup] crashed:", err);
  process.exit(1);
});
