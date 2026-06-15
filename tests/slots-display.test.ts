/**
 * P0 booking-integrity regression: slot TIME labels must be formatted in the
 * AUTHORITATIVE timezone (server-side), never the device timezone. The mobile
 * bug rendered UTC slot instants with the phone's local clock, so a 9 AM slot
 * appeared as ~1–2 AM. These tests pin the server-side contract that fixes it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSlotDisplay, formatSlotLabel } from "../lib/slots-display";

test("a 9 AM working slot labels as 9:00 AM in its tenant timezone", () => {
  // 9:00 AM America/New_York in winter (EST, UTC-5) == 14:00 UTC.
  assert.equal(formatSlotLabel("2026-01-15T14:00:00.000Z", "America/New_York"), "9:00 AM");
  // Last 15-min slot before a 6:00 PM close == 17:45 EST == 22:45 UTC.
  assert.equal(formatSlotLabel("2026-01-15T22:45:00.000Z", "America/New_York"), "5:45 PM");
  // 3:15 PM is valid + labels correctly (20:15 UTC EST).
  assert.equal(formatSlotLabel("2026-01-15T20:15:00.000Z", "America/New_York"), "3:15 PM");
});

test("THE BUG: device-tz vs authoritative-tz give different labels for one instant", () => {
  // A Google-OAuth user defaults to timezone 'UTC', so 9 AM is stored as
  // 09:00Z. Formatted in the AUTHORITATIVE tz (UTC) it is correct...
  assert.equal(formatSlotLabel("2026-01-15T09:00:00.000Z", "UTC"), "9:00 AM");
  // ...but the OLD mobile code formatted in the DEVICE tz; on a US-Pacific
  // phone (PST, UTC-8) the same instant reads 1:00 AM — the defect. The fix
  // forces the authoritative tz, so this wrong value is never displayed.
  assert.equal(formatSlotLabel("2026-01-15T09:00:00.000Z", "America/Los_Angeles"), "1:00 AM");
  assert.notEqual(
    formatSlotLabel("2026-01-15T09:00:00.000Z", "UTC"),
    formatSlotLabel("2026-01-15T09:00:00.000Z", "America/Los_Angeles"),
  );
});

test("east-of-UTC and west-of-UTC tenants both label 9 AM correctly", () => {
  // Asia/Kolkata UTC+5:30 → 9:00 AM == 03:30 UTC.
  assert.equal(formatSlotLabel("2026-01-15T03:30:00.000Z", "Asia/Kolkata"), "9:00 AM");
  // America/Los_Angeles UTC-8 (winter) → 9:00 AM == 17:00 UTC.
  assert.equal(formatSlotLabel("2026-01-15T17:00:00.000Z", "America/Los_Angeles"), "9:00 AM");
});

test("DST-safe: 9 AM maps to the right instant on both sides of spring-forward", () => {
  // Winter (EST, UTC-5): 9 AM == 14:00 UTC.
  assert.equal(formatSlotLabel("2026-01-15T14:00:00.000Z", "America/New_York"), "9:00 AM");
  // Summer after spring-forward (EDT, UTC-4): 9 AM == 13:00 UTC.
  assert.equal(formatSlotLabel("2026-07-15T13:00:00.000Z", "America/New_York"), "9:00 AM");
});

test("buildSlotDisplay preserves the raw instant for booking + adds a label", () => {
  const slots = ["2026-01-15T14:00:00.000Z", "2026-01-15T14:15:00.000Z"];
  const display = buildSlotDisplay(slots, "America/New_York");
  assert.equal(display.length, 2);
  assert.deepEqual(display[0], { start: slots[0], label: "9:00 AM" });
  assert.equal(display[1].label, "9:15 AM");
  // The booked instant is the exact, unmodified server value.
  assert.equal(display[0].start, slots[0]);
});
