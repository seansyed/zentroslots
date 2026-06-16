import { test } from "node:test";
import assert from "node:assert/strict";

import {
  apptTime,
  apptEndTime,
  apptTimeRange,
  apptDay,
  apptStartMinutes,
  apptTimeWithDay,
  fallbackLabel,
} from "../src/lib/appointmentTime";

/**
 * P0 regression: appointment times showed 7h early because mobile formatted UTC
 * instants with device-local getHours(). The fix renders the SERVER's viewer-tz
 * label verbatim; the only on-device computation is a UTC wall-clock SLICE
 * fallback — deterministic, never device-local. These pin that contract.
 */

// --- server label is rendered verbatim (the authoritative path) ---

test("apptTime returns the server viewer-tz label verbatim", () => {
  // 00:00Z but the server says 5:00 PM (PDT viewer) — we must trust the label,
  // NOT recompute from the instant.
  assert.equal(apptTime({ startAt: "2026-05-17T00:00:00.000Z", startLabel: "5:00 PM" }), "5:00 PM");
});

test("apptTimeRange joins start/end labels with an en-dash", () => {
  const r = apptTimeRange({
    startAt: "2026-05-16T17:00:00.000Z",
    endAt: "2026-05-16T17:30:00.000Z",
    startLabel: "5:00 PM",
    endLabel: "5:30 PM",
  });
  assert.equal(r, "5:00 PM – 5:30 PM");
  assert.ok(r.includes("–")); // en-dash, not hyphen
});

test("apptEndTime is empty when there is no end and no label", () => {
  assert.equal(apptEndTime({ startAt: "2026-05-16T17:00:00.000Z" }), "");
});

test("apptDay returns the server day label verbatim", () => {
  assert.equal(
    apptDay({ startAt: "2026-05-17T00:00:00.000Z", startDayLabel: "Saturday, May 16" }),
    "Saturday, May 16",
  );
});

test("apptTimeWithDay abbreviates the server day label", () => {
  assert.equal(
    apptTimeWithDay({ startAt: "2026-05-17T00:00:00.000Z", startLabel: "5:00 PM", startDayLabel: "Saturday, May 16" }),
    "Sat · 5:00 PM",
  );
});

// --- fallback is a UTC slice, NEVER device-local ---

test("fallbackLabel reads the UTC wall-clock slice (the reported defect)", () => {
  // A UTC-tenant 5 PM appointment stored as 17:00Z. The fallback must read
  // "5:00 PM" from the UTC slice — the old code showed 10:00 AM on a Pacific
  // device. Independent of the machine running the test.
  assert.equal(fallbackLabel("2026-05-16T17:00:00.000Z"), "5:00 PM");
  assert.notEqual(fallbackLabel("2026-05-16T17:00:00.000Z"), "10:00 AM");
});

test("fallbackLabel handles 12-hour boundaries", () => {
  assert.equal(fallbackLabel("2026-05-16T00:30:00.000Z"), "12:30 AM");
  assert.equal(fallbackLabel("2026-05-16T12:00:00.000Z"), "12:00 PM");
  assert.equal(fallbackLabel("2026-05-16T23:45:00.000Z"), "11:45 PM");
});

test("fallbackLabel fails safe to empty string on garbage", () => {
  assert.equal(fallbackLabel("not-a-date"), "");
  assert.equal(fallbackLabel(null), "");
  assert.equal(fallbackLabel(undefined), "");
});

test("apptTime falls back to the UTC slice when no label present", () => {
  assert.equal(apptTime({ startAt: "2026-05-16T17:00:00.000Z" }), "5:00 PM");
});

test("apptDay falls back to the UTC-day weekday when no label present", () => {
  // 2026-05-16 is a Saturday (UTC).
  assert.equal(apptDay({ startAt: "2026-05-16T17:00:00.000Z" }), "Sat, May 16");
});

// --- calendar positioning derives minutes from the SAME label, never getHours ---

test("apptStartMinutes parses minutes-of-day from the viewer-tz label", () => {
  assert.equal(apptStartMinutes({ startAt: "x", startLabel: "5:00 PM" }), 17 * 60);
  assert.equal(apptStartMinutes({ startAt: "x", startLabel: "12:00 AM" }), 0);
  assert.equal(apptStartMinutes({ startAt: "x", startLabel: "12:30 PM" }), 12 * 60 + 30);
  assert.equal(apptStartMinutes({ startAt: "x", startLabel: "9:15 AM" }), 9 * 60 + 15);
});

test("apptStartMinutes uses the UTC slice fallback when no label", () => {
  // 17:00Z → 17:00 viewer-tz fallback → 1020 min. Matches what apptTime renders,
  // so a booking's vertical position lines up with its printed time.
  assert.equal(apptStartMinutes({ startAt: "2026-05-16T17:00:00.000Z" }), 17 * 60);
});

test("apptStartMinutes fails safe to 0 on unparseable input", () => {
  assert.equal(apptStartMinutes({ startAt: "garbage" }), 0);
});
