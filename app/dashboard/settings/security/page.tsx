import { redirect } from "next/navigation";
import { and, desc, eq, gte } from "drizzle-orm";

import { db } from "@/db/client";
import {
  passwordResetTokens,
  revokedSessionJtis,
  sessionAuditEvents,
  tenants,
  users,
} from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import SecurityClient from "@/components/dashboard/SecurityClient";
import { userHasPermission, effectivePermissions, PERMISSION_FLAGS } from "@/lib/security/permissions";

export const metadata = { title: "Security" };
export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  // Read access is for anyone who can sign in; manage access is gated
  // by canManageSecurity. The page renders both reading + management
  // and the client component hides revoke buttons when not allowed.
  const canManage = userHasPermission(user, "canManageSecurity");
  const permissions = effectivePermissions(user);

  // Load the per-user view. Tenant-scoped + user-scoped.
  const last30Days = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [events, recentLogins, failedLogins, suspicious, resetHistory, revokedRows] =
    await Promise.all([
      db
        .select()
        .from(sessionAuditEvents)
        .where(
          and(eq(sessionAuditEvents.tenantId, tenant.id), eq(sessionAuditEvents.userId, user.id))
        )
        .orderBy(desc(sessionAuditEvents.createdAt))
        .limit(50),
      db
        .select()
        .from(sessionAuditEvents)
        .where(
          and(
            eq(sessionAuditEvents.tenantId, tenant.id),
            eq(sessionAuditEvents.userId, user.id),
            eq(sessionAuditEvents.eventType, "login"),
            gte(sessionAuditEvents.createdAt, last30Days)
          )
        )
        .orderBy(desc(sessionAuditEvents.createdAt))
        .limit(20),
      db
        .select()
        .from(sessionAuditEvents)
        .where(
          and(
            eq(sessionAuditEvents.tenantId, tenant.id),
            eq(sessionAuditEvents.userId, user.id),
            eq(sessionAuditEvents.eventType, "login_failed"),
            gte(sessionAuditEvents.createdAt, last30Days)
          )
        )
        .orderBy(desc(sessionAuditEvents.createdAt))
        .limit(20),
      db
        .select()
        .from(sessionAuditEvents)
        .where(
          and(
            eq(sessionAuditEvents.tenantId, tenant.id),
            eq(sessionAuditEvents.userId, user.id),
            eq(sessionAuditEvents.eventType, "suspicious_login"),
            gte(sessionAuditEvents.createdAt, last30Days)
          )
        )
        .orderBy(desc(sessionAuditEvents.createdAt))
        .limit(20),
      db
        .select({
          id: passwordResetTokens.id,
          requestedIp: passwordResetTokens.requestedIp,
          createdAt: passwordResetTokens.createdAt,
          consumedAt: passwordResetTokens.consumedAt,
          consumedIp: passwordResetTokens.consumedIp,
        })
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.userId, user.id))
        .orderBy(desc(passwordResetTokens.createdAt))
        .limit(10),
      db
        .select({ jti: revokedSessionJtis.jti, revokedAt: revokedSessionJtis.revokedAt })
        .from(revokedSessionJtis)
        .where(eq(revokedSessionJtis.userId, user.id)),
    ]);

  // Build the "active sessions" approximation from login events whose
  // jti is not in the revoked set. Most-recent login per jti wins.
  const revokedSet = new Set(revokedRows.map((r) => r.jti));
  const sessionsByJti = new Map<string, typeof events[number]>();
  for (const e of events) {
    if (e.eventType !== "login" || !e.sessionJti) continue;
    if (!sessionsByJti.has(e.sessionJti)) sessionsByJti.set(e.sessionJti, e);
  }
  const activeSessions = Array.from(sessionsByJti.values()).map((e) => ({
    jti: e.sessionJti!,
    loggedInAt: e.createdAt.toISOString(),
    ipAddress: e.ipAddress,
    deviceLabel: e.deviceLabel,
    userAgent: e.userAgent,
    isCurrent: session.jti === e.sessionJti,
    revoked: revokedSet.has(e.sessionJti!),
  }));

  // Tenant user list for the permissions manager — only loaded when
  // the caller can manage security (gates DB read too, not just UI).
  let tenantUsers: Array<{
    id: string;
    email: string;
    name: string;
    role: string;
    effective: Record<string, boolean>;
    overrides: Record<string, boolean>;
    isCaller: boolean;
  }> = [];
  if (canManage) {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        permissionsExtra: users.permissionsExtra,
      })
      .from(users)
      .where(eq(users.tenantId, tenant.id));
    tenantUsers = rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      role: r.role,
      effective: effectivePermissions({ ...r } as Parameters<typeof effectivePermissions>[0]),
      overrides: (r.permissionsExtra ?? {}) as Record<string, boolean>,
      isCaller: r.id === user.id,
    }));
  }

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role, permissions }}
      tenant={{
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.currentPlan,
        logoUrl: tenant.logoUrl,
      }}
      title="Security Center"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Security Center" },
      ]}
    >
      {/* Page title + subtitle are rendered inside the SecurityClient
          hero so the layout can react to live posture (badges, counts)
          without server re-renders. */}
      <SecurityClient
        userEmail={user.email}
        canManage={canManage}
        permissions={permissions}
        permissionFlags={[...PERMISSION_FLAGS]}
        tenantUsers={tenantUsers}
        activeSessions={activeSessions}
        recentLogins={recentLogins.map(serialize)}
        failedLogins={failedLogins.map(serialize)}
        suspicious={suspicious.map(serialize)}
        resetHistory={resetHistory.map((r) => ({
          id: r.id,
          requestedIp: r.requestedIp,
          createdAt: r.createdAt.toISOString(),
          consumedAt: r.consumedAt ? r.consumedAt.toISOString() : null,
          consumedIp: r.consumedIp,
        }))}
        events={events.map(serialize)}
      />
    </Shell>
  );
}

function serialize(e: {
  id: string;
  eventType: string;
  sessionJti: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  deviceLabel: string | null;
  metadata: unknown;
  createdAt: Date;
}) {
  return {
    id: e.id,
    eventType: e.eventType,
    sessionJti: e.sessionJti,
    ipAddress: e.ipAddress,
    deviceLabel: e.deviceLabel,
    userAgent: e.userAgent,
    metadata: e.metadata as Record<string, unknown>,
    createdAt: e.createdAt.toISOString(),
  };
}
