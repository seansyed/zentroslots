import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";
import SimulationClient from "@/components/admin/SimulationClient";
import { getSimulationStatus, isSeedingEnabled } from "@/lib/dev-seeding";

export const metadata = { title: "Simulation Control" };
export const dynamic = "force-dynamic";

/**
 * /admin/dev/simulation — internal dev tool to populate dashboards
 * with realistic synthetic SaaS telemetry. Triple-gated:
 *   1. requireSuperAdmin (this page)
 *   2. ALLOW_DEV_SIMULATION env (banner + lib boundary)
 *   3. SEEDED_BY_MARKER on every row (reset never touches real data)
 */
export default async function SimulationControlPage() {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });

  const enabled = isSeedingEnabled();
  const status = enabled
    ? await getSimulationStatus().catch(() => ({ tenants: 0, users: 0, bookings: 0, auditLogs: 0 }))
    : { tenants: 0, users: 0, bookings: 0, auditLogs: 0 };

  // Docs-demo status — separate marker so reset of the chaos simulation
  // doesn't touch the permanent documentation workspace. Read-only here;
  // mutate via CLI: `npm run docs-demo:seed` / `npm run docs-demo:reset`.
  const docsDemoTenants = await db
    .select({
      slug: tenants.slug,
      name: tenants.name,
      plan: tenants.plan,
      onboardingCompletedAt: tenants.onboardingCompletedAt,
    })
    .from(tenants)
    .where(
      sql`${tenants.isDemo} = true AND ${tenants.slug} LIKE 'docs-demo%'`,
    )
    .catch(() => [] as Array<{ slug: string; name: string; plan: string; onboardingCompletedAt: Date | null }>);

  return (
    <Shell
      user={
        me
          ? { name: me.name, email: me.email, role: me.role }
          : { name: session.email, email: session.email, role: "admin" }
      }
      variant="super"
      title="Simulation Control"
      crumbs={[{ label: "Super-admin" }, { label: "Dev" }, { label: "Simulation" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">
        Internal — superuser only — synthetic data
      </div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Simulation Control Center</h1>
      <p className="mt-1 text-sm text-slate-600">
        Populates super-admin dashboards with realistic synthetic SaaS telemetry. Every seeded row
        is tagged so <strong>Reset</strong> can wipe them cleanly. Real customer data is never
        touched, even on a populated DB.
      </p>
      <div className="mt-5">
        <SimulationClient initial={{ enabled, status }} />
      </div>

      {/* Docs-demo permanent workspace — read-only status. Managed via
          CLI (npm run docs-demo:seed / :reset) because click-to-wipe
          on a permanent demo is too easy to misfire. */}
      <div className="mt-10 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Documentation / Screenshot
            </div>
            <h2 className="mt-1 text-lg font-semibold text-ink">
              Permanent Demo Workspace
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Frozen-fixture tenants for KB, onboarding intelligence, and
              autonomous screenshot capture. Side effects (email / push /
              calendar / Stripe) are suppressed by{" "}
              <code className="rounded bg-slate-100 px-1">lib/demo-safe.ts</code>.
            </p>
          </div>
          <div className="flex h-9 items-center rounded-md border border-blue-200 bg-blue-50 px-3 text-xs font-medium text-blue-700">
            {docsDemoTenants.length} tenant{docsDemoTenants.length === 1 ? "" : "s"}
          </div>
        </div>
        {docsDemoTenants.length > 0 ? (
          <ul className="mt-4 divide-y divide-slate-100 rounded-md border border-slate-200">
            {docsDemoTenants.map((t) => (
              <li
                key={t.slug}
                className="flex items-center justify-between px-3 py-2 text-sm"
              >
                <div>
                  <div className="font-medium text-ink">{t.name}</div>
                  <div className="text-xs text-slate-500">
                    /u/{t.slug} · {t.plan} · {t.onboardingCompletedAt ? "onboarded" : "in progress"}
                  </div>
                </div>
                <a
                  href={`/u/${t.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Open booking page →
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-4 rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
            No docs-demo tenants seeded yet. From the EC2 host:{" "}
            <code className="rounded bg-white px-1">
              ALLOW_DEV_SIMULATION=true npm run docs-demo:seed
            </code>
          </div>
        )}
        <div className="mt-3 text-xs text-slate-500">
          Marker:{" "}
          <code className="rounded bg-slate-100 px-1">docs-demo-v1</code>{" "}
          · CLI:{" "}
          <code className="rounded bg-slate-100 px-1">npm run docs-demo:seed</code>{" "}
          /{" "}
          <code className="rounded bg-slate-100 px-1">npm run docs-demo:reset</code>{" "}
          · Runbook:{" "}
          <code className="rounded bg-slate-100 px-1">
            docs/operations/demo-tenant.md
          </code>
        </div>
      </div>
    </Shell>
  );
}
