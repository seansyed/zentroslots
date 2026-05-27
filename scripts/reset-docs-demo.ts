#!/usr/bin/env tsx
/**
 * reset-docs-demo.ts — Wipe ONLY the permanent docs-demo workspace.
 *
 * Counterpart to seed-docs-demo.ts. Uses the "docs-demo-v1" marker
 * stored in tenants.onboarding_progress->'seeded_by' as the WHERE
 * clause. Real customer data and dev-seeding chaos data ("dev-seeding-v1")
 * are NEVER touched.
 *
 * Order of deletes mirrors FK ordering — leaf tables first, then
 * users (because users.tenant_id is ON DELETE RESTRICT), then tenants.
 *
 * Usage:
 *   ALLOW_DEV_SIMULATION=true npm run docs-demo:reset
 *
 * Typical flow:
 *   ALLOW_DEV_SIMULATION=true npm run docs-demo:reset
 *   ALLOW_DEV_SIMULATION=true npm run docs-demo:seed
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

const DOCS_DEMO_MARKER = "docs-demo-v1" as const;

async function main() {
  if (process.env.ALLOW_DEV_SIMULATION !== "true") {
    console.error(
      "Refusing to reset: ALLOW_DEV_SIMULATION must be 'true'. " +
        "Set this env var on the target environment before running.",
    );
    process.exit(2);
  }

  // 1) Find marker-matched tenant ids.
  const rows = (await db.execute(
    sql`SELECT id::text AS id, slug, name FROM tenants
        WHERE onboarding_progress->>'seeded_by' = ${DOCS_DEMO_MARKER}
           OR is_demo = true AND slug LIKE 'docs-demo%'`,
  )) as unknown as Array<{ id: string; slug: string; name: string }>;

  if (rows.length === 0) {
    console.log(JSON.stringify({ evt: "docs_demo_reset_noop", reason: "no_marker_match" }));
    process.exit(0);
  }

  const ids = rows.map((r) => r.id);
  const idList = sql.raw(`ARRAY[${ids.map((id) => `'${id}'`).join(",")}]::uuid[]`);
  const targets = rows.map((r) => ({ slug: r.slug, name: r.name }));

  let totalDeleted = 0;

  // 2) Delete child rows. Order matters because of FK constraints.
  //    Each table is tried independently so a missing table (e.g. a
  //    feature not yet migrated on this env) doesn't abort the rest.
  const tableDeletes = [
    "push_deliveries",
    "push_tokens",
    "booking_occurrences",
    "booking_series",
    "calendar_events",
    "group_sessions",
    "waitlist_notifications",
    "waitlists",
    "pending_automations",
    "automations",
    "analytics_daily_snapshots",
    "billing_transactions",
    "communication_logs",
    "audit_logs",
    "tasks",
    "bookings",
    "service_staff",
    "services",
    "customers",
    "calendar_connections",
    "availability",
    "departments",
    "staff_location_assignments",
    "locations",
    "users",
  ];

  for (const table of tableDeletes) {
    try {
      const res = (await db.execute(
        sql`DELETE FROM ${sql.raw(table)} WHERE tenant_id = ANY(${idList}) RETURNING tenant_id`,
      )) as unknown as Array<unknown>;
      totalDeleted += res.length;
    } catch (err) {
      // Either table doesn't exist on this env or has a different
      // tenant column — log but continue. The marker safety net
      // means we never accidentally touch real data here.
      console.warn(
        JSON.stringify({
          evt: "docs_demo_reset_table_skip",
          table,
          err: err instanceof Error ? err.message.slice(0, 160) : "unknown",
        }),
      );
    }
  }

  // 3) Finally, delete the tenants themselves.
  try {
    const res = (await db.execute(
      sql`DELETE FROM tenants WHERE id = ANY(${idList}) RETURNING id`,
    )) as unknown as Array<unknown>;
    totalDeleted += res.length;
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "docs_demo_reset_tenants_failed",
        err: err instanceof Error ? err.message : "unknown",
      }),
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      evt: "docs_demo_reset_complete",
      marker: DOCS_DEMO_MARKER,
      tenants_removed: targets,
      total_rows_deleted: totalDeleted,
    }),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(JSON.stringify({ evt: "docs_demo_reset_failed", error: String(err) }));
    process.exit(1);
  });
