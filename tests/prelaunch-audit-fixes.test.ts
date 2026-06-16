/**
 * Regression tests for the pre-launch audit remediation (emails + push tz).
 *
 * Covers:
 *  - The new `appointment_timezone` template variable renders (whitelist + renderer).
 *  - The push notification time formatter labels absolute (>24h) times in the
 *    staff timezone (never an unlabeled server-local time) and keeps the
 *    relative branch for near-term bookings — the same tz contract as the
 *    appointment-time fix.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderVariables, SUPPORTED_VARIABLES } from "../lib/communications/variables";
import { formatRelativeBrief } from "../lib/push/enqueue";

// --- email: appointment_timezone variable ---

test("appointment_timezone is a supported template variable", () => {
  assert.ok(SUPPORTED_VARIABLES.includes("appointment_timezone"));
});

test("renderVariables substitutes appointment_time + appointment_timezone together", () => {
  const out = renderVariables("Your visit is at {{appointment_time}} {{appointment_timezone}}", {
    appointment_time: "5:00 PM",
    appointment_timezone: "PDT",
  });
  assert.equal(out, "Your visit is at 5:00 PM PDT");
});

test("renderVariables drops unknown variables (whitelist still closed)", () => {
  const out = renderVariables("{{appointment_timezone}}|{{not_a_real_var}}", {
    appointment_timezone: "EST",
  });
  // unknown var renders empty; known one renders
  assert.equal(out, "EST|");
});

// --- push: absolute time is labeled + in the staff timezone ---

test("push time >24h out is an ABSOLUTE staff-tz time with an explicit tz label", () => {
  // 30 days out → absolute branch. America/Los_Angeles → contains PDT/PST.
  const far = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const s = formatRelativeBrief(far, "America/Los_Angeles");
  assert.match(s, /\b(PST|PDT)\b/, `expected a Pacific tz label, got "${s}"`);
  assert.doesNotMatch(s, /\dT\d|Z$/, "must not be a raw ISO/UTC string");
});

test("push time >24h out in UTC viewer shows a UTC label", () => {
  const far = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const s = formatRelativeBrief(far, "UTC");
  assert.match(s, /\b(UTC|GMT)\b/, `expected a UTC/GMT label, got "${s}"`);
});

test("push time <24h out stays relative (tz-agnostic), no absolute leak", () => {
  const soon = new Date(Date.now() + 3 * 60 * 60 * 1000); // 3h
  const s = formatRelativeBrief(soon, "America/New_York");
  assert.match(s, /^in \d+h$/, `expected 'in Nh', got "${s}"`);
});

test("push time <60m out is minutes", () => {
  const veryProx = new Date(Date.now() + 20 * 60 * 1000);
  const s = formatRelativeBrief(veryProx, "UTC");
  assert.match(s, /^\d+m$/, `expected 'Nm', got "${s}"`);
});

test("push time falls back to UTC label on a garbage tz (never throws)", () => {
  const far = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  const s = formatRelativeBrief(far, "Not/AZone");
  assert.match(s, /\b(UTC|GMT)\b/, `expected UTC fallback label, got "${s}"`);
});
