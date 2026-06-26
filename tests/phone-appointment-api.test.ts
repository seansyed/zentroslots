/**
 * Phone appointments — API increment (migration 0076 wiring).
 *
 * Following the repo convention (route DB writes are exercised in the
 * production smoke phase, not against a DB here), these pin the two pure
 * gates the public + admin create endpoints actually run:
 *
 *   • createBookingSchema / createAppointmentSchema — the request validation
 *     the routes call via `.parse(await req.json())`.
 *   • bookingDeliveryFields — the EXACT mapper both route inserts spread into
 *     `db.insert(bookings).values({ ... })`, so asserting on it proves what is
 *     persisted to bookings.delivery_mode / bookings.client_phone.
 *
 * Scenarios a–e from the API increment spec.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createBookingSchema,
  createAppointmentSchema,
  bookingDeliveryFields,
} from "../lib/validation";

// What the public endpoint receives from existing callers today.
const baseBooking = {
  serviceId: "11111111-1111-1111-1111-111111111111",
  staffUserId: "auto" as const,
  startAt: "2026-07-01T15:00:00.000Z",
  clientName: "Jane Doe",
  clientEmail: "jane@example.com",
};

// (a) Existing payload still works with no deliveryMode/clientPhone → persists NULLs.
test("a. existing public booking payload (no deliveryMode/clientPhone) → accepted, persists NULLs", () => {
  const body = createBookingSchema.parse(baseBooking);
  const persisted = bookingDeliveryFields({
    deliveryMode: body.deliveryMode,
    clientPhone: body.clientPhone,
  });
  assert.deepEqual(persisted, { deliveryMode: null, clientPhone: null });
});

// (b) Phone appointment without phone is rejected by the public gate.
test("b. phone appointment without a phone is rejected", () => {
  const r = createBookingSchema.safeParse({ ...baseBooking, deliveryMode: "phone" });
  assert.equal(r.success, false);
  if (!r.success) {
    assert.ok(r.error.issues.some((i) => i.path.includes("clientPhone")));
  }
});

// (c) Phone appointment with phone persists correctly.
test("c. phone appointment with a phone → accepted and persisted", () => {
  const body = createBookingSchema.parse({
    ...baseBooking,
    deliveryMode: "phone",
    clientPhone: "+1 (555) 123-4567",
  });
  const persisted = bookingDeliveryFields({
    deliveryMode: body.deliveryMode,
    clientPhone: body.clientPhone,
  });
  assert.deepEqual(persisted, { deliveryMode: "phone", clientPhone: "+1 (555) 123-4567" });
});

// (d) Non-phone appointment does not require a phone.
test("d. non-phone modes are accepted without a phone", () => {
  for (const mode of ["in_person", "virtual", "custom"] as const) {
    const r = createBookingSchema.safeParse({ ...baseBooking, deliveryMode: mode });
    assert.equal(r.success, true, `${mode} should not require a phone`);
    if (r.success) {
      const persisted = bookingDeliveryFields({
        deliveryMode: r.data.deliveryMode,
        clientPhone: r.data.clientPhone,
      });
      assert.deepEqual(persisted, { deliveryMode: mode, clientPhone: null });
    }
  }
});

// (e) Admin-created appointment can persist deliveryMode/clientPhone (and the
//     phone falls back to the quick-created customer's phone when omitted).
test("e. admin appointment persists deliveryMode/clientPhone (explicit + customer fallback)", () => {
  const explicit = createAppointmentSchema.parse({
    customer: { name: "Acme Co", email: "ops@acme.test", phone: "+15550000000" },
    serviceId: "22222222-2222-2222-2222-222222222222",
    staffUserId: "33333333-3333-3333-3333-333333333333",
    startLocal: "2026-07-01T15:00",
    deliveryMode: "phone",
    clientPhone: "+15551112222",
  });
  assert.deepEqual(
    bookingDeliveryFields({
      deliveryMode: explicit.deliveryMode,
      clientPhone: explicit.clientPhone,
      fallbackPhone: explicit.customer?.phone,
    }),
    { deliveryMode: "phone", clientPhone: "+15551112222" },
  );

  // No explicit clientPhone → falls back to the quick-created customer's phone.
  const fallback = createAppointmentSchema.parse({
    customer: { name: "Acme Co", email: "ops@acme.test", phone: "+15550000000" },
    serviceId: "22222222-2222-2222-2222-222222222222",
    staffUserId: "33333333-3333-3333-3333-333333333333",
    startLocal: "2026-07-01T15:00",
    deliveryMode: "phone",
  });
  assert.deepEqual(
    bookingDeliveryFields({
      deliveryMode: fallback.deliveryMode,
      clientPhone: fallback.clientPhone,
      fallbackPhone: fallback.customer?.phone,
    }),
    { deliveryMode: "phone", clientPhone: "+15550000000" },
  );

  // Admin create stays backward compatible: omit mode entirely → NULLs.
  const legacy = createAppointmentSchema.parse({
    customer: { name: "Acme Co", email: "ops@acme.test" },
    serviceId: "22222222-2222-2222-2222-222222222222",
    staffUserId: "33333333-3333-3333-3333-333333333333",
    startLocal: "2026-07-01T15:00",
  });
  assert.deepEqual(
    bookingDeliveryFields({
      deliveryMode: legacy.deliveryMode,
      clientPhone: legacy.clientPhone,
      fallbackPhone: legacy.customer?.phone,
    }),
    { deliveryMode: null, clientPhone: null },
  );
});
