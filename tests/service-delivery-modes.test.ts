/**
 * Service editor — delivery-mode persistence contract (phone-appointment work).
 *
 * The Service editor UI lets an admin pick which delivery modes a service
 * supports (In-person, Video/Virtual, Phone, Custom). These pin that the two
 * validation gates the editor's save paths run accept all four — and that they
 * stay backward compatible with existing services:
 *
 *   • serviceSchema.deliveryModes        — POST /api/services (create)
 *   • serviceDeliveryModesSchema         — PATCH /api/services/[id] (edit)
 *   • readServiceDeliveryModes           — normalizes the stored array
 *
 * Pure validation — no DB. Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deliveryModeSchema, serviceSchema } from "../lib/validation";
import {
  serviceDeliveryModesSchema,
  readServiceDeliveryModes,
} from "../lib/workforce-location";

const ALL = ["in_person", "virtual", "phone", "custom"] as const;

test("deliveryModeSchema (single source) accepts the four modes, rejects others", () => {
  for (const m of ALL) assert.equal(deliveryModeSchema.parse(m), m);
  assert.equal(deliveryModeSchema.safeParse("sms").success, false);
});

test("POST gate (serviceSchema) accepts each mode individually and all four", () => {
  for (const m of ALL) {
    const r = serviceSchema.parse({ name: "S", durationMinutes: 30, deliveryModes: [m] });
    assert.deepEqual(r.deliveryModes, [m]);
  }
  const all = serviceSchema.parse({
    name: "Flexible",
    durationMinutes: 30,
    deliveryModes: [...ALL],
  });
  assert.equal(all.deliveryModes?.length, 4);
  // Unknown mode rejected; empty array rejected (min 1).
  assert.equal(
    serviceSchema.safeParse({ name: "S", durationMinutes: 30, deliveryModes: ["fax"] }).success,
    false,
  );
  assert.equal(
    serviceSchema.safeParse({ name: "S", durationMinutes: 30, deliveryModes: [] }).success,
    false,
  );
});

test("PATCH gate (serviceDeliveryModesSchema) accepts the four modes incl. phone/custom", () => {
  for (const m of ALL) assert.equal(serviceDeliveryModesSchema.safeParse([m]).success, true);
  assert.equal(serviceDeliveryModesSchema.safeParse([...ALL]).success, true);
  assert.equal(serviceDeliveryModesSchema.safeParse(["phone", "custom"]).success, true);
  // Still rejects unknown values and the empty array (min 1).
  assert.equal(serviceDeliveryModesSchema.safeParse(["telegram"]).success, false);
  assert.equal(serviceDeliveryModesSchema.safeParse([]).success, false);
});

test("BACKWARD COMPAT: existing virtual/in_person services still validate everywhere", () => {
  assert.equal(serviceDeliveryModesSchema.safeParse(["virtual"]).success, true);
  assert.equal(serviceDeliveryModesSchema.safeParse(["in_person", "virtual"]).success, true);
  assert.equal(
    serviceSchema.safeParse({ name: "Legacy", durationMinutes: 30, deliveryModes: ["virtual", "in_person"] }).success,
    true,
  );
  // A service that omits deliveryModes entirely is still valid (DB default applies).
  assert.equal(serviceSchema.safeParse({ name: "Legacy", durationMinutes: 30 }).success, true);
});

test("readServiceDeliveryModes preserves phone/custom and falls back safely", () => {
  assert.deepEqual(readServiceDeliveryModes(["phone"]), ["phone"]);
  assert.deepEqual(readServiceDeliveryModes(["in_person", "virtual", "phone", "custom"]).sort(), [
    "custom",
    "in_person",
    "phone",
    "virtual",
  ]);
  // Empty / non-array / all-invalid → the historical default (both base modes).
  assert.deepEqual(readServiceDeliveryModes([]), ["virtual", "in_person"]);
  assert.deepEqual(readServiceDeliveryModes(null), ["virtual", "in_person"]);
  assert.deepEqual(readServiceDeliveryModes(["junk"]), ["virtual", "in_person"]);
});
