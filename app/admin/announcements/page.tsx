import { desc } from "drizzle-orm";

import { db } from "@/db/client";
import { announcements } from "@/db/schema";
import { AdminShell } from "../_shell";
import AnnouncementsClient from "./AnnouncementsClient";

export const metadata = { title: "Announcements — Super admin" };

export default async function AdminAnnouncementsPage() {
  const rows = await db.select().from(announcements).orderBy(desc(announcements.publishedAt));
  const serialized = rows.map((a) => ({
    ...a,
    publishedAt: a.publishedAt.toISOString(),
    expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
  }));

  return (
    <AdminShell
      title="Announcements"
      crumbs={[{ label: "Super-admin", href: "/admin" }, { label: "Announcements" }]}
    >
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        Platform-wide banners. The dashboard surfaces the newest active announcement
        matching the viewer&rsquo;s plan (or audience=&ldquo;all&rdquo;).
      </p>
      <AnnouncementsClient initial={serialized} />
    </AdminShell>
  );
}
