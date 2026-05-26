/**
 * Dev-seeding guards — never let simulation run by accident in production.
 *
 * Three independent gates that must ALL be open before any seeder
 * touches the DB:
 *
 *   1. ALLOW_DEV_SIMULATION env var must be the literal string "true".
 *      A typo, a missing value, or `false` blocks execution.
 *
 *   2. requireSuperAdmin() must succeed (HTTP route gate). API routes
 *      call this BEFORE invoking any seeder.
 *
 *   3. assertSeedingAllowed() runs inside each seeder as defense in
 *      depth — even if someone wires a seeder into a code path that
 *      bypasses the route gate, this throws.
 *
 * Plus, every seeded row is marked with SEEDED_BY_MARKER in its
 * metadata jsonb. resetSimulation() only deletes rows carrying the
 * marker. Real customer data is never touched even if the seeders
 * run on a populated tenant DB by mistake.
 */

/** Marker stored on every seeded row's metadata. Reset uses it as
 *  the WHERE clause so real rows are NEVER deleted. */
export const SEEDED_BY_MARKER = "dev-seeding-v1" as const;

/** Throws when simulation is not explicitly enabled in this environment. */
export function assertSeedingAllowed(): void {
  if (process.env.ALLOW_DEV_SIMULATION !== "true") {
    throw new Error(
      "Dev seeding disabled. Set ALLOW_DEV_SIMULATION=true on this environment to enable.",
    );
  }
}

/** Cheap check — used by UI to render an "enabled / disabled" banner.
 *  Does not throw. */
export function isSeedingEnabled(): boolean {
  return process.env.ALLOW_DEV_SIMULATION === "true";
}

/** Tag metadata helper. Every seeded row's metadata jsonb gets this. */
export function seedMetadata(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    seeded_by: SEEDED_BY_MARKER,
    seeded_at: new Date().toISOString(),
  };
}
