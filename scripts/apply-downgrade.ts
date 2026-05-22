#!/usr/bin/env tsx
/**
 * apply-downgrade.ts
 *
 * Runs the downgrade orchestrator IN MUTATION MODE for a tenant.
 * Operator-triggered only — this script is NOT called from the Stripe
 * webhook. The webhook emits `billing.downgrade_applied` for
 * observability; the operator reviews and runs this when ready.
 *
 * Usage:
 *   # Dry-run preview (no mutation):
 *   npx tsx scripts/apply-downgrade.ts --tenant=<uuid> [--to=free]
 *
 *   # Actually mutate (REQUIRES --confirm):
 *   npx tsx scripts/apply-downgrade.ts --tenant=<uuid> --to=free --confirm
 *
 * Without --confirm, the script behaves identically to preview-downgrade
 * — same plan, same audit emission (with dry_run=true metadata), no
 * row mutation.
 *
 * With --confirm, the executor runs each action handler. RECURRING is
 * the only feature with a real handler in this commit; other features
 * emit `not_implemented` audit rows + return without mutation.
 *
 * Idempotent: re-running with the same event_id is a no-op for rows
 * already paused under that id. Safe to re-run after partial failures.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";

import { db } from "../db/client";
import { tenants } from "../db/schema";
import { planDowngrade, executeDowngradePlan } from "../lib/billing/enforcement";
import { type PlanId } from "../lib/plans";

const VALID_PLANS: readonly PlanId[] = ["free", "solo", "pro", "team", "enterprise"];

function parseArgs(): {
  tenantId: string;
  toPlan: PlanId;
  confirm: boolean;
  eventId: string;
} {
  const args = process.argv.slice(2);
  let tenantId: string | null = null;
  let toPlan: PlanId = "free";
  let confirm = false;
  let eventId: string | null = null;
  for (const a of args) {
    if (a.startsWith("--tenant=")) tenantId = a.slice("--tenant=".length);
    else if (a.startsWith("--to=")) {
      const v = a.slice("--to=".length);
      if ((VALID_PLANS as readonly string[]).includes(v)) toPlan = v as PlanId;
      else {
        console.error(`[apply-downgrade] invalid --to=${v}; valid: ${VALID_PLANS.join(",")}`);
        process.exit(2);
      }
    } else if (a === "--confirm") confirm = true;
    else if (a.startsWith("--event=")) eventId = a.slice("--event=".length);
  }
  if (!tenantId) {
    console.error("[apply-downgrade] --tenant=<uuid> is required");
    console.error(
      "Usage: npx tsx scripts/apply-downgrade.ts --tenant=<uuid> [--to=free] [--confirm] [--event=<id>]",
    );
    process.exit(2);
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(tenantId)) {
    console.error(`[apply-downgrade] tenant id doesn't look like a UUID: ${tenantId}`);
    process.exit(2);
  }
  if (!eventId) eventId = `manual:apply:${new Date().toISOString()}`;
  return { tenantId, toPlan, confirm, eventId };
}

(async () => {
  const { tenantId, toPlan, confirm, eventId } = parseArgs();
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: { id: true, name: true, currentPlan: true },
  });
  if (!tenant) {
    console.error(`[apply-downgrade] no tenant with id ${tenantId}`);
    process.exit(1);
  }
  const fromPlan = (VALID_PLANS as readonly string[]).includes(tenant.currentPlan)
    ? (tenant.currentPlan as PlanId)
    : "free";

  const plan = await planDowngrade({ tenantId, fromPlan, toPlan, eventId });

  console.log(`[apply-downgrade] tenant=${tenant.name} (${tenantId})`);
  console.log(`[apply-downgrade] ${plan.summary}`);
  console.log(`[apply-downgrade] event_id=${eventId}`);
  console.log(`[apply-downgrade] mode=${confirm ? "APPLY (mutate)" : "DRY-RUN (no mutation)"}`);

  const result = await executeDowngradePlan(plan, {
    dryRun: !confirm,
    actorLabel: `manual:cli:${process.env.USER ?? "unknown"}`,
  });

  console.log(`[apply-downgrade] ok=${result.ok}`);
  for (const r of result.results) {
    console.log(
      `  - ${r.kind} (${r.capability}) → ${r.status} affected=${r.affected}${r.error ? ` error=${r.error}` : ""}`,
    );
  }
  process.exit(result.ok ? 0 : 1);
})().catch((err) => {
  console.error("[apply-downgrade] crashed:", err);
  process.exit(1);
});
