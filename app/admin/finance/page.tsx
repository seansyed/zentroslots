import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";
import FinanceClient from "@/components/admin/FinanceClient";
import { computeFinanceBundle } from "@/lib/admin-analytics/finance";
import { fetchDunning } from "@/lib/admin-analytics/dunning";
import { computeSubscriptionIntelligence } from "@/lib/admin-analytics/subscription-intelligence";
import { computeReconReport } from "@/lib/admin-analytics/stripe-recon";

export const metadata = { title: "Financial Operations Center" };
export const dynamic = "force-dynamic";

/**
 * /admin/finance — SA-6 Financial Operations Center.
 *
 * Server-renders all five sections in parallel for fast first paint.
 * Per-section fatal isolation: any module that throws passes null;
 * the client renders an amber error placeholder for that section
 * and the others continue working normally.
 */
export default async function FinanceOperationsPage() {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });

  const [revenue, dunning, subIntel, recon] = await Promise.all([
    computeFinanceBundle().catch(() => null),
    fetchDunning().catch(() => null),
    computeSubscriptionIntelligence().catch(() => null),
    computeReconReport().catch(() => null),
  ]);

  return (
    <Shell
      user={
        me
          ? { name: me.name, email: me.email, role: me.role }
          : { name: session.email, email: session.email, role: "admin" }
      }
      variant="super"
      title="Financial Operations Center"
      crumbs={[{ label: "Super-admin" }, { label: "Finance" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">
        Internal — superuser only
      </div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Financial Operations Center</h1>
      <p className="mt-1 text-sm text-slate-600">
        Cross-tenant revenue, dunning, subscription intelligence, and Stripe reconciliation. Every
        action is audited; every value is sourced from real DB queries.
      </p>

      <div className="mt-5">
        <FinanceClient initial={{ revenue, dunning, subIntel, recon }} />
      </div>
    </Shell>
  );
}
