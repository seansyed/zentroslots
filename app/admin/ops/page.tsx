import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";
import OpsDiagnosticsClient from "@/components/admin/OpsDiagnosticsClient";
import { computeOpsDiagnostics } from "@/lib/admin-analytics/opsDiagnostics";

export const metadata = { title: "Operator Diagnostics" };
export const dynamic = "force-dynamic";

export default async function OpsDiagnosticsPage() {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  const initial = await computeOpsDiagnostics().catch(() => null);

  return (
    <Shell
      user={
        me
          ? { name: me.name, email: me.email, role: me.role }
          : { name: session.email, email: session.email, role: "admin" }
      }
      variant="super"
      title="Operator Diagnostics"
      crumbs={[{ label: "Super-admin" }, { label: "Ops" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">
        Internal — superuser only
      </div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Operator Diagnostics</h1>
      <p className="mt-1 text-sm text-slate-600">
        Real-time cron heartbeat, stuck-queue detection, and 24h failure stream. Every signal is
        derived from <code className="text-[11px]">cron_runs</code> +{" "}
        <code className="text-[11px]">audit_logs</code> rows.
      </p>
      <div className="mt-5">
        <OpsDiagnosticsClient initial={initial} />
      </div>
    </Shell>
  );
}
