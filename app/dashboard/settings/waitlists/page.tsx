import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import WaitlistsClient from "@/components/dashboard/WaitlistsClient";

export const metadata = { title: "Waitlists" };
export const dynamic = "force-dynamic";

export default async function WaitlistsPage() {
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
      title="Waitlists"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Waitlists" },
      ]}
    >
      <h1 className="text-heading font-semibold text-ink">Waitlists</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        Customers join from your public booking page when a date is full.
        When a booking gets cancelled or rescheduled, the next-best match
        is offered a 15-minute reservation hold.
      </p>

      <WaitlistsClient />
    </Shell>
  );
}
