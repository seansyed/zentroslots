import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addDays,
  addMonths,
  dayLabel,
  isoDateLocal,
  isBeforeDay,
  isSameDay,
  isSameMonth,
  monthLabel,
  monthMatrix,
  startOfMonth,
  weekdayLabels,
} from "../src/lib/dates";

// Regression coverage for the New-Booking date engine. isoDateLocal is the
// Hermes-safe replacement for the buggy Intl.DateTimeFormat({timeZone}) path
// that sent the wrong day (previous day for operators east of UTC).

test("isoDateLocal formats LOCAL components (no UTC/Intl shift)", () => {
  // A date constructed from local components must round-trip exactly,
  // regardless of the runner's timezone (the old toISOString path failed this).
  assert.equal(isoDateLocal(new Date(2026, 5, 20)), "2026-06-20"); // month is 0-based
  assert.equal(isoDateLocal(new Date(2026, 0, 1)), "2026-01-01");
  assert.equal(isoDateLocal(new Date(2026, 11, 31)), "2026-12-31");
});

test("addDays / addMonths navigate without drift", () => {
  assert.equal(isoDateLocal(addDays(new Date(2026, 5, 28), 5)), "2026-07-03"); // month boundary
  assert.equal(isoDateLocal(addDays(new Date(2026, 11, 31), 1)), "2027-01-01"); // year boundary
  assert.equal(isoDateLocal(addMonths(new Date(2026, 0, 15), 1)), "2026-02-01"); // anchors to 1st
  assert.equal(isoDateLocal(addMonths(new Date(2026, 11, 10), 1)), "2027-01-01"); // year boundary
});

test("startOfMonth anchors to the 1st", () => {
  assert.equal(isoDateLocal(startOfMonth(new Date(2026, 5, 20))), "2026-06-01");
});

test("isSameDay / isSameMonth / isBeforeDay", () => {
  assert.ok(isSameDay(new Date(2026, 5, 20, 9), new Date(2026, 5, 20, 23)));
  assert.ok(!isSameDay(new Date(2026, 5, 20), new Date(2026, 5, 21)));
  assert.ok(isSameMonth(new Date(2026, 5, 1), new Date(2026, 5, 30)));
  assert.ok(isBeforeDay(new Date(2026, 5, 19), new Date(2026, 5, 20)));
  assert.ok(!isBeforeDay(new Date(2026, 5, 20), new Date(2026, 5, 20))); // same day not "before"
});

test("monthMatrix is always 6 full weeks and marks the focal month", () => {
  const weeks = monthMatrix(new Date(2026, 5, 1), 0); // June 2026, Sunday-start
  assert.equal(weeks.length, 6);
  for (const w of weeks) assert.equal(w.length, 7);
  // June 1 2026 is a Monday → first cell (Sunday) is May 31, out of month.
  assert.equal(isoDateLocal(weeks[0][0].date), "2026-05-31");
  assert.equal(weeks[0][0].inMonth, false);
  // The focal month's days are flagged inMonth.
  const allInMonth = weeks.flat().filter((c) => c.inMonth).map((c) => c.date.getDate());
  assert.equal(Math.min(...allInMonth), 1);
  assert.equal(Math.max(...allInMonth), 30); // June has 30 days
});

test("weekStartsOn shifts the grid + labels", () => {
  assert.deepEqual(weekdayLabels(1), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  const weeks = monthMatrix(new Date(2026, 5, 1), 1); // Monday-start
  // June 1 2026 is Monday → with Monday-start it's the first cell.
  assert.equal(isoDateLocal(weeks[0][0].date), "2026-06-01");
  assert.equal(weeks[0][0].inMonth, true);
});

test("labels are Hermes-safe manual strings", () => {
  assert.equal(monthLabel(new Date(2026, 5, 1)), "June 2026");
  assert.equal(dayLabel(new Date(2026, 5, 20)), "Saturday, Jun 20");
});
