/**
 * Unit tests for the four routing modes. All pickers are pure (no DB
 * touch) when called via the *Pure / pickPriority entry points.
 *
 * The orchestrator (assignStaff.ts) and recordAssignment do touch the
 * DB and are exercised in the production smoke phase.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  pickRoundRobinPure,
  type StatRow,
} from "../lib/routing/roundRobin";
import {
  pickLeastBusyPure,
  type BusyStat,
} from "../lib/routing/leastBusy";
import { pickPriority } from "../lib/routing/priority";
import {
  pickWeightedPure,
  type WeightStat,
} from "../lib/routing/weighted";

// Tiny deterministic RNG seeded from a u32. Replaces Math.random() in
// weighted tests so output is reproducible.
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const C = "00000000-0000-0000-0000-00000000000c";

describe("routing: roundRobin", () => {
  it("picks staff with oldest lastAssignedAt", () => {
    const stats: StatRow[] = [
      { staffId: A, lastAssignedAt: new Date("2026-05-18T10:00:00Z"), totalAssignments: 5 },
      { staffId: B, lastAssignedAt: new Date("2026-05-15T10:00:00Z"), totalAssignments: 5 },
      { staffId: C, lastAssignedAt: new Date("2026-05-17T10:00:00Z"), totalAssignments: 5 },
    ];
    assert.equal(pickRoundRobinPure({ eligible: [A, B, C], stats }), B);
  });

  it("never-assigned staff (no stat row) sort first", () => {
    const stats: StatRow[] = [
      { staffId: A, lastAssignedAt: new Date("2026-05-15T10:00:00Z"), totalAssignments: 5 },
    ];
    // B has no row → treated as never assigned.
    assert.equal(pickRoundRobinPure({ eligible: [A, B], stats }), B);
  });

  it("never-assigned staff (null lastAssignedAt) sort first", () => {
    const stats: StatRow[] = [
      { staffId: A, lastAssignedAt: new Date(), totalAssignments: 5 },
      { staffId: B, lastAssignedAt: null, totalAssignments: 0 },
    ];
    assert.equal(pickRoundRobinPure({ eligible: [A, B], stats }), B);
  });

  it("ties broken by staffId ascending", () => {
    const stats: StatRow[] = [
      { staffId: A, lastAssignedAt: new Date("2026-05-15T10:00:00Z"), totalAssignments: 1 },
      { staffId: B, lastAssignedAt: new Date("2026-05-15T10:00:00Z"), totalAssignments: 1 },
    ];
    assert.equal(pickRoundRobinPure({ eligible: [A, B], stats }), A);
  });

  it("returns null for empty pool", () => {
    assert.equal(pickRoundRobinPure({ eligible: [], stats: [] }), null);
  });

  it("respects eligibility pre-filter — doesn't pick excluded staff", () => {
    // Even if B has the oldest assignment, if B isn't eligible they
    // shouldn't be picked.
    const stats: StatRow[] = [
      { staffId: A, lastAssignedAt: new Date("2026-05-18T10:00:00Z"), totalAssignments: 5 },
      { staffId: B, lastAssignedAt: new Date("2026-05-15T10:00:00Z"), totalAssignments: 5 },
    ];
    assert.equal(pickRoundRobinPure({ eligible: [A], stats }), A);
  });
});

describe("routing: leastBusy", () => {
  it("picks staff with lowest assignmentsToday", () => {
    const stats: BusyStat[] = [
      { staffId: A, assignmentsToday: 5, lastAssignedAt: null },
      { staffId: B, assignmentsToday: 2, lastAssignedAt: null },
      { staffId: C, assignmentsToday: 8, lastAssignedAt: null },
    ];
    assert.equal(pickLeastBusyPure({ eligible: [A, B, C], stats }), B);
  });

  it("staff with no stat row counted as 0 today (wins)", () => {
    const stats: BusyStat[] = [
      { staffId: A, assignmentsToday: 1, lastAssignedAt: null },
    ];
    assert.equal(pickLeastBusyPure({ eligible: [A, B], stats }), B);
  });

  it("tie-break by oldest lastAssignedAt", () => {
    const stats: BusyStat[] = [
      { staffId: A, assignmentsToday: 3, lastAssignedAt: new Date("2026-05-18T10:00:00Z") },
      { staffId: B, assignmentsToday: 3, lastAssignedAt: new Date("2026-05-15T10:00:00Z") },
    ];
    assert.equal(pickLeastBusyPure({ eligible: [A, B], stats }), B);
  });

  it("final tie-break by staffId ascending", () => {
    const stats: BusyStat[] = [
      { staffId: A, assignmentsToday: 0, lastAssignedAt: null },
      { staffId: B, assignmentsToday: 0, lastAssignedAt: null },
    ];
    assert.equal(pickLeastBusyPure({ eligible: [A, B], stats }), A);
  });

  it("returns null for empty pool", () => {
    assert.equal(pickLeastBusyPure({ eligible: [], stats: [] }), null);
  });
});

describe("routing: priority", () => {
  it("picks first eligible in priority list", () => {
    assert.equal(pickPriority({ priorityOrder: [A, B, C], eligible: [A, B, C] }), A);
  });

  it("skips ineligible to next in priority", () => {
    // A not eligible (e.g. has conflicting booking); B is next in priority.
    assert.equal(pickPriority({ priorityOrder: [A, B, C], eligible: [B, C] }), B);
  });

  it("falls through entire list when needed", () => {
    assert.equal(pickPriority({ priorityOrder: [A, B, C], eligible: [C] }), C);
  });

  it("returns null when no priority entries are eligible", () => {
    assert.equal(pickPriority({ priorityOrder: [A, B], eligible: [C] }), null);
  });

  it("returns null for empty priority list", () => {
    assert.equal(pickPriority({ priorityOrder: [], eligible: [A] }), null);
  });
});

describe("routing: weighted", () => {
  it("returns null when no eligible staff has a weight", () => {
    const result = pickWeightedPure({
      weights: { [C]: 50 },
      eligible: [A, B],
      stats: [],
    });
    assert.equal(result, null);
  });

  it("deficit correction picks the staff that's behind target", () => {
    // Target: A=50%, B=50%. Actual so far: A=10, B=0. A is OVER target,
    // B is UNDER → should pick B regardless of RNG.
    const stats: WeightStat[] = [
      { staffId: A, totalAssignments: 10 },
      { staffId: B, totalAssignments: 0 },
    ];
    const result = pickWeightedPure({
      weights: { [A]: 50, [B]: 50 },
      eligible: [A, B],
      stats,
      rng: () => 0.99, // would normally favor B; we still expect B via deficit.
    });
    assert.equal(result, B);
  });

  it("60/40 weighted distribution converges over many draws", () => {
    // Simulate 1000 picks where each picked staff has their total
    // incremented. With deficit correction, the share should be tight
    // around the configured weights.
    const weights = { [A]: 60, [B]: 40 };
    const stats: WeightStat[] = [
      { staffId: A, totalAssignments: 0 },
      { staffId: B, totalAssignments: 0 },
    ];
    const rng = seededRng(42);
    const counts: Record<string, number> = { [A]: 0, [B]: 0 };
    for (let i = 0; i < 1000; i++) {
      const pick = pickWeightedPure({
        weights,
        eligible: [A, B],
        stats,
        rng,
      });
      assert.ok(pick === A || pick === B);
      counts[pick!]++;
      stats.find((s) => s.staffId === pick)!.totalAssignments += 1;
    }
    // Expect ~60/40 ±2% over 1000 draws thanks to deficit correction.
    const shareA = counts[A] / 1000;
    assert.ok(shareA > 0.58 && shareA < 0.62, `Expected A share ~0.60, got ${shareA}`);
  });

  it("falls through to weighted random when no history (sumTotals=0)", () => {
    // First-ever assignment — no totals — should still pick deterministically
    // with a fixed RNG.
    const rng = seededRng(1);
    const result = pickWeightedPure({
      weights: { [A]: 50, [B]: 50 },
      eligible: [A, B],
      stats: [],
      rng,
    });
    assert.ok(result === A || result === B);
  });

  it("respects eligibility restriction (skips A even with weight)", () => {
    const result = pickWeightedPure({
      weights: { [A]: 80, [B]: 20 },
      eligible: [B],
      stats: [],
    });
    assert.equal(result, B);
  });
});
