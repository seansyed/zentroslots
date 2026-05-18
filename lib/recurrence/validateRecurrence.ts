/**
 * Sanity-check a parsed recurrence rule before persistence.
 *
 * Pure. Catches admin mistakes that the parser tolerates (e.g. BYDAY
 * with FREQ=DAILY is technically valid but rarely intentional).
 */
import { parseRecurrenceRule, RecurrenceParseError } from "./recurrenceRules";
import type { RecurrenceRule } from "./types";

export type RecurrenceValidation =
  | { ok: true; rule: RecurrenceRule }
  | { ok: false; reason: string };

const MAX_INTERVAL = 365;
const MAX_COUNT = 1000;
const MAX_HORIZON_YEARS = 5;

export function validateRecurrenceRuleString(input: string): RecurrenceValidation {
  let rule: RecurrenceRule;
  try {
    rule = parseRecurrenceRule(input);
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof RecurrenceParseError ? e.message : "Could not parse rule",
    };
  }

  if (rule.interval > MAX_INTERVAL) {
    return { ok: false, reason: `INTERVAL too large (max ${MAX_INTERVAL})` };
  }
  if (rule.count && rule.count > MAX_COUNT) {
    return { ok: false, reason: `COUNT too large (max ${MAX_COUNT})` };
  }
  if (rule.until) {
    const maxAhead = Date.now() + MAX_HORIZON_YEARS * 365 * 24 * 60 * 60_000;
    if (rule.until.getTime() > maxAhead) {
      return { ok: false, reason: `UNTIL more than ${MAX_HORIZON_YEARS} years in the future` };
    }
  }
  // BYDAY only meaningful for WEEKLY; warn-style reject for DAILY/MONTHLY
  // to avoid surprising admins.
  if (rule.byday && rule.byday.length > 0 && rule.freq !== "WEEKLY") {
    return {
      ok: false,
      reason: "BYDAY is only supported with FREQ=WEEKLY",
    };
  }
  return { ok: true, rule };
}
