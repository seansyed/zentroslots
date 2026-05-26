import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
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
    </Shell>
  );
}
