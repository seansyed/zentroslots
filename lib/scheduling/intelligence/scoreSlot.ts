/**
 * Phase SMART-1 — pure factor scorers + composite scoring.
 *
 * Every exported scorer here is:
 *   • PURE — no DB, no I/O, no Date.now(), no Math.random().
 *   • DETERMINISTIC — same inputs always produce same outputs.
 *   • BOUNDED — every returned score is in [0, 100].
 *
 * Composition (scoreSlot below) uses fixed weights documented at the
 * top of that function. Changing the weights is a CONSCIOUS choice
 * that affects every recommendation in production — bump them with
 * intent + verify via the test suite's deterministic snapshots.
 *
 * Time-of-day reasoning uses Intl.DateTimeFormat against the staff's
 * IANA timezone, NOT the UTC hour — a slot at 16:00 UTC for a NY
 * staff is 12:00 local, which IS lunch.
 */

import type {
  CustomerPreferenceProfile,
  FactorScore,
  FocusRules,
  SlotContext,
  SlotScore,
} from "./types";

// ─── Time-zone helpers (deterministic, no Date.now()) ─────────────────

/** Return the local hour [0..23] of a UTC date in the given IANA tz. */
export function hourInTz(d: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  });
  // Intl emits "24" for midnight in some locales; normalize.
  const h = parseInt(fmt.format(d), 10);
  return h === 24 ? 0 : h;
}

/** Return the local minute [0..59] of a UTC date in the given IANA tz. */
export function minuteInTz(d: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    minute: "2-digit",
  });
  return parseInt(fmt.format(d), 10) || 0;
}

/** Day-of-week [0=Sun..6=Sat] of a UTC date in the given IANA tz. */
export function weekdayInTz(d: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  });
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return map[fmt.format(d)] ?? 0;
}

// ─── Individual factor scorers ────────────────────────────────────────

/** Time-of-day comfort. Smooth bell curve peaking at 10:30 local.
 *  Morning slots (9-11 local) get 95+; lunch dips to 65; afternoon
 *  recovers to 80; evening (>=17 local) decays. */
export function scoreTimeOfDay(slotStart: Date, tz: string): FactorScore {
  const hour = hourInTz(slotStart, tz);
  const minute = minuteInTz(slotStart, tz);
  const local = hour + minute / 60;
  // Distance from "ideal" 10.5h, normalized so a 5h gap costs ~50pt.
  const dist = Math.abs(local - 10.5);
  const score = Math.max(20, Math.round(100 - dist * 10));
  return {
    factor: "timeOfDay",
    score,
    detail: `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")} local`,
  };
}

/** Penalize slots that overlap the configured lunch window. The
 *  penalty is LIGHT (drops to 60) — the slot is still rendered;
 *  some staff prefer lunch meetings. Returns a clean 100 when the
 *  slot doesn't intersect lunch. */
export function scoreLunchAvoidance(
  slotStart: Date,
  durationMin: number,
  rules: Required<FocusRules>,
  tz: string,
): FactorScore {
  const slotEndMs = slotStart.getTime() + durationMin * 60_000;
  const slotEnd = new Date(slotEndMs);
  const startHour = hourInTz(slotStart, tz) + minuteInTz(slotStart, tz) / 60;
  const endHour = hourInTz(slotEnd, tz) + minuteInTz(slotEnd, tz) / 60;
  // Overlap test against [lunchHours.start, lunchHours.end].
  const overlaps =
    startHour < rules.lunchHours.end && endHour > rules.lunchHours.start;
  return {
    factor: "lunchAvoidance",
    score: overlaps ? 60 : 100,
    detail: overlaps ? "overlaps configured lunch window" : "outside lunch",
  };
}

/** Penalize the final endOfDayDecayMin of the working window. The
 *  closer the slot gets to the day's end, the steeper the penalty. */
