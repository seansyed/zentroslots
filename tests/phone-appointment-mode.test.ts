/**
 * Phone appointments — first-class delivery mode, data/validation layer
 * (migration 0076). These pin the FOUNDATION contract:
 *
 *   • "phone" and "custom" are valid delivery modes (services + bookings).
 *   • A booking may now carry an optional deliveryMode + clientPhone.
 *   • BACKWARD COMPATIBILITY: every pre-existing public-booking payload (no
 *     deliveryMode / clientPhone) still validates unchanged.
 *   • A phone booking REQUIRES a client phone number (refinement), while
 *     non-phone modes never do.
 *
 * Pure validation tests — no DB. Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deliveryModeSchema,
  serviceSchema,
  createBookingSchema,
  createAppointmentSchema,
} from "../lib/validation";

// A valid public-booking payload as callers send it TODAY (no mode/phone).
const baseBooking = {
  serviceId: "11111111-1111-1111-1111-111111111111",
  staffUserId: "auto" as const,
  startAt: "2026-07-01T15:00:00.000Z",
  clientName: "Jane Doe",
  clientEmail: "jane@example.com",
};

test("deliveryModeSchema accepts the four first-class modes", () => {
  for (const mode of ["in_person", "virtual", "phone", "custom"]) {
    assert.equal(deliveryModeSchema.parse(mode), mode);
  }
  assert.equal(deliveryModeSchema.safeParse("carrier_pigeon").success, false);
});

test("serviceSchema accepts a phone-only service and a 4-mode service", () => {
  const phoneOnly = serviceSchema.parse({
    name: "Phone Consult",
    durationMinutes: 30,
    deliveryModes: ["phone"],
  });
  assert.deepEqual(phoneOnly.deliveryModes, ["phone"]);

  // All four modes at once (max widened from 2 → 4 in 0076).
  const allFour = serviceSchema.parse({
    name: "Flexible Service",
    durationMinutes: 45,
    deliveryModes: ["in_person", "virtual", "phone", "custom"],
  });
  assert.equal(allFour.deliveryModes?.length, 4);
});

test("BACKWARD COMPAT: an existing booking payload (no deliveryMode/phone) still validates", () => {
  const parsed = createBookingSchema.parse(baseBooking);
  assert.equal(parsed.clientEmail, "jane@example.com");
  // The new fields are simply absent — old callers are unaffected.
  assert.equal((parsed as { deliveryMode?: unknown }).deliveryMode, undefined);
  assert.equal((parsed as { clientPhone?: unknown }).clientPhone, undefined);
});

test("a phone booking REQUIRES a client phone number", () => {
  // Missing phone → rejected with a path-targeted error.
  const missing = createBookingSchema.safeParse({ ...baseBooking, deliveryMode: "phone" });
  assert.equal(missing.success, false);
  if (!missing.success) {
    assert.ok(missing.error.issues.some((i) => i.path.includes("clientPhone")));
  }

  // With a phone → accepted, and the values round-trip.
  const ok = createBookingSchema.parse({
    ...baseBooking,
    deliveryMode: "phone",
    clientPhone: "+1 (555) 123-4567",
  });
  assert.equal(ok.deliveryMode, "phone");
  assert.equal(ok.clientPhone, "+1 (555) 123-4567");
});

test("non-phone modes never require a phone number", () => {
  for (const mode of ["in_person", "virtual", "custom"]) {
    const r = createBookingSchema.safeParse({ ...baseBooking, deliveryMode: mode });
    assert.equal(r.success, true, `${mode} should not require a phone`);
  }
});

test("admin appointment schema accepts an optional deliveryMode", () => {
  const r = createAppointmentSchema.safeParse({
    customer: { name: "Acme Co", email: "ops@acme.test", phone: "+15551230000" },
    serviceId: "22222222-2222-2222-2222-222222222222",
    staffUserId: "33333333-3333-3333-3333-333333333333",
    startLocal: "2026-07-01T15:00",
    deliveryMode: "phone",
  });
  assert.equal(r.success, true);
});
