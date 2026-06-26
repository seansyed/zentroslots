/**
 * Phone-appointment notifications (phone-appointment work). Verifies the shared
 * wording helper AND the actual rendered output of all four email builders, so
 * confirmation/reschedule/cancellation/reminder consistently surface phone
 * appointments — while in-person / virtual / legacy(null) emails are unchanged.
 *
 * Pure render functions (no send). Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { appointmentDeliveryWording } from "../lib/appointment-delivery-wording";
import {
  renderConfirmation,
  renderCancellation,
  renderReschedule,
  renderReminder,
} from "../lib/email";

const base = {
  id: "b1",
  serviceName: "Consult",
  staffName: "Dr. Smith",
  staffEmail: "dr@example.test",
  startAt: new Date("2026-07-01T15:00:00.000Z"),
  endAt: new Date("2026-07-01T15:30:00.000Z"),
  clientName: "Jane",
  clientEmail: "jane@example.test",
  tenantName: "Acme",
  clientTimezone: "UTC",
};

// ── The shared wording helper ──────────────────────────────────────
test("wording helper: phone with/without number, custom, and no-op modes", () => {
  assert.deepEqual(appointmentDeliveryWording("phone", "+1 555 0100"), {
    label: "Phone Appointment",
    detail: "We will call you at +1 555 0100.",
  });
  assert.deepEqual(appointmentDeliveryWording("phone", null), {
    label: "Phone Appointment",
    detail: "This appointment is scheduled by phone.",
  });
  assert.deepEqual(appointmentDeliveryWording("custom", "+1 555 0100"), {
    label: "Custom appointment",
    detail: null,
  });
  for (const m of ["virtual", "in_person", null, undefined] as const) {
    assert.deepEqual(appointmentDeliveryWording(m, "+1 555 0100"), { label: null, detail: null });
  }
});

// ── Confirmation render output ─────────────────────────────────────
test("phone confirmation includes 'Phone Appointment' + the client phone", () => {
  const out = renderConfirmation({ ...base, deliveryMode: "phone", clientPhone: "+1 555 0100" });
  assert.match(out.html, /Phone Appointment/);
  assert.match(out.html, /We will call you at \+1 555 0100\./);
  assert.match(out.html, /\+1 555 0100/);
  assert.match(out.text, /Phone Appointment/);
});

test("phone confirmation without a number uses the safe fallback wording", () => {
  const out = renderConfirmation({ ...base, deliveryMode: "phone" });
  assert.match(out.html, /Phone Appointment/);
  assert.match(out.html, /This appointment is scheduled by phone\./);
});

test("BACKWARD COMPAT: legacy (deliveryMode=null) confirmation has NO new wording", () => {
  const out = renderConfirmation({ ...base });
  assert.doesNotMatch(out.html, /Phone Appointment/);
  assert.doesNotMatch(out.html, /Delivery:/);
  assert.doesNotMatch(out.text, /Phone Appointment/);
});

test("virtual confirmation keeps the meeting link and adds NO phone wording", () => {
  const out = renderConfirmation({
    ...base,
    deliveryMode: "virtual",
    videoProvider: "google_meet",
    meetLink: "https://meet.google.com/abc-defg-hij",
  });
  assert.match(out.html, /meet\.google\.com\/abc-defg-hij/); // existing behavior preserved
  assert.doesNotMatch(out.html, /Phone Appointment/);
});

test("in-person confirmation adds NO phone wording", () => {
  const out = renderConfirmation({ ...base, deliveryMode: "in_person", clientPhone: "+1 555 0100" });
  assert.doesNotMatch(out.html, /Phone Appointment/);
  assert.doesNotMatch(out.html, /Delivery:/);
});

// ── The shared helper reaches reschedule / cancel / reminder too ────
test("reschedule / cancellation / reminder all surface the phone branch", () => {
  const phone = { ...base, deliveryMode: "phone", clientPhone: "+1 555 0100" };
  assert.match(renderReschedule(phone).html, /Phone Appointment/);
  assert.match(renderCancellation(phone).html, /Phone Appointment/);
  assert.match(renderReminder(phone, "in 24 hours").html, /Phone Appointment/);
  // …and legacy bookings get none of it.
  assert.doesNotMatch(renderReminder({ ...base }, "in 24 hours").html, /Phone Appointment/);
});

test("custom confirmation shows the simple 'Custom appointment' label", () => {
  const out = renderConfirmation({ ...base, deliveryMode: "custom" });
  assert.match(out.html, /Custom appointment/);
  assert.doesNotMatch(out.html, /Phone Appointment/);
});
