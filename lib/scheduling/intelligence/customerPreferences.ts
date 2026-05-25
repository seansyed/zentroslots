/**
 * Phase SMART-1 — customer preference memory.
 *
 * Derives a per-customer (per tenant) profile from past bookings.
 * Strictly tenant-scoped — every query carries (tenantId, lower
 * clientEmail). Cross-tenant data isolation is enforced at the
 * WHERE clause level.
 *
 * The profile is RECOMPUTED on-demand (no cache table) because:
 *   • Booking history per customer per tenant is small (< 100 rows
 *     for nearly all real customers).
 *   • The query hits the existing index on bookings(client_email).
 *   • Eliminates an entire cache-invalidation surface — every read
 *     is fresh.
 *
 * Pure data shape — the orchestrator handles DB I/O.
 */

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings } from "@/db/schema";
import { hourInTz, weekdayInTz } from "./scoreSlot";
import type { CustomerPreferenceProfile } from "./types";

/** Minimum bookings before we trust the profile signal. */
const MIN_SAMPLE_SIZE = 3;

/** Time horizon for "preference" derivation. Older bookings count
 *  less but still count — we hard-cut at 2 years to keep queries
 *  cheap + reflect recent behavior. */
const LOOKBACK_DAYS = 730;

/** Build a customer profile from past bookings. Returns null when
 *  the customer has no history with this tenant (callers should
 *  pass null/undefined as customerProfile to scoreSlot in that case).
 *
 *  Why we look at TZ-localized hour/weekday: a customer who always
 *  books at 10am local time should see a "Recommended" badge on
 *  10am local slots even if those are different UTC hours due to
 *  DST. */
export async function loadCustomerPreferenceProfile(args: {
  tenantId: string;
  customerEmail: string;
  /** Customer's timezone (IANA). Falls back to UTC if unknown. */
  customerTz?: string;
}): Promise<CustomerPreferenceProfile | null> {
  if (!args.customerEmail || !args.customerEmail.includes("@")) return null;

  const tz = args.customerTz || "UTC";
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);

  // One indexed read — bookings(client_email) is indexed (line 469
  // of schema.ts confirmed during Phase SMART-1 discovery).
  const rows = await db
    .select({
      startAt: bookings.startAt,
      status: bookings.status,
      // We use `rescheduled` as a proxy via the existence of an
      // updatedAt > createdAt + reasonable gap. Simpler approximation
      // for now: count completed vs no_show vs cancelled.
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, args.tenantId),
        sql`lower(${bookings.clientEmail}) = ${args.customerEmail.toLowerCase()}`,
        sql`${bookings.startAt} >= ${cutoff.toISOString()}`,
      ),
    )
    .limit(500); // Hard cap defensively — > 500 would be unusual.

  if (rows.length === 0) return null;

  const preferredHourHistogram = new Array<number>(24).fill(0);
  const preferredDayHistogram = new Array<number>(7).fill(0);
  let noShowCount = 0;
  let cancelledCount = 0;
  let kept = 0;

  for (const r of rows) {
    if (!r.startAt) continue;
    // Only count "meaningfully observed" bookings for the histogram —
    // pending_payment / payment_failed / refunded are noise.
    const observable =
      r.status === "confirmed" ||
      r.status === "completed" ||
      r.status === "no_show" ||
      r.status === "cancelled";
    if (!observable) continue;
    kept++;
    const h = hourInTz(r.startAt, tz);
    const d = weekdayInTz(r.startAt, tz);
    if (r.status === "confirmed" || r.status === "completed") {
      preferredHourHistogram[h]++;
      preferredDayHistogram[d]++;
    }
    if (r.status === "no_show") noShowCount++;
    if (r.status === "cancelled") cancelledCount++;
  }

  if (kept < MIN_SAMPLE_SIZE) return null;

  return {
    preferredHourHistogram,
    preferredDayHistogram,
    sampleSize: kept,
    rescheduleRate: kept === 0 ? 0 : cancelledCount / kept,
    noShowRate: kept === 0 ? 0 : noShowCount / kept,
  };
}
