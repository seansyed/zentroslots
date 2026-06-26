/**
 * Staff/admin appointment detail — delivery badge + Call visibility logic
 * (phone-appointment work). The repo has no React/DOM harness, so these pin the
 * pure display helper the AppointmentDrawer uses.
 *
 * Backward-compat contract: deliveryMode=null (and virtual/in_person) render
 * NOTHING new, so old bookings look exactly as before; only "phone" gets the
 * badge + Call, "custom" gets a plain label.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appointmentDeliveryDisplay,
  telHref,
} from "../lib/appointment-delivery-display";

test("telHref sanitizes to a dialable number, else null", () => {
  assert.equal(telHref("+1 (555) 123-4567"), "tel:+15551234567");
  assert.equal(telHref("555.123.4567"), "tel:5551234567");
  assert.equal(telHref(null), null);
  assert.equal(telHref(""), null);
  assert.equal(telHref("   "), null);
  assert.equal(telHref("no digits"), null);
});

test("phone appointment → badge + phone + Call", () => {
  const d = appointmentDeliveryDisplay("phone", "+1 (555) 123-4567");
  assert.equal(d.badgeLabel, "Phone Appointment");
  assert.equal(d.phone, "+1 (555) 123-4567");
  assert.equal(d.callHref, "tel:+15551234567");
});

test("phone appointment without a number → badge but no Call", () => {
  const d = appointmentDeliveryDisplay("phone", null);
  assert.equal(d.badgeLabel, "Phone Appointment");
  assert.equal(d.phone, null);
  assert.equal(d.callHref, null);
});

test("custom → simple label, no phone/Call", () => {
  const d = appointmentDeliveryDisplay("custom", "+15550000000");
  assert.deepEqual(d, { badgeLabel: "Custom appointment", phone: null, callHref: null });
});

test("BACKWARD COMPAT: null / virtual / in_person render nothing new", () => {
  for (const mode of [null, undefined, "virtual", "in_person"] as const) {
    // Even if a phone happens to be present, non-phone modes add nothing.
    const d = appointmentDeliveryDisplay(mode, "+15551112222");
    assert.deepEqual(
      d,
      { badgeLabel: null, phone: null, callHref: null },
      `mode ${String(mode)} should render nothing new`,
    );
  }
});
