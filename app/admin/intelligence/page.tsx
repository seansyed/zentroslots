import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";
import IntelligenceClient from "@/components/admin/IntelligenceClient";
import { computeIntelligenceReport } from "@/lib/admin-analytics/intelligence";

export const metadata = { title: "Operations Intelligence" };
export const dynamic = "force-dynamic";

/**
 * /admin/intelligence — SA-8 Operations Intelligence Center.
 *
 * Server-renders the deterministic rule-engine report for fast first
 * paint. Engine throws → page renders empty state with explainer
 * (client polls every 2 minutes and updates).
 */
export default async function IntelligencePage() {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  const report = await computeIntelligenceReport().catch(() => null);

  return (
    <Shell
      user={
        me
          ? { name: me.name, email: me.email, role: me.role }
          : { name: session.email, email: session.email, role: "admin" }
      }
      variant="super"
      title="Operations Intelligence"
      crumbs={[{ label: "Super-admin" }, { label: "Intelligence" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">
        Internal — superuser only
      </div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Operations Intelligence</h1>
      <p className="mt-1 text-sm text-slate-600">
        Deterministic rule engine — 14 insight types covering growth, churn, financial,
        onboarding, infrastructure, security, and operations. Every signal is a real SQL query
        against a fixed threshold. <strong>No LLM. No predictions. No hallucinations.</strong>
      </p>

      <div className="mt-5">
        <IntelligenceClient initial={report} />
      </div>
    </Shell>
  );
}
