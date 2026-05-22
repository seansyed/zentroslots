import { redirect } from "next/navigation";
import { and, desc, eq, gte } from "drizzle-orm";

import { db } from "@/db/client";
import { auditLogs, exportAuditEvents, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import GovernanceClient from "@/components/dashboard/GovernanceClient";
import { effectivePermissions, userHasPermission } from "@/lib/security/permissions";
import { loadEffectivePolicy } from "@/lib/governance/policies";
import { HARD_FLOOR_DAYS } from "@/lib/governance/types";

export const metadata = { title: "Governance" };
export const dynamic = "force-dynamic";

export default async function GovernancePage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  // Page is gated by canManageSecurity. Server enforces the same on
  // PATCH; this is the front-door redirect for the UI surface.
  if (!userHasPermission(user, "canManageSecurity")) {
    redirect("/dashboard");
  }

  const permissions = effectivePermissions(user);
  const policy = await loadEffectivePolicy(tenant.id);

  // Recent governance audit rows (last 30 days, capped).
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const governanceEvents = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      actorLabel: auditLogs.actorLabel,
      metadata: auditLogs.metadata,
      ipAddress: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.tenantId, tenant.id),
        gte(auditLogs.createdAt, cutoff)
      )
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(50);

  const governanceFiltered = governanceEvents.filter((e) =>
    e.action === "security.governance.updated" ||
    e.action === "security.retention.executed" ||
    e.action === "security.policy.changed" ||
    e.action === "security.export.executed"
  );

  // Export-audit recent activity.
  const exports = await db
    .select()
    .from(exportAuditEvents)
    .where(
      and(
        eq(exportAuditEvents.tenantId, tenant.id),
        gte(exportAuditEvents.exportedAt, cutoff)
      )
    )
    .orderBy(desc(exportAuditEvents.exportedAt))
    .limit(50);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role, permissions }}
      tenant={{
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.currentPlan,
        logoUrl: tenant.logoUrl,
      }}
      title="Governance Center"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Governance Center" },
      ]}
    >
      {/* Page hero is rendered inside the client so the posture badge,
          last-update timestamp, and KPI strip can react instantly to
          policy edits without a full server round-trip. */}
      <GovernanceClient
        tenantName={tenant.name}
        policy={policy}
        hardFloors={HARD_FLOOR_DAYS}
        governanceEvents={governanceFiltered.map((e) => ({
          id: e.id,
          action: e.action,
          actorLabel: e.actorLabel,
          metadata: (e.metadata as Record<string, unknown>) ?? {},
          ipAddress: e.ipAddress,
          createdAt: e.createdAt.toISOString(),
        }))}
        exports={exports.map((e) => ({
          id: e.id,
          userId: e.userId,
          exportType: e.exportType,
          recordCount: e.recordCount,
          fileSizeBytes: e.fileSizeBytes,
          filtersUsed: (e.filtersUsed as Record<string, unknown>) ?? {},
          ipAddress: e.ipAddress,
          exportedAt: e.exportedAt.toISOString(),
        }))}
      />
    </Shell>
  );
}
