/**
 * Public booking flow — delivery-mode selection + submission logic
 * (phone-appointment work). The repo has no React/DOM booking-form tests, so
 * these pin the pure helpers BookingFlow uses (lib/booking-delivery-modes):
 *
 *   • resolveDeliveryModeUI    — when the selector shows, what's offered, the
 *                                default mode.
 *   • buildBookingDeliveryPayload — exactly what the POST body carries.
 *
 * Backward-compat contract: legacy in_person/virtual-only services show NO
 * selector and send NO deliveryMode (byte-identical payload); phone bookings
 * require + carry a phone number.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeOfferedModes,
  resolveDeliveryModeUI,
  buildBookingDeliveryPayload,
} from "../lib/booking-delivery-modes";

test("normalizeOfferedModes — priority order, de-dupe, drops junk", () => {
  assert.deepEqual(normalizeOfferedModes(["phone", "in_person", "phone"]), ["in_person", "phone"]);
  assert.deepEqual(normalizeOfferedModes(["custom", "virtual"]), ["virtual", "custom"]);
  assert.deepEqual(normalizeOfferedModes(["junk", "phone"]), ["phone"]);
  assert.deepEqual(normalizeOfferedModes(null), []);
  assert.deepEqual(normalizeOfferedModes([]), []);
});

test("LEGACY services behave exactly as before — no selector, no default mode", () => {
  for (const modes of [["virtual", "in_person"], ["virtual"], ["in_person"], null, []] as const) {
    const r = resolveDeliveryModeUI(modes as string[] | null);
    assert.equal(r.showModeSelector, false, `${JSON.stringify(modes)} should not show selector`);
    assert.equal(r.defaultMode, null, `${JSON.stringify(modes)} should not default a mode`);
  }
});

test("SINGLE new mode → auto-selected, no selector", () => {
  const phone = resolveDeliveryModeUI(["phone"]);
  assert.equal(phone.showModeSelector, false);
  assert.equal(phone.defaultMode, "phone");

  const custom = resolveDeliveryModeUI(["custom"]);
  assert.equal(custom.showModeSelector, false);
  assert.equal(custom.defaultMode, "custom");
});

test("MULTIPLE modes incl. a new one → selector, priority default", () => {
  const a = resolveDeliveryModeUI(["phone", "in_person"]);
  assert.equal(a.showModeSelector, true);
  assert.deepEqual(a.offeredModes, ["in_person", "phone"]);
  assert.equal(a.defaultMode, "in_person"); // priority: in_person first

  const b = resolveDeliveryModeUI(["phone", "virtual"]);
  assert.equal(b.showModeSelector, true);
  assert.equal(b.defaultMode, "virtual"); // virtual preferred over phone

  const c = resolveDeliveryModeUI(["in_person", "virtual", "phone", "custom"]);
  assert.equal(c.showModeSelector, true);
  assert.deepEqual(c.offeredModes, ["in_person", "virtual", "phone", "custom"]);
  assert.equal(c.defaultMode, "in_person");
});

test("buildBookingDeliveryPayload — legacy omits; modes carried; phone trimmed", () => {
  // Legacy (null) → empty object → byte-identical booking payload.
  assert.deepEqual(buildBookingDeliveryPayload(null, ""), {});
  // Non-phone modes → deliveryMode only, never a phone.
  assert.deepEqual(buildBookingDeliveryPayload("virtual", ""), { deliveryMode: "virtual" });
  assert.deepEqual(buildBookingDeliveryPayload("in_person", "x"), { deliveryMode: "in_person" });
  assert.deepEqual(buildBookingDeliveryPayload("custom", ""), { deliveryMode: "custom" });
  // Phone with a number → both fields, phone trimmed.
  assert.deepEqual(buildBookingDeliveryPayload("phone", "  +1 555 0100  "), {
    deliveryMode: "phone",
    clientPhone: "+1 555 0100",
  });
  // Phone with blank → mode only (the UI guard + server schema block submit).
  assert.deepEqual(buildBookingDeliveryPayload("phone", "   "), { deliveryMode: "phone" });
});
