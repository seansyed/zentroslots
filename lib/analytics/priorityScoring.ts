/**
 * Priority scoring for optimization recommendations — deterministic.
 *
 * Closed 4-level severity scale: low → medium → high → critical.
 *
 * A recommendation's priority is the maximum of four independent
 * sub-scores so a single dominant axis can lift it. We then snap the
 * combined score into a band:
 *
 *   financialImpact   — projected $ impact / month, log-scaled
 *   operationalPressure — how stressed the system is on this axis
 *                         (staffing pressure, cancel rate, etc.)
 *   frequency         — how often the underlying signal fires across
 *                       the trailing window (sparse one-off vs sustained)
 *   confidence        — how much history backs the claim (0..1 from
 *                       forecasting confidence; defaults to 0.5)
 *
 * Each sub-score is 0..1. The blend weights them:
 *   priorityScore = 0.40*finImpact + 0.30*operPressure +
 *                   0.15*frequency + 0.15*confidence
 *
 * Bands:
 *   < 0.30  low
 *   < 0.55  medium
 *   < 0.80  high
 *   ≥ 0.80  critical
 *
 * Pure — never throws. Inputs out of band are clamped, not rejected.
 */

export type Priority = "low" | "medium" | "high" | "critical";

export type PriorityInputs = {
  /** Projected dollar impact per month (positive = revenue gain or
   *  loss avoided). Use 0 when unknown — that drops finImpact to 0 and
   *  the recommendation gets ranked purely by pressure/confidence. */
  projectedMonthlyImpactCents: number;
  /** 0..1. How stressed the underlying system axis is. */
  operationalPressure: number;
  /** 0..1. Fraction of the trailing window in which the signal fired. */
  frequency: number;
  /** 0..1. Backing data confidence. */
  confidence: number;
};

export type PriorityResult = {
  score: number;          // 0..1
  priority: Priority;
  /** Breakdown so the dashboard can show a "why this priority" tooltip. */
  factors: {
    financialImpact: number;
    operationalPressure: number;
    frequency: number;
    confidence: number;
  };
};

// ── Tunable thresholds — change here only ───────────────────────────

/** A monthly impact at or above this value scores 1.0 on the financial
 *  axis. Below it: log-scaled. $5,000/mo feels like a strong driver
 *  for a small business and the engine wants that to read as severe. */
const FIN_IMPACT_CAP_CENTS = 5_000_00;

const BAND_LOW = 0.30;
const BAND_MEDIUM = 0.55;
const BAND_HIGH = 0.80;

const W_FIN = 0.40;
const W_PRESSURE = 0.30;
const W_FREQ = 0.15;
const W_CONF = 0.15;

// ── Helpers ─────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Log-scaled normalization: 0 → 0, CAP+ → 1, smooth in between.
 *  log1p keeps small values rising faster than linear so a $200/mo
 *  signal still produces a non-trivial impact score. */
function logScaleImpact(cents: number, cap: number): number {
  const v = Math.max(0, cents);
  if (cap <= 0) return 0;
  return clamp01(Math.log1p(v) / Math.log1p(cap));
}

// ── Entry ───────────────────────────────────────────────────────────

export function scorePriority(input: PriorityInputs): PriorityResult {
  const fin = logScaleImpact(input.projectedMonthlyImpactCents, FIN_IMPACT_CAP_CENTS);
  const pressure = clamp01(input.operationalPressure);
  const freq = clamp01(input.frequency);
  const conf = clamp01(input.confidence);

  const score =
    W_FIN * fin + W_PRESSURE * pressure + W_FREQ * freq + W_CONF * conf;

  let priority: Priority = "low";
  if (score >= BAND_HIGH) priority = "critical";
  else if (score >= BAND_MEDIUM) priority = "high";
  else if (score >= BAND_LOW) priority = "medium";

  return {
    score: Number(score.toFixed(3)),
    priority,
    factors: {
      financialImpact: Number(fin.toFixed(3)),
      operationalPressure: Number(pressure.toFixed(3)),
      frequency: Number(freq.toFixed(3)),
      confidence: Number(conf.toFixed(3)),
    },
  };
}

/** Sort recommendations by descending priority then descending score. */
export function comparePriority(a: PriorityResult, b: PriorityResult): number {
  const order: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const oa = order[a.priority];
  const ob = order[b.priority];
  if (oa !== ob) return oa - ob;
  return b.score - a.score;
}

/** Exposed for tests + dashboard tooltips. */
export const _thresholds = {
  FIN_IMPACT_CAP_CENTS,
  BAND_LOW,
  BAND_MEDIUM,
  BAND_HIGH,
  W_FIN,
  W_PRESSURE,
  W_FREQ,
  W_CONF,
} as const;
