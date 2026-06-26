/**
 * Mobile phone-appointment display logic (phone-appointment work). Pins the
 * pure helper the booking-detail screen uses for the "Phone Appointment" badge
 * + Call action. Backward-compat: null/virtual/in_person render nothing new.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appointmentDeliveryDisplay,
  telHref,
} from "../src/lib/deliveryDisplay";

test("phone mode → badge + phone + call href", () => {
  const d = appointmentDeliveryDisplay("phone", "+1 (555) 123-4567");
  assert.equal(d.badgeLabel, "Phone Appointment");
  assert.equal(d.phone, "+1 (555) 123-4567");
  assert.equal(d.callHref, "tel:+15551234567");
});

test("phone mode without a phone → badge but no call action", () => {
  const d = appointmentDeliveryDisplay("phone", null);
  assert.equal(d.badgeLabel, "Phone Appointment");
  assert.equal(d.phone, null);
  assert.equal(d.callHref, null);
});

test("custom → simple label, no phone/Call", () => {
  assert.deepEqual(appointmentDeliveryDisplay("custom", "+15550000000"), {
    badgeLabel: "Custom appointment",
    phone: null,
    callHref: null,
  });
});

test("BACKWARD COMPAT: null / virtual / in_person render nothing new", () => {
  for (const mode of [null, undefined, "virtual", "in_person"] as const) {
    assert.deepEqual(appointmentDeliveryDisplay(mode, "+15551112222"), {
      badgeLabel: null,
      phone: null,
      callHref: null,
    });
  }
});

test("tel sanitization", () => {
  assert.equal(telHref("+1 (555) 123-4567"), "tel:+15551234567");
  assert.equal(telHref("555.123.4567"), "tel:5551234567");
  assert.equal(telHref(null), null);
  assert.equal(telHref(""), null);
  assert.equal(telHref("no digits"), null);
});
