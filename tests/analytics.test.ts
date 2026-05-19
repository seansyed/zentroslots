/**
 * Unit tests for the pure parts of lib/analytics.
 *
 *   - insights.ts:            generateInsights pure-function fixtures
 *   - utilizationMetrics.ts:  computeFairness math
 *
 * Aggregation orchestrator + cron worker hit DB; verified via smoke.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateInsights } from "../lib/analytics/insights";
import { computeFairness } from "../lib/analytics/utilizationMetrics";
import { emptyAggregate, type DailyAggregate } from "../lib/analytics/types";

// ─── Fixture builders ────────────────────────────────────────────────────

function makeDay(date: string, overrides: Partial<DailyAggregate> = {}): DailyAggregate {
  return { ...emptyAggregate("t1", date), ...overrides };
}

// Helper: make a 14-day window with a per-day modifier hook.
function makeWindow(modifier: (day: number) => Partial<DailyAggregate>): DailyAggregate[] {
  const out: DailyAggregate[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(2026, 5, 1 + i); // Jun 1..14
    const iso = d.toISOString().slice(0, 10);
    out.push(makeDay(iso, modifier(i)));
  }
  return out;
}

describe("analytics: generateInsights — empty / quiet windows", () => {
  it("empty array returns empty insights", () => {
    assert.deepEqual(generateInsights([]), []);
  });
  it("single quiet day produces no insights", () => {
    const out = generateInsights([makeDay("2026-06-01")]);
    assert.deepEqual(out, []);
  });
});

describe("analytics: busiest weekday", () => {
  it("emits a busiest-day insight when one weekday clearly dominates", () => {
    // Friday = idx 5. Stuff most bookings into Fridays.
    const snapshots = makeWindow((i) => {
      const wd = new Array(7).fill(0);
      // Day i has weekday equal to (i % 7), pile bookings onto Friday.
      wd[(i % 7)] = (i % 7) === 5 ? 20 : 1;
      return {
        totalBookings: wd.reduce((a, b) => a + b, 0),
        extras: { weekdayDistribution: wd },
      };
    });
    const out = generateInsights(snapshots);
    const busiest = out.find((i) => i.code === "busiest_weekday");
    assert.ok(busiest);
    assert.ok(busiest.message.includes("Fridays"));
  });

  it("does not emit when distribution is flat", () => {
    const snapshots = makeWindow(() => ({
      totalBookings: 1,
      extras: { weekdayDistribution: [1, 1, 1, 1, 1, 1, 1] },
    }));
    const busiest = generateInsights(snapshots).find((i) => i.code === "busiest_weekday");
    assert.equal(busiest, undefined);
  });

  it("does not emit when total volume too low", () => {
    const snapshots = [makeDay("2026-06-01", { extras: { weekdayDistribution: [3, 0, 0, 0, 0, 0, 0] } })];
    const busiest = generateInsights(snapshots).find((i) => i.code === "busiest_weekday");
    assert.equal(busiest, undefined);
  });
});

describe("analytics: cancellation spike", () => {
  it("emits when recent half has >30% higher rate", () => {
    // First half: 10 bookings, 0 cancels. Second half: 10 bookings, 5 cancels.
    const snapshots = makeWindow((i) => ({
      totalBookings: 10,
      cancelledBookings: i < 7 ? 0 : 5,
    }));
    const spike = generateInsights(snapshots).find((i) => i.code === "cancellation_spike");
    assert.ok(spike);
    assert.equal(spike.kind, "warning");
  });

  it("does not emit when rate stable", () => {
    const snapshots = makeWindow(() => ({
      totalBookings: 10,
      cancelledBookings: 2,
    }));
    const spike = generateInsights(snapshots).find((i) => i.code === "cancellation_spike");
    assert.equal(spike, undefined);
  });

  it("does not emit on too few days", () => {
    const snapshots = [
      makeDay("2026-06-01", { totalBookings: 10, cancelledBookings: 0 }),
      makeDay("2026-06-02", { totalBookings: 10, cancelledBookings: 5 }),
    ];
    const spike = generateInsights(snapshots).find((i) => i.code === "cancellation_spike");
    assert.equal(spike, undefined);
  });
});

describe("analytics: waitlist recovery", () => {
  it("emits positive insight when conversions > 0", () => {
    const snapshots = [makeDay("2026-06-01", { waitlistConversions: 3 })];
    const r = generateInsights(snapshots).find((i) => i.code === "waitlist_recovery");
    assert.ok(r);
    assert.equal(r.kind, "positive");
    assert.ok(r.message.includes("3"));
  });

  it("pluralizes correctly for 1 conversion", () => {
    const snapshots = [makeDay("2026-06-01", { waitlistConversions: 1 })];
    const r = generateInsights(snapshots).find((i) => i.code === "waitlist_recovery");
    assert.ok(r);
    assert.ok(r.message.includes("1 booking ") || r.message.includes("1 booking."));
  });

  it("no insight when zero", () => {
    const snapshots = [makeDay("2026-06-01")];
    const r = generateInsights(snapshots).find((i) => i.code === "waitlist_recovery");
    assert.equal(r, undefined);
  });
});

describe("analytics: suppression trend", () => {
  it("emits warning when recent suppression jump > 15%", () => {
    const snapshots = makeWindow((i) => ({
      reminderEmailsSuppressed: i < 7 ? 1 : 5,
    }));
    const r = generateInsights(snapshots).find((i) => i.code === "suppression_trend");
    assert.ok(r);
    assert.equal(r.kind, "warning");
  });

  it("emits positive when suppression drops > 15%", () => {
    const snapshots = makeWindow((i) => ({
      reminderEmailsSuppressed: i < 7 ? 5 : 1,
    }));
    const r = generateInsights(snapshots).find((i) => i.code === "suppression_trend");
    assert.ok(r);
    assert.equal(r.kind, "positive");
  });

  it("does not emit on low volume", () => {
    const snapshots = makeWindow((i) => ({
      reminderEmailsSuppressed: i < 7 ? 0 : 1,
    }));
    const r = generateInsights(snapshots).find((i) => i.code === "suppression_trend");
    assert.equal(r, undefined);
  });
});

describe("analytics: staff fairness insight", () => {
  it("emits warning when one staff has >35% unevenness", () => {
    const snapshots = makeWindow(() => ({
      totalBookings: 5,
      extras: { staffAssignments: { Alice: 8, Bob: 1, Carol: 1 } },
    }));
    const r = generateInsights(snapshots).find((i) => i.code === "staff_unevenness");
    assert.ok(r);
    assert.ok(r.message.includes("Alice"));
  });

  it("does not emit when distribution is even", () => {
    const snapshots = makeWindow(() => ({
      extras: { staffAssignments: { Alice: 3, Bob: 3, Carol: 3 } },
    }));
    const r = generateInsights(snapshots).find((i) => i.code === "staff_unevenness");
    assert.equal(r, undefined);
  });

  it("does not emit when only one staff", () => {
    const snapshots = makeWindow(() => ({
      extras: { staffAssignments: { Alice: 50 } },
    }));
    const r = generateInsights(snapshots).find((i) => i.code === "staff_unevenness");
    assert.equal(r, undefined);
  });
});

describe("analytics: insight ordering", () => {
  it("warnings sort before positive sort before neutral", () => {
    // Build a window that triggers all three kinds.
    const snapshots = makeWindow((i) => ({
      // Busiest day (neutral): pile onto Friday
      totalBookings: 10,
      extras: {
        weekdayDistribution: i % 7 === 5 ? [0, 0, 0, 0, 0, 30, 0] : [1, 1, 1, 1, 1, 0, 1],
        staffAssignments: { Alice: 8, Bob: 1 },
      },
      // Cancellation spike (warning): pile cancels late
      cancelledBookings: i < 7 ? 0 : 5,
      // Waitlist recovery (positive): conversions throughout
      waitlistConversions: 1,
    }));
    const out = generateInsights(snapshots);
    // Should have at least one warning, one positive, one neutral.
    const kinds = out.map((i) => i.kind);
    const order: Record<string, number> = { warning: 0, positive: 1, neutral: 2 };
    for (let i = 1; i < kinds.length; i++) {
      assert.ok(
        order[kinds[i]] >= order[kinds[i - 1]],
        `kinds[${i - 1}]=${kinds[i - 1]} should sort before kinds[${i}]=${kinds[i]}`
      );
    }
    assert.ok(kinds.includes("warning"));
    assert.ok(kinds.includes("positive"));
  });
});

describe("analytics: computeFairness", () => {
  it("returns zero unevenness for empty input", () => {
    const r = computeFairness({});
    assert.equal(r.unevenness, 0);
    assert.equal(r.staff.length, 0);
  });

  it("perfectly even = unevenness 0", () => {
    const r = computeFairness({ a: 5, b: 5, c: 5 });
    assert.equal(r.unevenness, 0);
    assert.equal(r.staff.length, 3);
    // Each has 33% share.
    for (const s of r.staff) assert.ok(s.sharePercent >= 33 && s.sharePercent <= 34);
  });

  it("uneven distribution produces positive unevenness", () => {
    const r = computeFairness({ a: 10, b: 1, c: 1 });
    assert.ok(r.unevenness > 0.5);
    assert.equal(r.staff[0].staffName, "a");
    assert.equal(r.staff[0].sharePercent, 83);
  });

  it("single-staff returns 0 unevenness", () => {
    const r = computeFairness({ a: 100 });
    assert.equal(r.unevenness, 0);
  });

  it("sorts staff by count desc", () => {
    const r = computeFairness({ a: 1, b: 10, c: 5 });
    assert.deepEqual(r.staff.map((s) => s.staffName), ["b", "c", "a"]);
  });
});
