/**
 * Unit tests for lib/analytics/noShowRisk.ts (pure).
 *
 *   - deterministic scoring (same inputs → same outputs)
 *   - tier boundaries (low / medium / high)
 *   - cap on prior signals
 *   - reasons cite the signal that fired
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  scoreNoShowRisk,
  _thresholds,
  type BookingSignals,
} from "../lib/analytics/noShowRisk";

function base(overrides: Partial<BookingSignals> = {}): BookingSignals {
  return {
    leadHours: 48,
    priorCancellations: 0,
    priorNoShows: 0,
    rescheduleCount: 0,
    reminderSuppressed: false,
    missedConfirmation: false,
    ...overrides,
  };
}

describe("noShowRisk: clean booking", () => {
  it("scores 0 / low when no signals fire", () => {
    const r = scoreNoShowRisk(base());
    assert.equal(r.score, 0);
    assert.equal(r.tier, "low");
    assert.equal(r.reasons.length, 0);
  });
});

describe("noShowRisk: lead time", () => {
  it("short lead adds points + cites the reason", () => {
    const r = scoreNoShowRisk(base({ leadHours: 3 }));
    assert.ok(r.score > 0);
    assert.ok(r.reasons.some((m) => /within \d+h/.test(m)));
  });
  it("very-short lead is more punitive than short", () => {
    const short = scoreNoShowRisk(base({ leadHours: 4 }));
    const veryShort = scoreNoShowRisk(base({ leadHours: 1 }));
    assert.ok(veryShort.score > short.score, `veryShort(${veryShort.score}) > short(${short.score})`);
  });
});

describe("noShowRisk: prior signals", () => {
  it("prior no-shows weigh more than prior cancellations", () => {
    const cancels = scoreNoShowRisk(base({ priorCancellations: 1 }));
    const noShows = scoreNoShowRisk(base({ priorNoShows: 1 }));
    assert.ok(noShows.score > cancels.score);
  });
  it("prior cancellation count caps at max points", () => {
    const five = scoreNoShowRisk(base({ priorCancellations: 5 }));
    const fifty = scoreNoShowRisk(base({ priorCancellations: 50 }));
    assert.equal(five.score, fifty.score, "cap should apply");
  });
});

describe("noShowRisk: tier boundaries", () => {
  it("tier high when score >= HIGH_THRESHOLD", () => {
    const r = scoreNoShowRisk(
      base({
        leadHours: 1, // very short
        priorNoShows: 2, // 40 pts
        rescheduleCount: 3, // 24 pts
      })
    );
    assert.ok(r.score >= _thresholds.HIGH_THRESHOLD);
    assert.equal(r.tier, "high");
  });
  it("tier medium between thresholds", () => {
    const r = scoreNoShowRisk(base({ priorNoShows: 1, reminderSuppressed: true }));
    assert.ok(r.score >= _thresholds.MEDIUM_THRESHOLD);
    assert.ok(r.score < _thresholds.HIGH_THRESHOLD);
    assert.equal(r.tier, "medium");
  });
  it("tier low under MEDIUM_THRESHOLD", () => {
    const r = scoreNoShowRisk(base({ reminderSuppressed: true }));
    assert.ok(r.score < _thresholds.MEDIUM_THRESHOLD);
    assert.equal(r.tier, "low");
  });
});

describe("noShowRisk: explainability", () => {
  it("reasons include every signal that fired", () => {
    const r = scoreNoShowRisk(
      base({
        leadHours: 1,
        priorCancellations: 2,
        priorNoShows: 1,
        rescheduleCount: 1,
        reminderSuppressed: true,
        missedConfirmation: true,
      })
    );
    assert.ok(r.reasons.length >= 6);
  });
  it("score caps at 100", () => {
    const r = scoreNoShowRisk(
      base({
        leadHours: 1,
        priorCancellations: 99,
        priorNoShows: 99,
        rescheduleCount: 99,
        reminderSuppressed: true,
        missedConfirmation: true,
      })
    );
    assert.ok(r.score <= 100);
  });
});

describe("noShowRisk: determinism", () => {
  it("same inputs produce same outputs across calls", () => {
    const s = base({ leadHours: 2, priorNoShows: 1 });
    const a = scoreNoShowRisk(s);
    const b = scoreNoShowRisk(s);
    assert.deepEqual(a, b);
  });
});
