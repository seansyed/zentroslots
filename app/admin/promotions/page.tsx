import { desc } from "drizzle-orm";

import { db } from "@/db/client";
import { promotions } from "@/db/schema";
import { AdminShell } from "../_shell";
import PromotionsClient from "./PromotionsClient";

export const metadata = { title: "Promotions — Super admin" };
// Force dynamic — admin pages read live DB on every request and
// must not be prerendered at build time.
export const dynamic = "force-dynamic";

export default async function AdminPromotionsPage() {
  const rows = await db.select().from(promotions).orderBy(desc(promotions.createdAt));
  const serialized = rows.map((p) => ({
    ...p,
    startsAt: p.startsAt ? p.startsAt.toISOString() : null,
    expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
  }));

  return (
    <AdminShell
      title="Promotions"
      crumbs={[{ label: "Super-admin", href: "/admin" }, { label: "Promotions" }]}
    >
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        Discount codes for marketing campaigns. Three kinds supported:
        <strong> percent</strong> off, <strong> fixed amount</strong> off, or <strong> trial extension</strong>.
      </p>
      <PromotionsClient initial={serialized} />
    </AdminShell>
  );
}
