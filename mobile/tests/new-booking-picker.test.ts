import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for the New Booking date picker. The device screenshot showed
 * the OLD 14-day horizontal date strip; this asserts quick-create renders the
 * production full-month <MonthCalendar> and has no strip remnant — so a future
 * edit can't silently revert to the strip. (Rendering RN under node isn't
 * practical, so this is a source-level guard alongside the parseInitialDate unit
 * tests in dates.test.ts.)
 */

const src = readFileSync(join(process.cwd(), "app", "quick-create.tsx"), "utf8");

test("New Booking imports + mounts MonthCalendar", () => {
  assert.match(src, /import \{ MonthCalendar \} from "@\/components\/ui\/MonthCalendar"/);
  assert.match(src, /<MonthCalendar\b/);
});

test("New Booking has no legacy horizontal date-strip remnant", () => {
  // The old strip + its stale header comment ("Date strip — 14-day forward")
  // must be gone.
  assert.doesNotMatch(src, /date strip/i);
  assert.doesNotMatch(src, /DATE_STRIP/);
});

test("New Booking accepts a ?date= handoff and clamps it", () => {
  assert.match(src, /useLocalSearchParams<\{\s*date\?: string\s*\}>/);
  assert.match(src, /parseInitialDate\(/);
});
