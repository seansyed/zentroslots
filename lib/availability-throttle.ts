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
 *   • Deterministic + stable: same input → same output (no randomness), so a
 *     public page refresh shows the same slots until real availability changes.
 *   • Spread, not "first N": the day is split into N buckets and the center of
 *     each is kept, so morning/midday/afternoon stay represented.
 *   • Never invents a slot (output ⊆ input) and never reorders.
 *   • Respects a per-day minimum; if total ≤ minimum, returns all slots.
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
 * Throttle ONE day's available slots for public display.
 *
 * @param slots  ISO instants for a single day, ascending (the /api/slots contract).
 * @param mode   display mode; "normal" returns the slots unchanged.
 * @param minimumVisibleSlotsPerDay  floor on visible slots (default 3).
 */
export function throttleSlots(
  slots: string[],
  mode: AvailabilityDisplayMode,
  minimumVisibleSlotsPerDay = 3,
): string[] {
  if (mode === "normal") return slots;

  const total = slots.length;
  if (total === 0) return slots;

  const minVisible = Math.max(1, Math.floor(minimumVisibleSlotsPerDay));
  // At or below the floor → show everything (e.g. only 2 slots, min 3 → both).
  if (total <= minVisible) return slots;

  // Target count: apply the mode fraction, lift to the minimum, cap at total.
  let target = Math.ceil(total * FACTOR[mode]);
  target = Math.max(target, minVisible);
  target = Math.min(target, total);
  if (target >= total) return slots;

  // Even spread: split the time-sorted day into `target` buckets, keep the
  // center of each. step > 1 here (target < total), so the floored indices
  // are strictly increasing → exactly `target` unique, evenly-spaced slots.
  const step = total / target;
  const out: string[] = [];
  for (let i = 0; i < target; i++) {
    out.push(slots[Math.floor(i * step + step / 2)]!);
  }
  return out;
}
