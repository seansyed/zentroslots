import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import RecurringClient from "@/components/dashboard/RecurringClient";

export const metadata = { title: "Recurring bookings" };
export const dynamic = "force-dynamic";

export default async function RecurringBookingsPage() {
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
      title="Recurring bookings"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Recurring bookings" },
      ]}
    >
      <h1 className="text-heading font-semibold text-ink">Recurring bookings</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        Create weekly/monthly appointment series. Each occurrence is
        materialized as a real booking ahead of time, validated against
        booking rules and availability. Pausing the series stops new
        occurrences without affecting bookings already on the calendar.
      </p>

      <RecurringClient />
    </Shell>
  );
}