export function scoreEndOfDayFatigue(
  slotStart: Date,
  durationMin: number,
  workingEnd: Date,
  rules: Required<FocusRules>,
): FactorScore {
  const slotEndMs = slotStart.getTime() + durationMin * 60_000;
  const decayWindowStartMs = workingEnd.getTime() - rules.endOfDayDecayMin * 60_000;
  if (slotEndMs <= decayWindowStartMs) {
    return { factor: "endOfDayFatigue", score: 100, detail: "well before EOD" };
  }
  // Linear ramp from 100 → 50 over the decay window.
  const intoDecayMs = slotEndMs - decayWindowStartMs;
  const ratio = Math.min(1, intoDecayMs / (rules.endOfDayDecayMin * 60_000));
  const score = Math.round(100 - 50 * ratio);
  return {
    factor: "endOfDayFatigue",
    score,
    detail: `${Math.round(intoDecayMs / 60_000)}min into EOD decay`,
  };
}

/** Reward slots that don't fragment the day with sub-buffer gaps.
 *  We look at the bookings BEFORE this slot — if any leaves a gap
 *  smaller than minBufferMinutes, penalize. */
export function scoreBufferEfficiency(
  slotStart: Date,
  others: { start: Date; end: Date }[],
  rules: Required<FocusRules>,
): FactorScore {
  const minBufferMs = rules.minBufferMinutes * 60_000;
  let worstGapMs = Infinity;
  for (const o of others) {
    if (o.end > slotStart) continue; // Only look at things ENDING before this slot.
    const gapMs = slotStart.getTime() - o.end.getTime();
    if (gapMs >= 0 && gapMs < worstGapMs) worstGapMs = gapMs;
  }
  if (!isFinite(worstGapMs)) {
    // No prior bookings → trivially efficient.
    return { factor: "bufferEfficiency", score: 100, detail: "no preceding booking" };
  }
  if (worstGapMs >= minBufferMs) {
    return { factor: "bufferEfficiency", score: 100, detail: `gap=${Math.round(worstGapMs / 60_000)}min` };
  }
  // Partial credit — short gaps still beat zero gaps slightly.
  const ratio = worstGapMs / minBufferMs;
  const score = Math.round(50 + 40 * ratio);
  return {
    factor: "bufferEfficiency",
    score,
    detail: `tight gap=${Math.round(worstGapMs / 60_000)}min`,
  };
}

/** Penalize slots that, if booked, would create a >maxConsecutiveHours
 *  block of back-to-back meetings. Counts the existing bookings
 *  abutting this slot (within 5 min either side). */
export function scoreBackToBackPenalty(
  slotStart: Date,
  durationMin: number,
  others: { start: Date; end: Date }[],
  rules: Required<FocusRules>,
): FactorScore {
  const ABUT_MS = 5 * 60_000;
  const slotEndMs = slotStart.getTime() + durationMin * 60_000;

  // Walk left + right from this slot, accumulating consecutive
  // booked minutes that touch (within ABUT_MS).
  const sorted = [...others].sort((a, b) => a.start.getTime() - b.start.getTime());
  let leftRunMs = 0;
  let cursor = slotStart.getTime();
  for (let i = sorted.length - 1; i >= 0; i--) {
    const o = sorted[i];
    if (o.end.getTime() > cursor) continue;
    if (cursor - o.end.getTime() > ABUT_MS) break;
    leftRunMs += o.end.getTime() - o.start.getTime();
    cursor = o.start.getTime();
  }
  let rightRunMs = 0;
  cursor = slotEndMs;
  for (const o of sorted) {
    if (o.start.getTime() < cursor) continue;
    if (o.start.getTime() - cursor > ABUT_MS) break;
    rightRunMs += o.end.getTime() - o.start.getTime();
    cursor = o.end.getTime();
  }
  const totalConsecutiveMs =
    leftRunMs + rightRunMs + durationMin * 60_000;
  const maxMs = rules.maxConsecutiveHours * 60 * 60_000;
  if (totalConsecutiveMs <= maxMs) {
    return {
      factor: "backToBackPenalty",
      score: 100,
      detail: `consecutive=${Math.round(totalConsecutiveMs / 60_000)}min`,
    };
  }
  // Overflow → linear penalty to 30.
  const overMs = totalConsecutiveMs - maxMs;
  const ratio = Math.min(1, overMs / (60 * 60_000)); // 1h over = full penalty
  const score = Math.round(100 - 70 * ratio);
  return {
    factor: "backToBackPenalty",
    score,
    detail: `would create ${Math.round(totalConsecutiveMs / 60_000)}min consecutive`,
  };
}

