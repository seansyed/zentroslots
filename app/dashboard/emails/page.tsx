import { redirect } from "next/navigation";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { auditLogs, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import { Badge, EmptyState } from "@/components/ui/primitives";

export default async function EmailsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      actorLabel: auditLogs.actorLabel,
      entityId: auditLogs.entityId,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.tenantId, user.tenantId),
        inArray(auditLogs.action, ["email.sent", "email.failed"])
      )
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(100);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Email log"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Email log" }]}
    >
      <h1 className="text-heading font-semibold text-ink">Email log</h1>
      <p className="mt-1 text-sm text-ink-muted">Every email this workspace has tried to send.</p>

      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-surface shadow-xs">
        {rows.length === 0 ? (
          <EmptyState
            title="No email history yet"
            body="Once bookings are made or reminders fire, sent + failed emails will appear here."
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle text-left text-xs uppercase text-ink-subtle">
              <tr>
                <th className="px-4 py-2.5">When</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">To</th>
                <th className="px-4 py-2.5">Subject</th>
                <th className="px-4 py-2.5">Kind</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const meta = r.metadata as { subject?: string; kind?: string; provider?: string; error?: string } | null;
                const failed = r.action === "email.failed";
                return (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="px-4 py-3 text-xs text-ink-muted">{r.createdAt.toISOString()}</td>
                    <td className="px-4 py-3">
                      {failed
                        ? <Badge tone="red">Failed</Badge>
                        : meta?.provider === "stub"
                          ? <Badge tone="neutral">Stub</Badge>
                          : <Badge tone="green">Sent</Badge>}
                    </td>
                    <td className="px-4 py-3 text-ink">{r.actorLabel ?? "—"}</td>
                    <td className="px-4 py-3 text-ink">{meta?.subject ?? "—"}</td>
                    <td className="px-4 py-3 text-xs text-ink-muted capitalize">{meta?.kind ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
