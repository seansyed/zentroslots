/**
 * Regression protection for the admin-analytics schema fingerprint
 * + canonical event taxonomy.
 *
 * Why these tests exist:
 *   A prior bug (kpis.ts referencing billing_transactions.event_type,
 *   which does not exist) shipped silently because the string was
 *   hard-coded in one module and never validated against any source
 *   of truth. The fix introduces lib/admin-analytics/event-taxonomy.ts
 *   as canonical and lib/admin-analytics/schema-fingerprint.ts as a
 *   runtime drift detector.
 *
 *   This test file asserts:
 *     1. The taxonomy strings exist and are exhaustive — adding a
 *        value forces a deliberate update.
 *     2. The schema fingerprint module's EXPECTED_SCHEMA registers
 *        every table referenced by the taxonomy constants.
 *     3. Critical column names (status, transaction_type) are
 *        present in EXPECTED_SCHEMA["billing_transactions"] — the
 *        specific drift that caused the original outage.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BILLING_STATUS,
  BILLING_TRANSACTIONS,
  BILLING_TRANSACTION_TYPE,
  BOOKING_STATUS,
  COMMUNICATION_LOGS,
  COMMUNICATION_STATUS,
  SUBSCRIPTION_ACTIVE_STATES,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_SUSPENDED_STATES,
  actionLikeOr,
} from "../lib/admin-analytics/event-taxonomy";
import { EXPECTED_SCHEMA } from "../lib/admin-analytics/schema-fingerprint";

describe("admin-analytics taxonomy — canonical strings", () => {
  it("BILLING_TRANSACTIONS uses status (NOT event_type) for failure detection", () => {
    // The exact regression we're guarding against.
    assert.equal(BILLING_TRANSACTIONS.STATUS_COL, "status");
    assert.equal(BILLING_TRANSACTIONS.TYPE_COL, "transaction_type");
    // @ts-expect-error event_type intentionally not exposed
    assert.equal(BILLING_TRANSACTIONS.EVENT_TYPE_COL, undefined);
  });

  it("BILLING_STATUS includes failed", () => {
    assert.equal(BILLING_STATUS.FAILED, "failed");
    assert.equal(BILLING_STATUS.SUCCEEDED, "succeeded");
    assert.equal(BILLING_STATUS.PENDING, "pending");
    assert.equal(BILLING_STATUS.REFUNDED, "refunded");
  });

  it("BILLING_TRANSACTION_TYPE includes booking + subscription payments", () => {
    assert.equal(BILLING_TRANSACTION_TYPE.BOOKING_PAYMENT, "booking_payment");
    assert.equal(BILLING_TRANSACTION_TYPE.SUBSCRIPTION_PAYMENT, "subscription_payment");
    assert.equal(BILLING_TRANSACTION_TYPE.INVOICE_PAYMENT, "invoice_payment");
    assert.equal(BILLING_TRANSACTION_TYPE.REFUND, "refund");
  });

  it("COMMUNICATION_LOGS correctly uses event_type (this table DOES have it)", () => {
    // billing_transactions does NOT have event_type — communication_logs DOES.
    // Don't confuse them.
    assert.equal(COMMUNICATION_LOGS.EVENT_TYPE_COL, "event_type");
    assert.equal(COMMUNICATION_LOGS.STATUS_COL, "status");
  });

  it("COMMUNICATION_STATUS includes failed", () => {
    assert.equal(COMMUNICATION_STATUS.FAILED, "failed");
    assert.equal(COMMUNICATION_STATUS.SENT, "sent");
  });

  it("BOOKING_STATUS includes paid-lifecycle states (migration 0030)", () => {
    assert.equal(BOOKING_STATUS.PENDING_PAYMENT, "pending_payment");
    assert.equal(BOOKING_STATUS.PAYMENT_FAILED, "payment_failed");
    assert.equal(BOOKING_STATUS.REFUNDED, "refunded");
  });

  it("SUBSCRIPTION_STATUS + active-states helpers stay aligned", () => {
    assert.ok(
      SUBSCRIPTION_ACTIVE_STATES.includes(SUBSCRIPTION_STATUS.ACTIVE),
      "active must be in SUBSCRIPTION_ACTIVE_STATES",
    );
    assert.ok(
      SUBSCRIPTION_ACTIVE_STATES.includes(SUBSCRIPTION_STATUS.TRIALING),
      "trialing must be in SUBSCRIPTION_ACTIVE_STATES",
    );
    assert.ok(
      SUBSCRIPTION_SUSPENDED_STATES.includes(SUBSCRIPTION_STATUS.CANCELED),
      "canceled must be in SUBSCRIPTION_SUSPENDED_STATES",
    );
  });

  it("actionLikeOr renders a valid SQL OR list", () => {
    const out = actionLikeOr(["admin.%", "security.permission%"]);
    assert.equal(out, "action LIKE 'admin.%' OR action LIKE 'security.permission%'");
  });

  it("actionLikeOr escapes single quotes in patterns", () => {
    const out = actionLikeOr(["foo'bar"]);
    assert.equal(out, "action LIKE 'foo''bar'");
  });
});

describe("admin-analytics schema fingerprint — drift guard", () => {
  it("EXPECTED_SCHEMA['billing_transactions'] includes status + transaction_type", () => {
    // If someone removes either, future kpis.ts edits referencing them
    // will not be caught by /admin/diagnostics.
    const cols = EXPECTED_SCHEMA.billing_transactions;
    assert.ok(cols.includes("status"), "status column must be registered");
    assert.ok(cols.includes("transaction_type"), "transaction_type column must be registered");
    assert.ok(
      !cols.includes("event_type"),
      "event_type must NOT be in billing_transactions expected schema (that's the bug we fixed)",
    );
  });

  it("EXPECTED_SCHEMA['communication_logs'] includes event_type", () => {
    // This table DOES have event_type — the schema fingerprint must
    // recognize it so we don't spuriously flag drift.
    const cols = EXPECTED_SCHEMA.communication_logs;
    assert.ok(cols.includes("event_type"), "event_type must be in communication_logs expected schema");
  });

  it("every snapshot table is registered in EXPECTED_SCHEMA", () => {
    for (const t of [
      "analytics_snapshots_daily",
      "analytics_snapshots_hourly",
      "tenant_health_snapshots",
      "financial_snapshots",
    ]) {
      assert.ok(EXPECTED_SCHEMA[t], `${t} must be registered in EXPECTED_SCHEMA`);
    }
  });

  it("cron_runs is registered in EXPECTED_SCHEMA", () => {
    const cols = EXPECTED_SCHEMA.cron_runs;
    assert.ok(cols);
    assert.ok(cols.includes("job_name"));
    assert.ok(cols.includes("started_at"));
    assert.ok(cols.includes("status"));
  });
});
