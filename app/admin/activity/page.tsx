import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";
import ActivityCenter from "@/components/admin/ActivityCenter";
import { fetchActivityFeed } from "@/lib/admin-analytics/activity";
import { computeAnomalies } from "@/lib/admin-analytics/anomalies";

export const metadata = { title: "Activity Center" };
export const dynamic = "force-dynamic";

/**
 * /admin/activity — SA-5 Advanced Live Activity Center.
 *
 * Server-renders the first 50 events + the anomaly report so the
 * page is data-ready on first paint. Client takes over with live
 * mode polling + filter UI.
 */
export default async function ActivityCenterPage() {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });

  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const [feed, anomalies] = await Promise.all([
    fetchActivityFeed({ limit: 50, since }).catch(() => null),
    computeAnomalies().catch(() => null),
  ]);

  return (
    <Shell
      user={
        me
          ? { name: me.name, email: me.email, role: me.role }
          : { name: session.email, email: session.email, role: "admin" }
      }
      variant="super"
      title="Activity Center"
      crumbs={[{ label: "Super-admin" }, { label: "Activity" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">
        Internal — superuser only
      </div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Activity Center</h1>
      <p className="mt-1 text-sm text-slate-600">
        Cross-tenant operational stream with deterministic anomaly detection. Toggle Live Mode to
        auto-poll every 5 seconds. All values from real audit_logs.
      </p>

      <div className="mt-5">
        <ActivityCenter initial={{ feed, anomalies }} />
      </div>
    </Shell>
  );
}
