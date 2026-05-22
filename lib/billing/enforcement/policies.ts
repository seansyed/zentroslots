/**
 * Default enforcement policy per capability + per-tenant override
 * resolver.
 *
 * Policy contract:
 *   Default for every capability is GRANDFATHERED. This matches the
 *   user's stated tradeoff from Phase 1 (hard-enforce on writes,
 *   grandfather existing rows). The orchestrator can be made stricter
 *   per-tenant via `tenant_enforcement_overrides`, but the default
 *   never gets more aggressive than the user originally agreed to.
 *
 *   Operators set per-tenant overrides via SQL or a future admin UI:
 *     INSERT INTO tenant_enforcement_overrides
 *       (tenant_id, capability, mode, expires_at, granted_by, reason)
 *       VALUES (..., 'recurring_series', 'hard', NULL,
 *               'support:1234', 'customer requested cleanup')
 *
 * The resolver returns the EFFECTIVE mode given the override table
 * state at lookup time. Time-bounded overrides (expires_at < now) are
 * ignored — the resolver falls back to the default.
 */
import { and, eq } from "drizzle-orm";

import { db as defaultDb } from "@/db/client";
import { tenantEnforcementOverrides } from "@/db/schema";
import type { Capability } from "@/lib/billing/capabilities";

import { type EnforcementMode, isEnforcementMode } from "./types";

// ─── Default policy matrix ───────────────────────────────────────────
//
// One entry per Capability. Every default is "grandfathered" — that's
// the user's chosen baseline. Per-tenant overrides can promote
// individual capabilities to "hard" (pause) or demote to "soft"
// (warn-only).

export const DEFAULT_ENFORCEMENT_POLICY: Record<Capability, EnforcementMode> = {
  recurring_series: "grandfathered",
  automation_rules: "grandfathered",
  routing_rules: "grandfathered",
  booking_rules: "grandfathered",
  scheduled_reports: "grandfathered",
  custom_domains: "grandfathered",
  hide_powered_by: "grandfathered",
  // Analytics export is a read action, not a stateful row collection.
  // "Grandfathered" makes no sense for a one-shot action — hard-enforce
  // is the only sensible mode. (Phase 1 already 402s the route on Free.)
  analytics_export: "hard",
};

// ─── Override resolver ────────────────────────────────────────────────

export type ResolvedPolicy = {
  capability: Capability;
  mode: EnforcementMode;
  /** True when the mode came from a per-tenant override, false when
   *  it's the default. Useful for audit emission ("this was applied
   *  because operator X set the override on Y"). */
  fromOverride: boolean;
  /** Operator who set the override; null when default. */
  grantedBy: string | null;
  /** Override reason; null when default. */
  reason: string | null;
  /** When the override expires; null when default OR when override
   *  has no expiry. */
  expiresAt: Date | null;
};

/**
 * Resolve the effective enforcement mode for one (tenant, capability)
 * pair. Cheap — one indexed lookup. Operates over a passed-in db so
 * the executor can wrap multiple resolutions in a single transaction
 * if it ever needs to.
 */
export async function resolvePolicy(args: {
  tenantId: string;
  capability: Capability;
  db?: typeof defaultDb;
  /** Override `now` for tests. Defaults to wall-clock. */
  now?: Date;
}): Promise<ResolvedPolicy> {
  const { tenantId, capability, db = defaultDb, now = new Date() } = args;
  const row = await db.query.tenantEnforcementOverrides.findFirst({
    where: and(
      eq(tenantEnforcementOverrides.tenantId, tenantId),
      eq(tenantEnforcementOverrides.capability, capability),
    ),
  });

  const fallback = (): ResolvedPolicy => ({
    capability,
    mode: DEFAULT_ENFORCEMENT_POLICY[capability],
    fromOverride: false,
    grantedBy: null,
    reason: null,
    expiresAt: null,
  });

  if (!row) return fallback();

  // Expired override → fall back to default. Don't auto-delete the
  // row; let an ops cron prune for clarity later.
  if (row.expiresAt && row.expiresAt < now) return fallback();

  if (!isEnforcementMode(row.mode)) {
    // Defensive — operator inserted an unknown mode string.
    // Fall back to default rather than crash.
    console.warn(
      `[enforcement] unknown mode '${row.mode}' for tenant ${tenantId} / ${capability}; using default`,
    );
    return fallback();
  }

  return {
    capability,
    mode: row.mode,
    fromOverride: true,
    grantedBy: row.grantedBy,
    reason: row.reason,
    expiresAt: row.expiresAt ?? null,
  };
}

/**
 * Resolve every capability's policy for a tenant in one round-trip.
 * Used by the action planner to build a complete per-tenant snapshot.
 */
export async function resolveAllPolicies(args: {
  tenantId: string;
  db?: typeof defaultDb;
  now?: Date;
}): Promise<Record<Capability, ResolvedPolicy>> {
  const { tenantId, db = defaultDb, now = new Date() } = args;
  const rows = await db.query.tenantEnforcementOverrides.findMany({
    where: eq(tenantEnforcementOverrides.tenantId, tenantId),
  });
  const byCapability = new Map(rows.map((r) => [r.capability, r]));

  const out = {} as Record<Capability, ResolvedPolicy>;
  for (const cap of Object.keys(DEFAULT_ENFORCEMENT_POLICY) as Capability[]) {
    const row = byCapability.get(cap);
    if (!row) {
      out[cap] = {
        capability: cap,
        mode: DEFAULT_ENFORCEMENT_POLICY[cap],
        fromOverride: false,
        grantedBy: null,
        reason: null,
        expiresAt: null,
      };
      continue;
    }
    if (row.expiresAt && row.expiresAt < now) {
      out[cap] = {
        capability: cap,
        mode: DEFAULT_ENFORCEMENT_POLICY[cap],
        fromOverride: false,
        grantedBy: null,
        reason: null,
        expiresAt: null,
      };
      continue;
    }
    out[cap] = {
      capability: cap,
      mode: isEnforcementMode(row.mode) ? row.mode : DEFAULT_ENFORCEMENT_POLICY[cap],
      fromOverride: true,
      grantedBy: row.grantedBy,
      reason: row.reason,
      expiresAt: row.expiresAt ?? null,
    };
  }
  return out;
}
