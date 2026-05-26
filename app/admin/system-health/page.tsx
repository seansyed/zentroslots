import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";
import SystemHealthClient from "@/components/admin/SystemHealthClient";
import { computeInfrastructureHealth } from "@/lib/admin-analytics/health";
import { computeIntegrationsMatrix } from "@/lib/admin-analytics/integrations";
import { computeCommsMonitoring } from "@/lib/admin-analytics/comms";
import { fetchActivityFeed } from "@/lib/admin-analytics/activity";

export const metadata = { title: "Platform Health Center" };
export const dynamic = "force-dynamic";

/**
 * /admin/system-health — SA-3 Platform Health Center.
 *
 * Server-renders the four section bundles for fast first paint, then
 * the client component takes over with 60s auto-refresh.
 *
 * Per-section fatal-throw isolation: any section that throws at the
 * orchestrator level passes `null` to the client, which renders its
 * own loading/empty fallback for that section while the other three
 * render normally.
 */
export default async function SystemHealthPage() {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });

  const [infra, integrations, comms, feed] = await Promise.all([
    computeInfrastructureHealth().catch(() => null),
    computeIntegrationsMatrix().catch(() => null),
    computeCommsMonitoring().catch(() => null),
    fetchActivityFeed({ limit: 50 }).catch(() => null),
  ]);

  return (
    <Shell
      user={
        me
          ? { name: me.name, email: me.email, role: me.role }
          : { name: session.email, email: session.email, role: "admin" }
      }
      variant="super"
      title="Platform Health Center"
      crumbs={[{ label: "Super-admin" }, { label: "System health" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">
        Internal — superuser only
      </div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Platform Health Center</h1>
      <p className="mt-1 text-sm text-slate-600">
        Live operations monitoring. Auto-refreshes every 60s. All values from real DB queries.
      </p>

      <div className="mt-6">
        <SystemHealthClient
          initial={{
            infra,
            integrations,
            comms,
            feed,
          }}
        />
      </div>
    </Shell>
  );
}
