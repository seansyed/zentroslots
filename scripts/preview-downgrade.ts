#!/usr/bin/env tsx
/**
 * preview-downgrade.ts
 *
 * Generates a downgrade action plan for a tenant WITHOUT mutating
 * anything. Prints the planned actions + affected entity IDs to stdout.
 *
 * Usage:
 *   npx tsx scripts/preview-downgrade.ts --tenant=<uuid> [--to=free|solo|pro|team|enterprise]
 *
 * Defaults:
 *   --to=free                 (assumes worst-case downgrade)
 *   --event=manual:<iso-now>  (used for idempotency / audit context)
 *
 * Output JSON shape:
 *   {
 *     tenantId, fromPlan, toPlan, eventId,
 *     summary: "...",
 *     actions: [{ kind, capability, mode, entityIds: [...], description }, ...]
 *   }
 *
 * Safe for production. No DB writes. Reads tenants + booking_series +
 * tenant_enforcement_overrides only.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";

import { db } from "../db/client";
import { tenants } from "../db/schema";
import { planDowngrade } from "../lib/billing/enforcement";
import { type PlanId } from "../lib/plans";

const VALID_PLANS: readonly PlanId[] = ["free", "solo", "pro", "team", "enterprise"];

function parseArgs(): { tenantId: string; toPlan: PlanId } {
  const args = process.argv.slice(2);
  let tenantId: string | null = null;
  let toPlan: PlanId = "free";
  for (const a of args) {
    if (a.startsWith("--tenant=")) tenantId = a.slice("--tenant=".length);
    else if (a.startsWith("--to=")) {
      const v = a.slice("--to=".length);
      if ((VALID_PLANS as readonly string[]).includes(v)) toPlan = v as PlanId;
      else {
        console.error(`[preview-downgrade] invalid --to=${v}; valid: ${VALID_PLANS.join(",")}`);
        process.exit(2);
      }
    }
  }
  if (!tenantId) {
    console.error("[preview-downgrade] --tenant=<uuid> is required");
    console.error("Usage: npx tsx scripts/preview-downgrade.ts --tenant=<uuid> [--to=free]");
    process.exit(2);
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(tenantId)) {
    console.error(`[preview-downgrade] tenant id doesn't look like a UUID: ${tenantId}`);
    process.exit(2);
  }
  return { tenantId, toPlan };
}

(async () => {
  const { tenantId, toPlan } = parseArgs();
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: { id: true, name: true, currentPlan: true, subscriptionStatus: true },
  });
  if (!tenant) {
    console.error(`[preview-downgrade] no tenant with id ${tenantId}`);
    process.exit(1);
  }
  const fromPlan = (VALID_PLANS as readonly string[]).includes(tenant.currentPlan)
    ? (tenant.currentPlan as PlanId)
    : "free";

  const plan = await planDowngrade({
    tenantId,
    fromPlan,
    toPlan,
    eventId: `manual:preview:${new Date().toISOString()}`,
  });

  // JSON output for grepability / pipe-into-jq.
  console.log(JSON.stringify(
    {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        currentPlan: tenant.currentPlan,
        subscriptionStatus: tenant.subscriptionStatus,
      },
      from: fromPlan,
      to: toPlan,
      summary: plan.summary,
      actions: plan.actions,
    },
    null,
    2,
  ));
  process.exit(0);
})().catch((err) => {
  console.error("[preview-downgrade] crashed:", err);
  process.exit(1);
});
