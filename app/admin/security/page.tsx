import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";
import SecurityClient from "@/components/admin/SecurityClient";
import {
  computeSecurityKpis,
  computeIpIntelligence,
  fetchAuditRows,
  fetchPermissionEvents,
} from "@/lib/admin-analytics/security";

export const metadata = { title: "Security & Audit Operations" };
export const dynamic = "force-dynamic";

/**
 * /admin/security — SA-7 Security & Audit Operations Center.
 *
 * Server-renders all four sections in parallel for fast first paint.
 * Per-section fatal isolation: any module that throws passes null;
 * the client renders an amber error placeholder for that section
 * while the others continue working normally.
 */
export default async function SecurityCenterPage() {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });

  const [kpis, ipIntel, audit, permissions] = await Promise.all([
    computeSecurityKpis().catch(() => null),
    computeIpIntelligence().catch(() => null),
    fetchAuditRows({ limit: 50 }).catch(() => null),
    fetchPermissionEvents({ limit: 50 }).catch(() => null),
  ]);

  return (
    <Shell
      user={
        me
          ? { name: me.name, email: me.email, role: me.role }
          : { name: session.email, email: session.email, role: "admin" }
      }
      variant="super"
      title="Security & Audit Operations"
      crumbs={[{ label: "Super-admin" }, { label: "Security" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">
        Internal — superuser only
      </div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Security &amp; Audit Operations</h1>
      <p className="mt-1 text-sm text-slate-600">
        Cross-tenant security posture, audit explorer, IP intelligence, and permission tracking.
        Every metric is derived from real <code className="text-[11px]">audit_logs</code> rows; no
        third-party signals, no inferred labels.
      </p>

      <div className="mt-5">
        <SecurityClient initial={{ kpis, ipIntel, audit, permissions }} />
      </div>
    </Shell>
  );
}
