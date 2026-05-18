/**
 * Run: npm test
 *
 * Unit tests for the canonical scheduling-email gate. These are pure
 * predicates — no DB, no network — so we test exhaustively here. The
 * DB-aware wrapper (`gateSchedulingEmail`) is exercised end-to-end via
 * the production smoke tests in Phase 7.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PREFS, normalizePrefs, type ClientCommPrefs } from "../lib/client-prefs";
import {
  decideSchedulingEmail,
  isReminderAllowed,
  type SchedulingEmailKind,
} from "../lib/communications/email-rules";

const KINDS: SchedulingEmailKind[] = [
  "appointment_confirmation",
  "appointment_cancelled",
  "appointment_rescheduled",
  "appointment_reminder_24h",
  "appointment_reminder_1h",
];

function prefs(overrides: Partial<ClientCommPrefs> = {}): ClientCommPrefs {
  return { ...DEFAULT_PREFS, ...overrides };
}

describe("normalizePrefs", () => {
  it("fills in defaults when given empty input (legacy customers)", () => {
    assert.deepEqual(normalizePrefs({}), DEFAULT_PREFS);
    assert.deepEqual(normalizePrefs(null), DEFAULT_PREFS);
    assert.deepEqual(normalizePrefs(undefined), DEFAULT_PREFS);
  });

  it("drops unknown keys silently", () => {
    const out = normalizePrefs({ emailEnabled: false, garbageKey: "no" });
    assert.equal(out.emailEnabled, false);
    assert.equal((out as Record<string, unknown>).garbageKey, undefined);
  });

  it("rejects non-boolean values for known keys (defaults applied)", () => {
    const out = normalizePrefs({ emailEnabled: "yes", reminder1hEnabled: 1 });
    assert.equal(out.emailEnabled, DEFAULT_PREFS.emailEnabled);
    assert.equal(out.reminder1hEnabled, DEFAULT_PREFS.reminder1hEnabled);
  });
});

describe("decideSchedulingEmail — defaults (legacy customer)", () => {
  it("allows every kind when prefs are default (everything on)", () => {
    for (const k of KINDS) {
      const decision = decideSchedulingEmail(prefs(), k);
      assert.equal(decision.allowed, true, `expected ${k} to be allowed by default`);
    }
  });
});

describe("decideSchedulingEmail — emailEnabled master switch", () => {
  it("blocks every kind when emailEnabled is false, with reason=email_disabled", () => {
    for (const k of KINDS) {
      const decision = decideSchedulingEmail(prefs({ emailEnabled: false }), k);
      assert.equal(decision.allowed, false);
      if (!decision.allowed) {
        assert.equal(decision.reason, "email_disabled");
      }
    }
  });
});

describe("decideSchedulingEmail — per-reminder toggles", () => {
  it("blocks 24h reminder when reminder24hEnabled=false", () => {
    const d = decideSchedulingEmail(prefs({ reminder24hEnabled: false }), "appointment_reminder_24h");
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.reason, "reminder24h_disabled");
  });

  it("blocks 1h reminder when reminder1hEnabled=false", () => {
    const d = decideSchedulingEmail(prefs({ reminder1hEnabled: false }), "appointment_reminder_1h");
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.reason, "reminder1h_disabled");
  });

  it("disabling 24h does NOT affect 1h (and vice-versa)", () => {
    const only24Off = prefs({ reminder24hEnabled: false });
    assert.equal(decideSchedulingEmail(only24Off, "appointment_reminder_1h").allowed, true);

    const only1Off = prefs({ reminder1hEnabled: false });
    assert.equal(decideSchedulingEmail(only1Off, "appointment_reminder_24h").allowed, true);
  });

  it("disabling reminder toggles does NOT block confirmation / cancellation / reschedule", () => {
    const reminderOff = prefs({ reminder24hEnabled: false, reminder1hEnabled: false });
    for (const k of ["appointment_confirmation", "appointment_cancelled", "appointment_rescheduled"] as const) {
      assert.equal(decideSchedulingEmail(reminderOff, k).allowed, true);
    }
  });

  it("master OFF + per-reminder ON still blocks (master wins)", () => {
    const masterOff = prefs({ emailEnabled: false, reminder24hEnabled: true, reminder1hEnabled: true });
    for (const k of KINDS) {
      const d = decideSchedulingEmail(masterOff, k);
      assert.equal(d.allowed, false);
      if (!d.allowed) assert.equal(d.reason, "email_disabled");
    }
  });
});

describe("decideSchedulingEmail — transactional kinds bypass per-event toggles", () => {
  it("confirmation gated only by master switch", () => {
    const allOff = prefs({ reminder24hEnabled: false, reminder1hEnabled: false, marketingEnabled: false });
    assert.equal(decideSchedulingEmail(allOff, "appointment_confirmation").allowed, true);
  });

  it("cancellation gated only by master switch", () => {
    const allOff = prefs({ reminder24hEnabled: false, reminder1hEnabled: false });
    assert.equal(decideSchedulingEmail(allOff, "appointment_cancelled").allowed, true);
  });

  it("reschedule gated only by master switch", () => {
    const allOff = prefs({ reminder24hEnabled: false, reminder1hEnabled: false });
    assert.equal(decideSchedulingEmail(allOff, "appointment_rescheduled").allowed, true);
  });
});

describe("isReminderAllowed (convenience wrapper)", () => {
  it("agrees with decideSchedulingEmail for both windows", () => {
    const p1 = prefs({ reminder24hEnabled: false });
    assert.equal(isReminderAllowed(p1, 24), false);
    assert.equal(isReminderAllowed(p1, 1), true);

    const p2 = prefs({ emailEnabled: false });
    assert.equal(isReminderAllowed(p2, 24), false);
    assert.equal(isReminderAllowed(p2, 1), false);

    assert.equal(isReminderAllowed(prefs(), 24), true);
    assert.equal(isReminderAllowed(prefs(), 1), true);
  });
});
