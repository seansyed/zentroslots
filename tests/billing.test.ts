/**
 * Unit tests for the pure parts of the billing ledger + revenue
 * metrics + Stripe webhook helper.
 *
 *   - recordBillingEvent: classification of non-revenue event types
 *     (pure skip path; DB-touching cases verified via production smoke)
 *   - emptyRevenueDaily: shape contract for the dashboard fallback
 *
 * Webhook DB writes + Stripe-API-facing idempotency are exercised in
 * the production smoke phase — they need real DB + signed payloads.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { emptyRevenueDaily } from "../lib/analytics/revenueMetrics";
import { recordBillingEvent } from "../lib/billing/recordBillingEvent";

// Minimal Stripe.Event shape — we only set the fields the helper reads.
function makeEvent(type: string, dataObject: object = {}): unknown {
  return {
    id: `evt_test_${Math.random().toString(36).slice(2)}`,
    object: "event",
    type,
    data: { object: dataObject },
  };
}

describe("billing: recordBillingEvent — non-revenue events skip cleanly", () => {
  it("ignores checkout.session.completed (handled elsewhere)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await recordBillingEvent(makeEvent("checkout.session.completed") as any);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.status, "skipped");
      assert.equal(r.reason, "event_not_revenue_relevant");
    }
  });

  it("ignores customer.subscription.updated", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await recordBillingEvent(makeEvent("customer.subscription.updated") as any);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.status, "skipped");
  });

  it("ignores totally unknown event type", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await recordBillingEvent(makeEvent("ping.pong") as any);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.status, "skipped");
  });
});

describe("billing: recordBillingEvent — never throws on malformed payloads", () => {
  // These three tests assert the CONTRACT: the helper NEVER throws,
  // even when the DB is unreachable or the payload is malformed. It
  // returns a structured result (ok:true skipped OR ok:false reason)
  // and logs internally. The exact outcome depends on whether the
  // path reaches the DB before bailing.

  it("payment_intent without customer → skipped (no DB hit needed)", async () => {
    const r = await recordBillingEvent(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeEvent("payment_intent.succeeded", { id: "pi_test", amount: 1000, currency: "usd" }) as any
    );
    // No customer id → tenant resolution skipped → ok:true skipped.
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.status, "skipped");
      assert.equal(r.reason, "tenant_not_found");
    }
  });

  it("charge.refunded without customer → skipped (no DB hit needed)", async () => {
    const r = await recordBillingEvent(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeEvent("charge.refunded", { id: "ch_test", amount_refunded: 500, currency: "usd" }) as any
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.status, "skipped");
      assert.equal(r.reason, "tenant_not_found");
    }
  });

  it("invoice with a customer id is robust to DB failure (returns structured result, never throws)", async () => {
    // Customer id present → helper queries the DB. In the test env
    // (no DB connection) it returns ok:false with a captured error
    // message. The KEY contract: it does NOT throw.
    let didThrow = false;
    let result: Awaited<ReturnType<typeof recordBillingEvent>> | null = null;
    try {
      result = await recordBillingEvent(
        makeEvent("invoice.payment_succeeded", {
          id: "in_test",
          customer: "cus_test_nonexistent",
          amount_paid: 1000,
          currency: "usd",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      );
    } catch {
      didThrow = true;
    }
    assert.equal(didThrow, false, "helper must not throw");
    assert.ok(result);
    // Either ok:true skipped (DB reached, tenant missing) OR ok:false
    // (DB unreachable). Both honor the rule #13 contract.
    assert.ok(result.ok === true || (result.ok === false && typeof result.reason === "string"));
  });
});

describe("billing: emptyRevenueDaily shape", () => {
  it("returns all zeros for summary", () => {
    const r = emptyRevenueDaily();
    assert.equal(r.summary.grossRevenueCents, 0);
    assert.equal(r.summary.refundedRevenueCents, 0);
    assert.equal(r.summary.netRevenueCents, 0);
    assert.equal(r.summary.successfulPayments, 0);
    assert.equal(r.summary.failedPayments, 0);
    assert.equal(r.summary.avgBookingValueCents, 0);
  });
  it("returns empty arrays for serviceRevenue and staffRevenue", () => {
    const r = emptyRevenueDaily();
    assert.deepEqual(r.serviceRevenue, []);
    assert.deepEqual(r.staffRevenue, []);
  });
});
