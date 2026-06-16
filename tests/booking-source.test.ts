/**
 * P0 regression: mobile-created (authenticated operator) appointments were
 * auto-cancelled because POST /api/bookings dropped paid services into a
 * pending_payment hold that the holds:expire cron then cancelled.
 *
 * The fix gates the paid/hold path on `isInternalOperatorBooking(session,
 * service.tenantId)` — SERVER-DERIVED authority. These tests pin that contract:
 * an authenticated tenant user of the service's tenant = internal (no hold);
 * anonymous public / cross-tenant = not internal (keeps checkout + hold). The
 * predicate takes no client-supplied flag, so an internal booking can't be
 * spoofed by the request body.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isInternalOperatorBooking } from "../lib/auth";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";

function session(tenantId: string, role = "staff") {
  return { sub: "user-1", role: role as never, tenantId };
}

test("authenticated tenant user of the service's tenant = internal operator (no payment hold)", () => {
  assert.equal(isInternalOperatorBooking(session(TENANT, "admin"), TENANT), true);
  assert.equal(isInternalOperatorBooking(session(TENANT, "manager"), TENANT), true);
  assert.equal(isInternalOperatorBooking(session(TENANT, "staff"), TENANT), true);
});

test("anonymous public caller (no session) = NOT internal → keeps checkout/hold path", () => {
  assert.equal(isInternalOperatorBooking(null, TENANT), false);
});

test("cross-tenant session = NOT internal (can't bypass payment on another tenant)", () => {
  assert.equal(isInternalOperatorBooking(session(OTHER_TENANT), TENANT), false);
});

test("SECURITY: the external 'client' role does NOT bypass payment, even same-tenant", () => {
  // A logged-in customer (role 'client') must keep the public checkout/hold
  // path — otherwise they could self-confirm a paid booking without paying.
  assert.equal(isInternalOperatorBooking(session(TENANT, "client"), TENANT), false);
});

test("authority is session-derived only — there is no client flag parameter to spoof", () => {
  // The function's inputs are the verified session + the service tenant id.
  // A request body cannot influence the result.
  assert.equal(isInternalOperatorBooking.length, 2);
  // Same session + service-tenant always yields the same answer regardless of
  // any (ignored) request content.
  assert.equal(isInternalOperatorBooking(session(TENANT), TENANT), true);
  assert.equal(isInternalOperatorBooking(session(OTHER_TENANT), TENANT), false);
});
