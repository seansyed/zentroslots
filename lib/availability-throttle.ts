/**
 * "Show Fewer Open Slots" — deterministic public-availability throttling.
 *
 * Reduces the slots a CLIENT sees on the public booking page, while the real
 * schedule is unchanged. This runs ONLY at the end of the public slot path
 * (app/api/slots Mode B, non-internal callers) — it filters an already-computed
 * list; it never participates in availability calculation, and never affects
 * internal/admin views.
 *
 * Guarantees:
 *   • Deterministic + stable: same inputs (incl. context) → same output (no
 *     randomness, no time/refresh input), so a public page refresh shows the
 *     same slots until real availability changes.
 *   • Varies by DAY (with context): a deterministic seed derived from
 *     staff/service/date/tz/mode/max picks one slot per bucket, so different
 *     dates surface different times while each date stays refresh-stable. The
 *     seed mirrors getAvailableSlots() inputs, so /api/slots and the booking
 *     POST agree on the visible set. Without context → legacy bucket centers.
 *   • Spread, not "first N": the day is split into N buckets and one slot per
 *     bucket is kept, so morning/midday/afternoon stay represented.
 *   • Never invents a slot (output ⊆ input) and never reorders.
 *   • Caps at a per-day MAXIMUM; if total ≤ maximum, returns all slots. The
 *     mode fraction sets the natural count and the maximum is a hard ceiling —
 *     the result is min(modeCount, maximum), never above the configured max,
 *     and always ≥ 1 when the mode is on and real availability exists.
 *
 * Pure module (no deps) — unit-tested in tests/availability-throttle.test.ts.
 */

export type AvailabilityDisplayMode = "normal" | "balanced" | "limited" | "very_limited";

export const AVAILABILITY_DISPLAY_MODES = [
  "normal",
  "balanced",
  "limited",
  "very_limited",
] as const;

/** Fraction of slots kept per mode. */
const FACTOR: Record<AvailabilityDisplayMode, number> = {
  normal: 1,
  balanced: 0.6,
  limited: 0.35,
  very_limited: 0.2,
};

export function isAvailabilityDisplayMode(v: unknown): v is AvailabilityDisplayMode {
  return typeof v === "string" && (AVAILABILITY_DISPLAY_MODES as readonly string[]).includes(v);
}

/**
 * Stable context for per-day VARIATION (no time/refresh/request data — all
 * fields are stable for a given staff/service/day, so the same day always
 * yields the same slots while different days vary). These mirror the
 * getAvailableSlots() inputs, so /api/slots and the public booking POST derive
 * the SAME visible set (hidden slots stay unbookable). All optional: with no
 * context, throttleSlots falls back to the legacy even-spread (bucket-center).
 */
export type ThrottleContext = {
  staffId?: string;
  serviceId?: string;
  /** yyyy-mm-dd of the day being thrown — the variation driver. */
  date?: string;
  timezone?: string;
};

/**
 * Throttle ONE day's available slots for public display.
 *
 * @param slots  ISO instants for a single day, ascending (the /api/slots contract).
 * @param mode   display mode; "normal" returns the slots unchanged.
 * @param maximumVisibleSlotsPerDay  HARD CAP on visible slots (default 3, min 1).
 *   The result is min(modeCount, maximum): clients never see more than this many
 *   slots per day. (The persisted column is still named `minimum_visible_slots_
 *   per_day` for back-compat — migration 0075 — but its VALUE is a maximum.)
 * @param ctx  optional stable context. When provided, one slot is chosen per
 *   bucket via a DETERMINISTIC SEEDED index (seed = staff|service|date|tz|mode|
 *   max), so the visible slots vary by date yet stay identical on refresh.
 *   Without it, the legacy bucket-CENTER spread is used (unchanged).
 */
export function throttleSlots(
  slots: string[],
  mode: AvailabilityDisplayMode,
  maximumVisibleSlotsPerDay = 3,
  ctx?: ThrottleContext,
): string[] {
  if (mode === "normal") return slots;

  const total = slots.length;
  if (total === 0) return slots;

  // Hard ceiling on visible slots. Always ≥ 1 (0 is not a valid cap — when the
  // mode is on and real availability exists, show at least one slot).
  const maxVisible = Math.max(1, Math.floor(maximumVisibleSlotsPerDay));
  // Fewer real slots than the cap → show them all (e.g. 2 slots, max 4 → both).
  if (total <= maxVisible) return slots;

  // The mode fraction gives the natural count; the maximum is a hard ceiling.
  // target = min(modeCount, maxVisible), floored at 1, never above total — so
  // very_limited on 31 slots with max=4 yields 4, not 7.
  let target = Math.ceil(total * FACTOR[mode]);
  target = Math.min(target, maxVisible);
  target = Math.max(target, 1);
  target = Math.min(target, total);
  if (target >= total) return slots;

  // Split the time-sorted day into `target` buckets. step ≥ 1 (target ≤ total),
  // so each bucket [floor(i*step), floor((i+1)*step)) holds ≥ 1 index and the
  // buckets are disjoint + ascending → exactly `target` unique, spread slots.
  const step = total / target;

  const hasCtx = !!ctx && !!(ctx.staffId || ctx.serviceId || ctx.date || ctx.timezone);
  if (!hasCtx) {
    // Legacy deterministic even-spread: keep each bucket's CENTER. Unchanged
    // output for tests / callers that pass no context.
    const out: string[] = [];
    for (let i = 0; i < target; i++) {
      out.push(slots[Math.floor(i * step + step / 2)]!);
    }
    return out;
  }

  // Deterministic SEEDED pick within each bucket. The seed is stable per
  // (staff, service, date, tz, mode, max) — no time/refresh/request input — so
  // the SAME day always returns the SAME slots (refresh-stable) while DIFFERENT
  // days vary naturally. Buckets stay disjoint, so picks are unique and spread.
  const seedStr = [
    ctx!.staffId ?? "",
    ctx!.serviceId ?? "",
    ctx!.date ?? "",
    ctx!.timezone ?? "",
    mode,
    String(maxVisible),
  ].join("|");
  const rand = mulberry32(hash32(seedStr));

  const out: string[] = [];
  const used = new Set<number>();
  for (let i = 0; i < target; i++) {
    const lo = Math.floor(i * step);
    const hi = Math.floor((i + 1) * step); // exclusive bucket end
    const size = Math.max(1, hi - lo);
    let idx = Math.min(lo + Math.floor(rand() * size), total - 1);
    // Defensive: buckets are disjoint so this shouldn't collide, but if a
    // degenerate/empty bucket produces a dup, walk to the nearest free index.
    if (used.has(idx)) {
      let j = idx + 1;
      while (j < total && used.has(j)) j++;
      if (j >= total) { j = idx - 1; while (j >= 0 && used.has(j)) j--; }
      idx = j;
    }
    used.add(idx);
    out.push(slots[idx]!);
  }
  // Disjoint ascending buckets already yield chronological order; sort to be
  // safe (ISO-8601 sorts lexically === chronologically).
  out.sort();
  return out;
}

// ─── Deterministic, dependency-free seed + PRNG (pure) ────────────────
// xmur3-style string hash → 32-bit unsigned seed.
function hash32(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}
// mulberry32 PRNG → deterministic float in [0, 1).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
