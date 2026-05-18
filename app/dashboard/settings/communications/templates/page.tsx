import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import TemplatesClient from "@/components/dashboard/TemplatesClient";

export const metadata = { title: "Email templates" };

export default async function CommunicationTemplatesPage() {
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
      title="Email templates"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Communications", href: "/dashboard/settings/communications" },
        { label: "Templates" },
      ]}
    >
      <h1 className="text-heading font-semibold text-ink">Email templates</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        Customize the emails customers receive. Empty templates fall back
        to the system default — restore at any time. Variables like{" "}
        <code className="rounded bg-surface-inset px-1 py-0.5 text-[11px]">{"{{customer_name}}"}</code>{" "}
        render at send time.
      </p>
      <TemplatesClient currentUserEmail={user.email} />
    </Shell>
  );
}
