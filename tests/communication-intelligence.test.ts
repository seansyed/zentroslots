/**
 * Phase SMART-3 — communication intelligence tests.
 *
 * Coverage:
 *   • Determinism — same input always produces same output across
 *     the assessment, cadence, and message-recommendation modules.
 *   • Attendance risk wiring — buildAssessmentFromScore correctly
 *     surfaces the underlying scoreNoShowRisk() output as the new
 *     SMART-3 shape (with leadHours + signals echo).
 *   • Reminder cadence — high-risk + same-day branches add the
 *     right extra recommendations; standard 24h/1h baseline is
 *     always present when applicable.
 *   • Message recommendations — at most 3, prioritized correctly,
 *     never duplicated; LLM-style artifacts (quotes, markdown,
 *     angle brackets) never appear in output strings.
 *   • Safety — pure-function contracts: no input mutation, empty
 *     inputs handled.
 *   • Timezone correctness — cadence sendAt timestamps are anchored
 *     to the booking start, not "now" of the test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildAssessmentFromScore,
} from "../lib/communications/intelligence/attendancePrediction";
import { computeReminderCadence } from "../lib/communications/intelligence/communicationTiming";
import { recommendMessages } from "../lib/communications/intelligence/messageRecommendations";
import type {
  AttendanceRiskAssessment,
  CustomerEngagementProfile,
} from "../lib/communications/intelligence/types";
import type { BookingSignals } from "../lib/analytics/noShowRisk";

// ─── Fixtures ─────────────────────────────────────────────────────────

const NOW = new Date("2026-06-15T14:00:00Z");

function signals(overrides: Partial<BookingSignals> = {}): BookingSignals {
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

function buildEngagement(
  overrides: Partial<CustomerEngagementProfile> = {},
): CustomerEngagementProfile {
  return {
    email: "test@example.com",
    totalBookings: 5,
    completedBookings: 4,
    noShowBookings: 0,
    cancelledBookings: 1,
    rescheduleCount: 0,
    noShowRate: 0,
    cancellationRate: 0.2,
    completionRate: 0.8,
    lastBookingAt: NOW.toISOString(),
    ...overrides,
  };
}

// ─── buildAssessmentFromScore ────────────────────────────────────────

describe("buildAssessmentFromScore", () => {
  it("low tier for a clean booking", () => {
    const a = buildAssessmentFromScore({ signals: signals(), now: NOW });
    assert.equal(a.tier, "low");
    assert.equal(a.score, 0);
    assert.equal(a.leadHours, 48);
  });

  it("high tier with multiple no-shows + cancellations", () => {
    // 3 no-shows = 40pts (capped); +2 cancellations = 20pts → 60 ⇒ high
    const a = buildAssessmentFromScore({
      signals: signals({ priorNoShows: 3, priorCancellations: 2 }),
      now: NOW,
    });
    assert.equal(a.tier, "high");
    assert.ok(a.score >= 60);
    assert.ok(a.reasons.some((r) => r.includes("no-show")));
  });

  it("medium tier when score crosses 30 but not 60", () => {
    const a = buildAssessmentFromScore({
      signals: signals({ priorCancellations: 3 }),
      now: NOW,
    });
    // 3 cancellations × 10pts (capped) = 30 → medium boundary
    assert.equal(a.tier, "medium");
  });

  it("echoes input signals into the assessment", () => {
    const s = signals({ priorNoShows: 2, rescheduleCount: 1 });
    const a = buildAssessmentFromScore({ signals: s, now: NOW });
    assert.equal(a.signals.priorNoShows, 2);
    assert.equal(a.signals.rescheduleCount, 1);
    assert.equal(a.signals.reminderSuppressed, false);
  });

  it("is deterministic across calls", () => {
    const s = signals({ priorNoShows: 1, priorCancellations: 2 });
    const a = buildAssessmentFromScore({ signals: s, now: NOW });
    const b = buildAssessmentFromScore({ signals: s, now: NOW });
    assert.equal(a.score, b.score);
    assert.equal(a.tier, b.tier);
    assert.deepEqual(a.reasons, b.reasons);
  });

  it("clamps score to 0..100", () => {
    // Pile on every signal at max
    const a = buildAssessmentFromScore({
      signals: signals({
        leadHours: 1,
        priorCancellations: 10,
        priorNoShows: 10,
        rescheduleCount: 10,
        reminderSuppressed: true,
        missedConfirmation: true,
      }),
      now: NOW,
    });
    assert.ok(a.score >= 0 && a.score <= 100);
  });
});

// ─── computeReminderCadence ──────────────────────────────────────────

describe("computeReminderCadence", () => {
  function risk(tier: "low" | "medium" | "high", leadHours = 48): AttendanceRiskAssessment {
    return buildAssessmentFromScore({
      signals: signals({
        leadHours,
        priorNoShows:
          tier === "high" ? 3 : tier === "medium" ? 0 : 0,
        // For "high" we ALSO add cancellations so the score
        // clears HIGH_THRESHOLD=60 (3 no-shows alone cap at 40pts).
        priorCancellations:
          tier === "high" ? 2 : tier === "medium" ? 3 : 0,
      }),
      now: NOW,
    });
  }

  it("emits the standard 24h + 1h baseline for low-risk + long-lead", () => {
    const start = new Date(NOW.getTime() + 48 * 3_600_000); // 48h out
    const cad = computeReminderCadence({
      bookingStartAt: start,
      leadHours: 48,
      risk: risk("low"),
      now: NOW,
    });
    const hours = cad.recommendations.map((r) => r.hoursBeforeBooking);
    assert.ok(hours.includes(24), "missing 24h baseline");
    assert.ok(hours.includes(1), "missing 1h baseline");
  });

  it("adds 4h extra for high-risk bookings", () => {
    const start = new Date(NOW.getTime() + 48 * 3_600_000);
    const cad = computeReminderCadence({
      bookingStartAt: start,
      leadHours: 48,
      risk: risk("high"),
      now: NOW,
    });
    const hours = cad.recommendations.map((r) => r.hoursBeforeBooking);
    assert.ok(hours.includes(4), "missing 4h high-risk reminder");
    assert.match(cad.headline, /high-risk/i);
  });

  it("adds immediate nudge for same-day bookings", () => {
    const start = new Date(NOW.getTime() + 3 * 3_600_000); // 3h out
    const cad = computeReminderCadence({
      bookingStartAt: start,
      leadHours: 3, // same-day
      risk: risk("low", 3),
      now: NOW,
    });
    const reasons = cad.recommendations.map((r) => r.reason);
    assert.ok(
      reasons.some((r) => r.toLowerCase().includes("same-day")),
      `expected same-day recommendation, got: ${reasons.join(", ")}`,
    );
  });

  it("adds 7-day check-in for medium-risk long-lead bookings", () => {
    const start = new Date(NOW.getTime() + 14 * 24 * 3_600_000); // 14 days out
    const cad = computeReminderCadence({
      bookingStartAt: start,
      leadHours: 14 * 24,
      risk: risk("medium", 14 * 24),
      now: NOW,
    });
    const hours = cad.recommendations.map((r) => r.hoursBeforeBooking);
    assert.ok(hours.includes(168), "missing 7-day check-in");
  });

  it("emits recommendations in chronological order", () => {
    const start = new Date(NOW.getTime() + 14 * 24 * 3_600_000);
    const cad = computeReminderCadence({
      bookingStartAt: start,
      leadHours: 14 * 24,
      risk: risk("high", 14 * 24),
      now: NOW,
    });
    for (let i = 1; i < cad.recommendations.length; i++) {
      assert.ok(
        cad.recommendations[i - 1].sendAt <= cad.recommendations[i].sendAt,
        `out of order at index ${i}`,
      );
    }
  });

  it("is deterministic across calls", () => {
    const start = new Date(NOW.getTime() + 48 * 3_600_000);
    const a = computeReminderCadence({
      bookingStartAt: start,
      leadHours: 48,
      risk: risk("high"),
      now: NOW,
    });
    const b = computeReminderCadence({
      bookingStartAt: start,
      leadHours: 48,
      risk: risk("high"),
      now: NOW,
    });
    assert.deepEqual(
      a.recommendations.map((r) => ({ h: r.hoursBeforeBooking, p: r.priority })),
      b.recommendations.map((r) => ({ h: r.hoursBeforeBooking, p: r.priority })),
    );
    assert.equal(a.headline, b.headline);
  });

  it("anchors send times to booking start, not to `now`", () => {
    const start = new Date(NOW.getTime() + 48 * 3_600_000);
    const cad = computeReminderCadence({
      bookingStartAt: start,
      leadHours: 48,
      risk: risk("low"),
      now: NOW,
    });
    const twentyFour = cad.recommendations.find((r) => r.hoursBeforeBooking === 24);
    if (twentyFour) {
      const expected = new Date(start.getTime() - 24 * 3_600_000).toISOString();
      assert.equal(twentyFour.sendAt, expected);
    }
  });

  it("does not duplicate the 24h reminder for short-lead bookings", () => {
    // Booking 3h out — no 24h reminder should be emitted (impossible)
    const start = new Date(NOW.getTime() + 3 * 3_600_000);
    const cad = computeReminderCadence({
      bookingStartAt: start,
      leadHours: 3,
      risk: risk("low", 3),
      now: NOW,
    });
    const twentyFour = cad.recommendations.filter(
      (r) => r.hoursBeforeBooking === 24,
    );
    assert.equal(twentyFour.length, 0);
  });
});

// ─── recommendMessages ───────────────────────────────────────────────

describe("recommendMessages", () => {
  function risk(tier: "low" | "medium" | "high"): AttendanceRiskAssessment {
    return buildAssessmentFromScore({
      signals: signals({
        priorNoShows: tier === "high" ? 3 : tier === "medium" ? 0 : 0,
        // "high" needs cancellations on top — 3 no-shows alone caps at 40pts.
        priorCancellations:
          tier === "high" ? 2 : tier === "medium" ? 3 : 0,
      }),
      now: NOW,
    });
  }

  it("recommends personal outreach for high-risk", () => {
    const r = recommendMessages({
      risk: risk("high"),
      engagement: null,
      leadHours: 48,
    });
    assert.ok(r.some((m) => m.code === "high_risk_personal_outreach"));
  });

  it("recommends phone confirmation for repeat no-shows (>=2)", () => {
    const r = recommendMessages({
      risk: risk("low"),
      engagement: buildEngagement({
        noShowBookings: 2,
        totalBookings: 5,
      }),
      leadHours: 48,
    });
    assert.ok(r.some((m) => m.code === "repeat_no_show_call"));
  });

  it("recommends same-day handling for short leads", () => {
    const r = recommendMessages({
      risk: risk("low"),
      engagement: null,
      leadHours: 2,
    });
    assert.ok(r.some((m) => m.code === "same_day_short_reminder"));
  });

  it("recommends VIP handling for high-completion repeat customers", () => {
    const r = recommendMessages({
      risk: risk("low"),
      engagement: buildEngagement({
        totalBookings: 8,
        completedBookings: 8,
        completionRate: 1,
        noShowBookings: 0,
        cancelledBookings: 0,
      }),
      leadHours: 48,
    });
    assert.ok(r.some((m) => m.code === "vip_white_glove"));
  });

  it("caps output at 3 recommendations", () => {
    // Combine every trigger.
    const r = recommendMessages({
      risk: risk("high"),
      engagement: buildEngagement({
        noShowBookings: 3,
        totalBookings: 10,
        completedBookings: 5,
        completionRate: 0.5,
      }),
      leadHours: 2,
      isPostCancellation: true,
    });
    assert.ok(r.length <= 3, `expected ≤ 3, got ${r.length}`);
  });

  it("never emits LLM-style artifacts in messages", () => {
    const r = recommendMessages({
      risk: risk("high"),
      engagement: buildEngagement({ noShowBookings: 3 }),
      leadHours: 2,
    });
    for (const m of r) {
      assert.ok(!m.message.includes("**"), `markdown in message: ${m.message}`);
      assert.ok(!m.message.includes("<"), `angle bracket in message: ${m.message}`);
      assert.ok(!m.evidence.includes("**"), `markdown in evidence: ${m.evidence}`);
    }
  });

  it("returns no codes twice", () => {
    const r = recommendMessages({
      risk: risk("high"),
      engagement: buildEngagement({ noShowBookings: 3 }),
      leadHours: 48,
    });
    const codes = r.map((m) => m.code);
    assert.equal(codes.length, new Set(codes).size);
  });

  it("is deterministic across calls", () => {
    const args = {
      risk: risk("high"),
      engagement: buildEngagement({ noShowBookings: 3 }),
      leadHours: 48,
    };
    const a = recommendMessages(args);
    const b = recommendMessages(args);
    assert.deepEqual(
      a.map((x) => x.code),
      b.map((x) => x.code),
    );
  });

  it("returns empty list for low-risk first-time customer with normal lead", () => {
    const r = recommendMessages({
      risk: risk("low"),
      engagement: null,
      leadHours: 48,
    });
    assert.equal(r.length, 0);
  });
});

// ─── Safety contracts ─────────────────────────────────────────────────

describe("communication intelligence safety contracts", () => {
  it("buildAssessmentFromScore handles zero-signal input gracefully", () => {
    const a = buildAssessmentFromScore({
      signals: signals(),
      now: NOW,
    });
    assert.equal(a.tier, "low");
    assert.equal(a.score, 0);
    assert.deepEqual(a.reasons, []);
  });

  it("computeReminderCadence handles a booking starting in the past", () => {
    const start = new Date(NOW.getTime() - 3_600_000); // 1h ago
    const cad = computeReminderCadence({
      bookingStartAt: start,
      leadHours: 0,
      risk: buildAssessmentFromScore({ signals: signals(), now: NOW }),
      now: NOW,
    });
    // No future reminders emitted (all hoursBeforeBooking <= 0).
    assert.deepEqual(cad.recommendations, []);
    assert.ok(typeof cad.headline === "string");
  });

  it("recommendMessages does not mutate its inputs", () => {
    const eng = buildEngagement();
    const before = JSON.stringify(eng);
    recommendMessages({
      risk: buildAssessmentFromScore({ signals: signals(), now: NOW }),
      engagement: eng,
      leadHours: 48,
    });
    assert.equal(JSON.stringify(eng), before);
  });
});