/** Hard penalty when the slot falls inside a configured quietHour
 *  block (focus time / protected hours). */
export function scoreFocusBlockRespect(
  slotStart: Date,
  durationMin: number,
  rules: Required<FocusRules>,
  tz: string,
): FactorScore {
  if (rules.quietHours.length === 0) {
    return { factor: "focusBlockRespect", score: 100, detail: "no quiet hours configured" };
  }
  const slotEndMs = slotStart.getTime() + durationMin * 60_000;
  const slotEnd = new Date(slotEndMs);
  const startHr = hourInTz(slotStart, tz) + minuteInTz(slotStart, tz) / 60;
  const endHr = hourInTz(slotEnd, tz) + minuteInTz(slotEnd, tz) / 60;
  for (const q of rules.quietHours) {
    if (startHr < q.end && endHr > q.start) {
      return {
        factor: "focusBlockRespect",
        score: 20,
        detail: `inside quiet hours ${q.start}-${q.end}`,
      };
    }
  }
  return { factor: "focusBlockRespect", score: 100, detail: "outside quiet hours" };
}

/** Daily soft-cap fairness. Once a staff member is at or past
 *  dailySoftCap, additional slots progressively lose points.
 *  ROUND-ROBIN: when two staff are competing the lower-loaded
 *  staff's slots win. */
export function scoreWorkloadBalance(
  staffDailyCount: number,
  rules: Required<FocusRules>,
): FactorScore {
  if (staffDailyCount < rules.dailySoftCap) {
    return {
      factor: "workloadBalance",
      score: 100,
      detail: `${staffDailyCount}/${rules.dailySoftCap} bookings today`,
    };
  }
  const over = staffDailyCount - rules.dailySoftCap;
  const score = Math.max(30, 100 - over * 15);
  return {
    factor: "workloadBalance",
    score,
    detail: `${staffDailyCount}/${rules.dailySoftCap} (soft-cap exceeded)`,
  };
}

/** Customer wall-clock comfort. We check what hour the slot LANDS
 *  in the customer's timezone (falls back to staff tz if unknown). */
export function scoreTimezoneFriendly(
  slotStart: Date,
  customerTz: string | undefined,
  staffTz: string,
  rules: Required<FocusRules>,
): FactorScore {
  const tz = customerTz ?? staffTz;
  const hour = hourInTz(slotStart, tz);
  const { start, end } = rules.customerPreferredHours;
  if (hour >= start && hour < end) {
    return {
      factor: "timezoneFriendly",
      score: 100,
      detail: `${hour}:00 in customer zone`,
    };
  }
  // Outside the customer's comfort window — linear penalty by hours
  // away.
  const offBy = hour < start ? start - hour : hour - (end - 1);
  const score = Math.max(20, 100 - offBy * 15);
  return {
    factor: "timezoneFriendly",
    score,
    detail: `${hour}:00 in customer zone (outside preferred ${start}-${end})`,
  };
}

/** History-based customer-preference bias. Requires sampleSize >= 3
 *  to engage — below that the histogram is too noisy. */
export function scoreCustomerPreference(
  slotStart: Date,
  customerTz: string | undefined,
  staffTz: string,
  profile: CustomerPreferenceProfile | undefined,
): FactorScore {
  if (!profile || profile.sampleSize < 3) {
    return {
      factor: "customerPreference",
      score: 70, // neutral baseline so the factor doesn't dominate
      detail: profile
        ? `only ${profile.sampleSize} historical bookings (need 3+)`
        : "no customer history",
    };
  }
  const tz = customerTz ?? staffTz;
  const hour = hourInTz(slotStart, tz);
  const totalHits = profile.preferredHourHistogram.reduce((a, b) => a + b, 0);
  if (totalHits === 0) {
    return { factor: "customerPreference", score: 70, detail: "no histogram signal" };
  }
  const hitsForHour = profile.preferredHourHistogram[hour] ?? 0;
  // Score = baseline 50 + 50 * normalized frequency. So the
  // customer's most-frequent hour scores 100; never-used hours score
  // 50; lightly-used hours scale linearly.
  const maxHits = Math.max(...profile.preferredHourHistogram);
  const ratio = maxHits > 0 ? hitsForHour / maxHits : 0;
  const baseline = 50 + Math.round(50 * ratio);

  // Soften the entire signal for flaky customers — if they reschedule
  // or no-show often, their preferences are less reliable.
  const reliability =
    1 - Math.min(1, profile.rescheduleRate * 0.5 + profile.noShowRate * 0.5);
  const score = Math.round(baseline * reliability + 70 * (1 - reliability));

  return {
    factor: "customerPreference",
    score,
    detail: `${hitsForHour}/${maxHits} hits at hour ${hour}, reliability=${reliability.toFixed(2)}`,
  };
}

