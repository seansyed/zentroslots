/**
 * Deterministic RNG for reproducible simulations.
 *
 * Mulberry32 PRNG — 32-bit state, very fast, well-distributed. Same
 * seed → same sequence. Re-running the simulation with the same seed
 * produces identical rows so we can A/B compare dashboard output
 * deterministically.
 *
 * NOT for cryptographic use. Numbers here drive simulated row
 * content; security primitives elsewhere use crypto.randomUUID().
 */

export type Rng = {
  /** Float in [0, 1). */
  next: () => number;
  /** Integer in [min, max] inclusive. */
  int: (min: number, max: number) => number;
  /** Random element from an array. */
  pick: <T>(arr: readonly T[]) => T;
  /** True with probability p (0..1). */
  bool: (p: number) => boolean;
  /** Returns a normal-ish distribution via Box–Muller. */
  normal: (mean: number, stdev: number) => number;
};

export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    bool: (p) => next() < p,
    normal: (mean, stdev) => {
      // Box–Muller; one call returns one sample (we discard the other).
      const u1 = Math.max(1e-9, next());
      const u2 = next();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return mean + z * stdev;
    },
  };
}

/** Default seed used when caller doesn't pass one. Stable across
 *  process restarts so dashboards look the same after a redeploy. */
export const DEFAULT_SEED = 0x5a4d4e54; // "ZMNT"
