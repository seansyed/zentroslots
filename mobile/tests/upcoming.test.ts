import { test } from "node:test";
import assert from "node:assert/strict";

import { selectUpcoming } from "../src/lib/upcoming";
import type { Appointment } from "../src/api/appointments";

// Minimal Appointment factory — only the fields selectUpcoming reads matter.
function appt(over: Partial<Appointment> & { id: string; startAt: string; status: Appointment["status"] }): Appointment {
  return {
    serviceName: "Service",
    staffName: "Staff",
    clientName: "Client",
    clientEmail: "c@e.com",
    endAt: over.startAt,
    ...over,
  } as Appointment;
}

const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

test("includes today's future confirmed booking; excludes past, cancelled, completed", () => {
  const rows: Appointment[] = [
    appt({ id: "soon", startAt: iso(NOW + 60 * 60_000), status: "confirmed" }),      // +1h ✓
    appt({ id: "past", startAt: iso(NOW - 60 * 60_000), status: "confirmed" }),      // -1h ✗ past
    appt({ id: "cancelled", startAt: iso(NOW + 2 * 60 * 60_000), status: "cancelled" }), // ✗ cancelled
    appt({ id: "completed", startAt: iso(NOW + 3 * 60 * 60_000), status: "completed" }), // ✗ completed
    appt({ id: "noshow", startAt: iso(NOW + 4 * 60 * 60_000), status: "no_show" }),   // ✗ no_show
    appt({ id: "pending", startAt: iso(NOW + 90 * 60_000), status: "pending" }),      // +90m ✓ pending counts
  ];
  const out = selectUpcoming(rows, NOW, 5);
  assert.deepEqual(out.map((r) => r.id), ["soon", "pending"]);
});

test("REGRESSION: a future pending_payment booking (~15h out) IS upcoming; payment_failed/refunded are not", () => {
  const rows: Appointment[] = [
    // The reported case: Rashid Kazi, pending_payment, ~15h ahead — must show.
    appt({ id: "rashid", startAt: iso(NOW + 15 * 60 * 60_000), status: "pending_payment" }),
    appt({ id: "failed", startAt: iso(NOW + 16 * 60 * 60_000), status: "payment_failed" }), // terminal ✗
    appt({ id: "refunded", startAt: iso(NOW + 17 * 60 * 60_000), status: "refunded" }),      // terminal ✗
    appt({ id: "confirmed", startAt: iso(NOW + 18 * 60 * 60_000), status: "confirmed" }),    // ✓
  ];
  assert.deepEqual(selectUpcoming(rows, NOW, 5).map((r) => r.id), ["rashid", "confirmed"]);
});

test("sorts ascending (soonest first) and slices to count", () => {
  const rows: Appointment[] = [
    appt({ id: "d3", startAt: iso(NOW + 3 * 86_400_000), status: "confirmed" }),
    appt({ id: "d1", startAt: iso(NOW + 1 * 86_400_000), status: "confirmed" }),
    appt({ id: "d2", startAt: iso(NOW + 2 * 86_400_000), status: "confirmed" }),
    appt({ id: "d4", startAt: iso(NOW + 4 * 86_400_000), status: "confirmed" }),
  ];
  assert.deepEqual(selectUpcoming(rows, NOW, 3).map((r) => r.id), ["d1", "d2", "d3"]);
});

test("a booking 40 days out is still upcoming (no near-term clip)", () => {
  const rows: Appointment[] = [appt({ id: "far", startAt: iso(NOW + 40 * 86_400_000), status: "confirmed" })];
  assert.deepEqual(selectUpcoming(rows, NOW, 3).map((r) => r.id), ["far"]);
});

test("boundary: startAt exactly == now is included; now-1ms is excluded (epoch, tz-agnostic)", () => {
  const rows: Appointment[] = [
    appt({ id: "eq", startAt: iso(NOW), status: "confirmed" }),
    appt({ id: "justpast", startAt: iso(NOW - 1), status: "confirmed" }),
  ];
  assert.deepEqual(selectUpcoming(rows, NOW, 5).map((r) => r.id), ["eq"]);
});

test("empty input yields empty output", () => {
  assert.deepEqual(selectUpcoming([], NOW, 3), []);
});
