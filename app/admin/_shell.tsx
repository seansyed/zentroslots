import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";

// Shared bootstrap for every /admin/* server page. Handles auth gating
// (404 to outsiders) and wraps content in the super-variant Shell so
// every page gets the same chrome + sidebar.
export async function AdminShell({
  title,
  crumbs,
  actions,
  children,
}: {
  title: string;
  crumbs: { label: string; href?: string }[];
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  const user = me
    ? { name: me.name, email: me.email, role: me.role }
    : { name: session.email, email: session.email, role: "admin" as const };

  return (
    <Shell user={user} variant="super" title={title} crumbs={crumbs} actions={actions}>
      {children}
    </Shell>
  );
}