/** Daily density — penalize slots on days that are already heavily
 *  loaded relative to the soft cap. Encourages spreading bookings
 *  across the week. */
export function scoreDailyDensity(
  staffDailyCount: number,
  rules: Required<FocusRules>,
): FactorScore {
  const ratio = staffDailyCount / rules.dailySoftCap;
  if (ratio < 0.5) {
    return { factor: "dailyDensity", score: 100, detail: "light day" };
  }
  if (ratio < 1) {
    return { factor: "dailyDensity", score: 80, detail: "moderate day" };
  }
  if (ratio < 1.25) {
    return { factor: "dailyDensity", score: 55, detail: "busy day" };
  }
  return { factor: "dailyDensity", score: 30, detail: "overloaded day" };
}

// ─── Composite scorer ────────────────────────────────────────────────

/** Fixed weights for the composite score. The vector is documented
 *  here so admins debugging recommendation behavior have a single
 *  place to consult. Weights sum to 100. */
export const FACTOR_WEIGHTS: Record<string, number> = {
  timeOfDay: 12,
  lunchAvoidance: 8,
  endOfDayFatigue: 8,
  bufferEfficiency: 10,
  backToBackPenalty: 12,
  focusBlockRespect: 18, // heavy weight — protects staff
  workloadBalance: 12,
  timezoneFriendly: 8,
  customerPreference: 6,
  dailyDensity: 6,
};

/** Score one slot against its full context. Returns the composite
 *  total + the per-factor breakdown (stable order — `breakdown`
 *  iterates the FACTOR_WEIGHTS keys). */
export function scoreSlot(ctx: SlotContext): SlotScore {
  const breakdown: FactorScore[] = [
    scoreTimeOfDay(ctx.slotStart, ctx.staffTimezone),
    scoreLunchAvoidance(ctx.slotStart, ctx.durationMinutes, ctx.rules as Required<FocusRules>, ctx.staffTimezone),
    scoreEndOfDayFatigue(ctx.slotStart, ctx.durationMinutes, ctx.workingWindow.end, ctx.rules as Required<FocusRules>),
    scoreBufferEfficiency(ctx.slotStart, ctx.otherBookings, ctx.rules as Required<FocusRules>),
    scoreBackToBackPenalty(ctx.slotStart, ctx.durationMinutes, ctx.otherBookings, ctx.rules as Required<FocusRules>),
    scoreFocusBlockRespect(ctx.slotStart, ctx.durationMinutes, ctx.rules as Required<FocusRules>, ctx.staffTimezone),
    scoreWorkloadBalance(ctx.staffDailyCount, ctx.rules as Required<FocusRules>),
    scoreTimezoneFriendly(ctx.slotStart, ctx.customerTimezone, ctx.staffTimezone, ctx.rules as Required<FocusRules>),
    scoreCustomerPreference(ctx.slotStart, ctx.customerTimezone, ctx.staffTimezone, ctx.customerProfile),
    scoreDailyDensity(ctx.staffDailyCount, ctx.rules as Required<FocusRules>),
  ];

  // Weighted sum. Weights sum to 100, so the resulting total stays
  // in [0..100] naturally (each factor is also bounded [0..100]).
  let total = 0;
  for (const f of breakdown) {
    const w = FACTOR_WEIGHTS[f.factor] ?? 0;
    total += (f.score * w) / 100;
  }

  return { total: Math.round(total), breakdown };
}
