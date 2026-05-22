/**
 * Stripe webhook idempotency claim.
 *
 * Stripe retries failed deliveries for up to 3 days. The signature
 * stays valid across retries, so a duplicate event would re-execute
 * the tenants.update unless we dedupe.
 *
 * Pattern:
 *
 *   const claim = await tryClaimStripeEvent({ eventId, eventType, tenantId });
 *   if (!claim.fresh) {
 *     // duplicate — return 200 immediately, skip processing
 *     return NextResponse.json({ received: true, duplicate: true });
 *   }
 *   // ... process event normally ...
 *
 * The INSERT itself is the atomic primitive. Postgres guarantees no
 * two concurrent inserts of the same event_id both report `fresh=true`.
 * This survives multi-worker PM2 setups without a separate lock.
 *
 * Failure mode: if the INSERT itself errors (DB unreachable etc.), we
 * return `fresh=true` so the handler still processes the event. The
 * outer handler's failure path will 500 and Stripe will retry — better
 * to risk a duplicate processing than to silently skip a real event.
 */
import { sql } from "drizzle-orm";

import { db as defaultDb } from "@/db/client";

export type ClaimResult = {
  /** true = first time seeing this event; safe to process.
   *  false = duplicate replay; caller should return 200 without
   *  re-processing. */
  fresh: boolean;
  /** Echoed back for the caller's audit context. */
  eventId: string;
};

export async function tryClaimStripeEvent(args: {
  eventId: string;
  eventType: string;
  tenantId?: string | null;
  db?: typeof defaultDb;
}): Promise<ClaimResult> {
  const { eventId, eventType, tenantId = null, db = defaultDb } = args;
  try {
    // INSERT ... ON CONFLICT DO NOTHING returns 0 affected rows when
    // a row with this event_id already exists. We check the rowCount
    // via a RETURNING clause — Postgres only returns the inserted row
    // when the INSERT actually happened.
    const result = await db.execute(
      sql`
        INSERT INTO processed_stripe_events (event_id, event_type, tenant_id)
        VALUES (${eventId}, ${eventType}, ${tenantId})
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id
      `,
    );
    // drizzle's execute() returns a result whose shape varies by driver;
    // safest is to check rowCount via the returned rows array length.
    const rows = (result as unknown as { rows?: unknown[] }).rows ?? [];
    return { fresh: rows.length > 0, eventId };
  } catch (e) {
    // Defensive: if the dedup table is unreachable, fail OPEN — process
    // the event as if fresh. The alternative (silently skipping a real
    // event because we couldn't write the dedup row) is worse than
    // duplicating work. Stripe's downstream idempotency (ledger unique
    // index, our tenants UPDATE being idempotent for same-state writes)
    // contains the blast radius.
    console.warn(`[stripe-idempotency] claim insert failed for ${eventId}; processing as fresh:`, e);
    return { fresh: true, eventId };
  }
}
