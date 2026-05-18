/**
 * Unit tests for the pure parts of lib/automations.
 *
 * - isCompletedBooking is pure (no DB)
 * - hasSuccessfulPayment is intentionally fail-closed today (no payments
 *   table), tested for that contract
 *
 * isFirstTimeCustomer requires a DB; it's exercised in the smoke phase.
 *
 * Also extends template-type coverage: the closed unions must include
 * the new entries so the engine's switch statements compile and the
 * editor surfaces them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hasSuccessfulPayment,
  isCompletedBooking,
} from "../lib/automations/automationConditions";
import {
  FOLLOWUP_TRIGGER_EVENTS,
  REVIEW_PLATFORMS,
} from "../lib/automations/types";
import { TEMPLATE_TYPES } from "../lib/communications/template-types";

describe("automations: isCompletedBooking", () => {
  it("passes when status is 'completed'", () => {
    const r = isCompletedBooking({ bookingStatus: "completed" });
    assert.equal(r.ok, true);
  });

  it("fails for confirmed / pending / cancelled / no_show", () => {
    for (const s of ["confirmed", "pending", "cancelled", "no_show"]) {
      const r = isCompletedBooking({ bookingStatus: s });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "not_completed");
    }
  });
});

describe("automations: hasSuccessfulPayment", () => {
  it("returns ok:false with payment_required (no payments table yet)", async () => {
    const r = await hasSuccessfulPayment({
      tenantId: "00000000-0000-0000-0000-000000000000",
      bookingId: "00000000-0000-0000-0000-000000000000",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "payment_required");
  });
});

describe("automations: closed unions", () => {
  it("REVIEW_PLATFORMS includes google/yelp/facebook/custom", () => {
    assert.ok(REVIEW_PLATFORMS.includes("google"));
    assert.ok(REVIEW_PLATFORMS.includes("yelp"));
    assert.ok(REVIEW_PLATFORMS.includes("facebook"));
    assert.ok(REVIEW_PLATFORMS.includes("custom"));
  });

  it("FOLLOWUP_TRIGGER_EVENTS covers spec's events", () => {
    assert.ok(FOLLOWUP_TRIGGER_EVENTS.includes("appointment.completed"));
    assert.ok(FOLLOWUP_TRIGGER_EVENTS.includes("appointment.cancelled"));
    assert.ok(FOLLOWUP_TRIGGER_EVENTS.includes("appointment.no_show"));
    assert.ok(FOLLOWUP_TRIGGER_EVENTS.includes("appointment.followup_due"));
  });

  it("TEMPLATE_TYPES gained the four new entries", () => {
    assert.ok(TEMPLATE_TYPES.includes("appointment_completed"));
    assert.ok(TEMPLATE_TYPES.includes("appointment_no_show"));
    assert.ok(TEMPLATE_TYPES.includes("review_request"));
    assert.ok(TEMPLATE_TYPES.includes("followup"));
  });

  it("TEMPLATE_TYPES keeps the original five entries", () => {
    // Backward-compat check — never accidentally remove a legacy type.
    assert.ok(TEMPLATE_TYPES.includes("booking_confirmation"));
    assert.ok(TEMPLATE_TYPES.includes("booking_cancelled"));
    assert.ok(TEMPLATE_TYPES.includes("booking_rescheduled"));
    assert.ok(TEMPLATE_TYPES.includes("reminder_24h"));
    assert.ok(TEMPLATE_TYPES.includes("reminder_1h"));
  });
});
