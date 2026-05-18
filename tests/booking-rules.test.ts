/**
 * Unit tests for the pure parts of lib/booking-rules.
 *
 * The orchestrator (validateBookingRules) touches DB and is exercised
 * in the production smoke phase. Here we cover blackout matching +
 * the time-window math (notice/advance/business-hours) factored through
 * checkBlackoutDate + dateInTimezone.
 *
 * The deeper validator tests (concurrent caps, per-customer counts,
 * cooldown gap) require a live DB and are part of the smoke phase —
 * unit coverage is for the deterministic predicates that can break
 * silently without a fixture booking DB.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkBlackoutDate,
  dateInTimezone,
} from "../lib/booking-rules/blackoutDates";

describe("booking-rules: checkBlackoutDate", () => {
  it("returns null on empty / non-array input", () => {
    assert.equal(
      checkBlackoutDate({ bookingDate: "2026-12-25", blackoutDates: [] }),
      null
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(checkBlackoutDate({ bookingDate: "2026-12-25", blackoutDates: null as any }), null);
  });

  it("returns the matched date on hit", () => {
    assert.equal(
      checkBlackoutDate({
        bookingDate: "2026-12-25",
        blackoutDates: ["2026-11-26", "2026-12-25", "2027-01-01"],
      }),
      "2026-12-25"
    );
  });

  it("returns null when no entry matches", () => {
    assert.equal(
      checkBlackoutDate({
        bookingDate: "2026-12-26",
        blackoutDates: ["2026-12-25", "2027-01-01"],
      }),
      null
    );
  });

  it("trims whitespace in admin-pasted entries", () => {
    assert.equal(
      checkBlackoutDate({
        bookingDate: "2026-12-25",
        blackoutDates: ["  2026-12-25  "],
      }),
      "2026-12-25"
    );
  });

  it("ignores non-string entries (defense against corrupt jsonb)", () => {
    assert.equal(
      checkBlackoutDate({
        bookingDate: "2026-12-25",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        blackoutDates: [123 as any, null as any, "2026-12-25"],
      }),
      "2026-12-25"
    );
  });
});

describe("booking-rules: dateInTimezone", () => {
  it("formats UTC midnight in UTC as the same date", () => {
    assert.equal(
      dateInTimezone(new Date("2026-12-25T00:00:00Z"), "UTC"),
      "2026-12-25"
    );
  });

  it("formats Tokyo evening in UTC vs Tokyo correctly", () => {
    // 2026-12-25T15:00Z is 2026-12-26 00:00 in Tokyo (UTC+9).
    const at = new Date("2026-12-25T15:00:00Z");
    assert.equal(dateInTimezone(at, "UTC"), "2026-12-25");
    assert.equal(dateInTimezone(at, "Asia/Tokyo"), "2026-12-26");
  });

  it("formats LA morning correctly", () => {
    // 2026-12-25T07:00Z is 2026-12-24 23:00 in LA (UTC-8).
    const at = new Date("2026-12-25T07:00:00Z");
    assert.equal(dateInTimezone(at, "America/Los_Angeles"), "2026-12-24");
  });

  it("handles a year boundary in TZ correctly", () => {
    // 2026-01-01T02:00Z = 2025-12-31 in LA.
    const at = new Date("2026-01-01T02:00:00Z");
    assert.equal(dateInTimezone(at, "America/Los_Angeles"), "2025-12-31");
  });
});
