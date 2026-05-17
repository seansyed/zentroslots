import { redirect } from "next/navigation";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { auditLogs, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import SmsProviderClient from "@/components/dashboard/SmsProviderClient";

export const metadata = { title: "Communications" };

// Communications control center. This first slice covers the SMS
// provider connection — additional tabs (templates, broadcasts, quiet
// hours, per-event toggle matrix) plug in here in follow-up sessions.

export default async function CommunicationsSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const recentSmsLogs = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.tenantId, tenant.id), sql`${auditLogs.action} LIKE 'sms.%'`))
    .orderBy(desc(auditLogs.createdAt))
    .limit(50);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Communications"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Communications" },
      ]}
    >
      <h1 className="text-heading font-semibold text-ink">Communications</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        Connect your own SMS provider so reminders, confirmations, and broadcasts
        go out under your brand and on your account. Credentials are encrypted at rest;
        only the last few characters of the auth token are ever shown back to you.
      </p>

      <SmsProviderClient
        initialLogs={recentSmsLogs.map((r) => ({
          id: r.id,
          action: r.action,
          createdAt: r.createdAt.toISOString(),
          metadata: r.metadata as Record<string, unknown> | null,
        }))}
      />
    </Shell>
  );
}
