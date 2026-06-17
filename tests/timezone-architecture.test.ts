/**
 * Run: npm test
 *
 * P0 — business-timezone architecture. Locks the two halves of the fix:
 *   (1) INTERPRETATION: an operator's wall-clock ("3 PM") is converted to UTC
 *       in the BUSINESS timezone (fromZonedTime), not the browser tz — so
 *       scenarios A/B/C store the correct instant.
 *   (2) DISPLAY: the canonical business-tz resolver (preferTimezone) never
 *       silently yields "UTC" when a real zone is available, and the stored
 *       instant renders back to the original wall-clock for that zone.
 *
 * Regression pinned: a 3 PM PDT booking stored as 22:00 UTC was rendered in
 * "UTC" → "10:00 PM".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fromZonedTime } from "date-fns-tz";

import { buildBookingLabels } from "../lib/appointment-labels";
import { preferTimezone, isRealTimezone } from "../lib/tenant-timezone";

const LA = "America/Los_Angeles";
const NY = "America/New_York";

describe("interpretation — operator wall-clock → UTC in the business tz", () => {
  it("3 PM in California stores as 22:00 UTC (PDT, summer)", () => {
    assert.equal(fromZonedTime("2026-06-20T15:00", LA).toISOString(), "2026-06-20T22:00:00.000Z");
  });
  it("3 PM in New York stores as 19:00 UTC (EDT, summer)", () => {
    assert.equal(fromZonedTime("2026-06-20T15:00", NY).toISOString(), "2026-06-20T19:00:00.000Z");
  });
  it("the SAME wall-clock yields DIFFERENT instants per business tz (browser tz irrelevant)", () => {
    const ca = fromZonedTime("2026-06-20T15:00", LA).getTime();
    const ny = fromZonedTime("2026-06-20T15:00", NY).getTime();
    assert.notEqual(ca, ny);
    assert.equal((ca - ny) / 3_600_000, 3); // CA is 3h behind NY → later UTC
  });
  it("honors DST (PST winter = -8, 23:00 UTC)", () => {
    assert.equal(fromZonedTime("2026-01-20T15:00", LA).toISOString(), "2026-01-20T23:00:00.000Z");
  });
});

describe("preferTimezone / isRealTimezone — no silent UTC when a real zone exists", () => {
  it("isRealTimezone rejects UTC / empty / null", () => {
    assert.equal(isRealTimezone(LA), true);
    assert.equal(isRealTimezone("UTC"), false);
    assert.equal(isRealTimezone(""), false);
    assert.equal(isRealTimezone(null), false);
    assert.equal(isRealTimezone(undefined), false);
  });
  it("picks the first real zone, skipping UTC/empty", () => {
    assert.equal(preferTimezone("UTC", LA), LA);
    assert.equal(preferTimezone(null, "UTC", NY), NY);
    assert.equal(preferTimezone(LA, NY), LA);
  });
  it("falls back to UTC only when nothing real is provided", () => {
    assert.equal(preferTimezone("UTC", null, undefined, ""), "UTC");
    assert.equal(preferTimezone(), "UTC");
  });
});

describe("display — stored instant renders back to the original wall-clock", () => {
  it("reproduces the bug: 22:00 UTC shown in UTC = 10:00 PM", () => {
    assert.equal(buildBookingLabels("2026-06-20T22:00:00Z", "2026-06-20T22:30:00Z", "UTC").startLabel, "10:00 PM");
  });
  it("fixed: 22:00 UTC shown in the business tz (PT) = 3:00 PM", () => {
    assert.equal(buildBookingLabels("2026-06-20T22:00:00Z", "2026-06-20T22:30:00Z", LA).startLabel, "3:00 PM");
  });
  it("round-trip A (CA business): book 3 PM → store → display 3 PM PT", () => {
    const utc = fromZonedTime("2026-06-20T15:00", LA);
    const labels = buildBookingLabels(utc, new Date(utc.getTime() + 1800_000), LA);
    assert.equal(labels.startLabel, "3:00 PM");
    assert.equal(labels.tzAbbrev, "PDT");
  });
  it("round-trip C (NY business): book 3 PM ET → CA client sees 12 PM PT", () => {
    const utc = fromZonedTime("2026-06-20T15:00", NY); // 19:00 UTC
    assert.equal(buildBookingLabels(utc, utc, LA).startLabel, "12:00 PM"); // client in PT
    assert.equal(buildBookingLabels(utc, utc, NY).startLabel, "3:00 PM"); // operator in ET
  });
});
