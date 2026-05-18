import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import BookingRulesClient from "@/components/dashboard/BookingRulesClient";

export const metadata = { title: "Booking rules" };
export const dynamic = "force-dynamic";

export default async function BookingRulesPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || (user.role !== "admin" && user.role !== "manager")) redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Booking rules"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Booking rules" },
      ]}
    >
      <h1 className="text-heading font-semibold text-ink">Booking rules</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        Notice / advance windows, daily caps, cooldowns, blackouts, and
        business-hours enforcement — per service or as a tenant default.
        Without a rule, behavior is unchanged from before this feature
        shipped.
      </p>

      <BookingRulesClient />
    </Shell>
  );
}
