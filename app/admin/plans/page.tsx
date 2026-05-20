import { asc } from "drizzle-orm";

import { db } from "@/db/client";
import { plans } from "@/db/schema";
import { AdminShell } from "../_shell";
import PlansClient from "./PlansClient";

export const metadata = { title: "Plans — Super admin" };
// Force dynamic — admin pages read live DB on every request and
// must not be prerendered at build time. Avoids coupling builds to
// DB reachability + matches the page's actual SSR semantics.
export const dynamic = "force-dynamic";

export default async function AdminPlansPage() {
  const rows = await db
    .select()
    .from(plans)
    .orderBy(asc(plans.sortOrder), asc(plans.priceMonthlyCents));

  // Serialize Date objects to strings — they don't survive the
  // server→client boundary as Date instances reliably.
  const serialized = rows.map((p) => ({
    ...p,
    features: Array.isArray(p.features) ? (p.features as string[]) : [],
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));

  return (
    <AdminShell
      title="Plans & pricing"
      crumbs={[{ label: "Super-admin", href: "/admin" }, { label: "Plans" }]}
    >
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        Edit pricing and quotas in place. Slug is the join key used by tenants&rsquo; <code>current_plan</code> —
        changing it would orphan existing tenants, so slugs are immutable once created.
      </p>
      <PlansClient initialPlans={serialized} />
    </AdminShell>
  );
}
