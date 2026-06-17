import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveStatsFromHistory } from "../src/lib/customerStats";

type CustomerHistoryItem = { id: string; startAt: string; endAt: string; status: string };

/**
 * P0 regression: the customer DETAIL endpoint returns { customer, history }
 * without per-customer aggregates (those exist only on the LIST route), so the
 * detail Stats card showed blank Total/Completed/Cancelled + "Never". The fix
 * derives them from the returned bookingHistory, matching the list route's
 * semantics: total=COUNT(*), completed/cancelled=status counts,
 * lastAppointmentAt=MAX(startAt).
 */

function h(over: Partial<CustomerHistoryItem> & { id: string; startAt: string; status: string }): CustomerHistoryItem {
  return { endAt: over.startAt, ...over } as CustomerHistoryItem;
}

test("counts total / completed / cancelled and the latest startAt", () => {
  const history = [
    h({ id: "1", startAt: "2026-05-01T17:00:00.000Z", status: "completed" }),
    h({ id: "2", startAt: "2026-06-10T15:00:00.000Z", status: "cancelled" }),
    h({ id: "3", startAt: "2026-06-20T18:30:00.000Z", status: "confirmed" }),
    h({ id: "4", startAt: "2026-04-15T09:00:00.000Z", status: "completed" }),
    h({ id: "5", startAt: "2026-06-12T12:00:00.000Z", status: "no_show" }),
  ];
  const s = deriveStatsFromHistory(history);
  assert.equal(s.totalBookings, 5);
  assert.equal(s.completed, 2);
  assert.equal(s.cancelled, 1);
  // MAX(startAt) — the chronologically latest, regardless of array order.
  assert.equal(s.lastAppointmentAt, "2026-06-20T18:30:00.000Z");
});

test("empty history → zeros + null (renders as 'Never')", () => {
  const s = deriveStatsFromHistory([]);
  assert.deepEqual(s, { totalBookings: 0, completed: 0, cancelled: 0, lastAppointmentAt: null });
});

test("a single booking is counted and is the last interaction", () => {
  const s = deriveStatsFromHistory([h({ id: "1", startAt: "2026-06-16T17:00:00.000Z", status: "completed" })]);
  assert.equal(s.totalBookings, 1);
  assert.equal(s.completed, 1);
  assert.equal(s.cancelled, 0);
  assert.equal(s.lastAppointmentAt, "2026-06-16T17:00:00.000Z");
});

test("lastAppointmentAt is the MAX even when input is unsorted/descending", () => {
  const s = deriveStatsFromHistory([
    h({ id: "1", startAt: "2026-07-01T00:00:00.000Z", status: "pending" }),
    h({ id: "2", startAt: "2026-01-01T00:00:00.000Z", status: "completed" }),
  ]);
  assert.equal(s.lastAppointmentAt, "2026-07-01T00:00:00.000Z");
});
