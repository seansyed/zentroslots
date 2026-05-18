#!/usr/bin/env tsx
/**
 * expire-waitlist-reservations.ts
 *
 * Scans waitlist_notifications for 'sent' rows whose expiresAt has
 * passed, marks them expired, returns the waitlist row to 'waiting',
 * and attempts to re-promote the slot to the next best candidate.
 *
 * Cadence: every 5 minutes via cron is plenty (the default reservation
 * window is 15 min). Idempotent — re-running is safe.
 *
 *   Linux cron:  *​/5 * * * *  (cd /app && npm run waitlists:expire)
 *
 * Never throws; logs per-row failures and continues.
 */
import "dotenv/config";

import { expireReservations } from "../lib/waitlists/expireReservations";

(async () => {
  try {
    const res = await expireReservations();
    console.log(
      `[waitlists] scanned=${res.scanned} expired=${res.expired} rePromoted=${res.rePromoted}`
    );
    process.exit(0);
  } catch (e) {
    console.error("[waitlists] worker crashed:", e);
    process.exit(1);
  }
})();
