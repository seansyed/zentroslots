/**
 * P0 regression: appointment times rendered 7h early on mobile because mobile
 * formatted UTC instants with device-local getHours(). The fix formats them
 * SERVER-SIDE in the signed-in VIEWER's timezone (same rule as the web). These
 * pin buildBookingLabels across the timezone matrix + DST + the exact defect.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildBookingLabels } from "../lib/appointment-labels";

test("the exact defect: a 5 PM appointment in a UTC tenant labels as 5:00 PM (NOT 10:00 AM)", () => {
  // Stored 17:00Z; viewer tz UTC (the reported tenant) → 5:00 PM. The old mobile
  // code on a Pacific device showed 10:00 AM (device tz) — never via this path.
  const l = buildBookingLabels("2026-05-16T17:00:00.000Z", "2026-05-16T17:30:00.000Z", "UTC");
  assert.equal(l.startLabel, "5:00 PM");
  assert.equal(l.endLabel, "5:30 PM");
  assert.notEqual(l.startLabel, "10:00 AM");
});

test("5 PM Pacific (PDT) appointment == 00:00Z next day → 5:00 PM, Saturday May 16", () => {
  const l = buildBookingLabels("2026-05-17T00:00:00.000Z", "2026-05-17T00:30:00.000Z", "America/Los_Angeles");
  assert.equal(l.startLabel, "5:00 PM");
  assert.equal(l.startDayLabel, "Saturday, May 16"); // date-rollover safe (still May 16 in PDT)
  assert.equal(l.tzAbbrev, "PDT");
});

test("timezone matrix: 17:00Z renders correctly per viewer tz", () => {
  const s = "2026-05-16T17:00:00.000Z";
  const e = "2026-05-16T17:30:00.000Z";
  assert.equal(buildBookingLabels(s, e, "America/Los_Angeles").startLabel, "10:00 AM"); // PDT -7
  assert.equal(buildBookingLabels(s, e, "America/Denver").startLabel, "11:00 AM");      // MDT -6
  assert.equal(buildBookingLabels(s, e, "America/Chicago").startLabel, "12:00 PM");     // CDT -5
  assert.equal(buildBookingLabels(s, e, "America/New_York").startLabel, "1:00 PM");     // EDT -4
  assert.equal(buildBookingLabels(s, e, "Europe/London").startLabel, "6:00 PM");        // BST +1
  assert.equal(buildBookingLabels(s, e, "Asia/Kolkata").startLabel, "10:30 PM");        // +5:30
  // Australia/Sydney +10 (May = AEST) → next day 3:00 AM
  const syd = buildBookingLabels(s, e, "Australia/Sydney");
  assert.equal(syd.startLabel, "3:00 AM");
  assert.equal(syd.startDayLabel, "Sunday, May 17");
});

test("DST: same wall-clock tenant zone, summer (PDT) vs winter (PST)", () => {
  // 17:00Z in America/Los_Angeles: summer PDT (-7) = 10:00 AM; winter PST (-8) = 9:00 AM.
  assert.equal(buildBookingLabels("2026-07-15T17:00:00.000Z", "2026-07-15T17:30:00.000Z", "America/Los_Angeles").startLabel, "10:00 AM");
  assert.equal(buildBookingLabels("2026-01-15T17:00:00.000Z", "2026-01-15T17:30:00.000Z", "America/Los_Angeles").startLabel, "9:00 AM");
  assert.equal(buildBookingLabels("2026-07-15T17:00:00.000Z", "2026-07-15T17:30:00.000Z", "America/Los_Angeles").tzAbbrev, "PDT");
  assert.equal(buildBookingLabels("2026-01-15T17:00:00.000Z", "2026-01-15T17:30:00.000Z", "America/Los_Angeles").tzAbbrev, "PST");
});

test("invalid / empty tz falls back to UTC and never throws", () => {
  const bad = buildBookingLabels("2026-05-16T17:00:00.000Z", "2026-05-16T17:30:00.000Z", "Not/AZone");
  assert.equal(bad.timezone, "UTC");
  assert.equal(bad.startLabel, "5:00 PM");
  const empty = buildBookingLabels("2026-05-16T17:00:00.000Z", "2026-05-16T17:30:00.000Z", "");
  assert.equal(empty.timezone, "UTC");
  assert.equal(empty.startLabel, "5:00 PM");
});
