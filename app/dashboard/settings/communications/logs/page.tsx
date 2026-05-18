import { redirect } from "next/navigation";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { communicationLogs, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import { Badge } from "@/components/ui/primitives";

export const metadata = { title: "Delivery logs" };
export const dynamic = "force-dynamic";

const STATUS_TONES: Record<string, "green" | "amber" | "red" | "neutral"> = {
  sent: "green",
  delivered: "green",
  queued: "amber",
  skipped: "neutral",
  failed: "red",
  suppressed: "neutral",
};

const STATUS_OPTIONS = ["all", "sent", "failed", "skipped"] as const;

export default async function DeliveryLogsPage(props: {
  searchParams: Promise<{ status?: string; event?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || (user.role !== "admin" && user.role !== "manager")) redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const sp = await props.searchParams;
  const statusFilter = (STATUS_OPTIONS as readonly string[]).includes(sp.status ?? "") ? sp.status : "all";
  const eventFilter = (sp.event ?? "").trim();

  const conds = [eq(communicationLogs.tenantId, tenant.id)];
  if (statusFilter && statusFilter !== "all") conds.push(eq(communicationLogs.status, statusFilter));
  if (eventFilter) conds.push(eq(communicationLogs.eventType, eventFilter));

  const rows = await db
    .select()
    .from(communicationLogs)
    .where(and(...conds))
    .orderBy(desc(communicationLogs.createdAt))
    .limit(200);

  // Distinct event types observed for this tenant — drives the filter
  // dropdown so it never shows events that don't exist locally.
  const eventTypes = Array.from(new Set(rows.map((r) => r.eventType))).sort();

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Delivery logs"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Communications" },
        { label: "Delivery logs" },
      ]}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-heading font-semibold text-ink">Delivery logs</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Every scheduling email this workspace tried to send. Shows up to 200 most recent.
          </p>
        </div>
        <Link
          href="/dashboard/settings/communications/templates"
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-inset"
        >
          Edit templates →
        </Link>
      </div>

      {/* Filter chips */}
      <div className="mt-4 flex flex-wrap gap-1.5 text-sm">
        {STATUS_OPTIONS.map((s) => (
          <Link
            key={s}
            href={`/dashboard/settings/communications/logs${s === "all" ? "" : `?status=${s}`}${eventFilter ? `${s === "all" ? "?" : "&"}event=${eventFilter}` : ""}`}
            className={
              "rounded-md border px-3 py-1.5 capitalize " +
              ((statusFilter ?? "all") === s
                ? "border-brand-accent bg-brand-accent text-white"
                : "border-border bg-surface text-ink-muted hover:bg-surface-inset")
            }
          >
            {s}
          </Link>
        ))}
        {eventTypes.length > 1 && (
          <select
            defaultValue={eventFilter || ""}
            onChange={(e) => {
              const url = new URL(window.location.href);
              if (e.target.value) url.searchParams.set("event", e.target.value);
              else url.searchParams.delete("event");
              window.location.href = url.toString();
            }}
            className="ml-2 rounded-md border border-border bg-white px-3 py-1.5 text-sm"
          >
            <option value="">All events</option>
            {eventTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2.5">When</th>
              <th className="px-4 py-2.5">Event</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Detail</th>
              <th className="px-4 py-2.5">Booking</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="p-10 text-center text-sm text-slate-500">
                  No delivery activity matches these filters yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 align-top">
                <td className="px-4 py-2.5 font-mono text-xs">{r.createdAt.toISOString().slice(0, 19).replace("T", " ")}</td>
                <td className="px-4 py-2.5 text-xs">{r.eventType}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={STATUS_TONES[r.status] ?? "neutral"}>{r.status}</Badge>
                </td>
                <td className="px-4 py-2.5 text-xs text-ink-muted">
                  {r.status === "skipped" && (r.skippedReason || "—")}
                  {r.status === "failed"  && truncate(r.failureReason || "—", 120)}
                  {r.status === "sent"    && (r.providerMessageId ? `via ${r.provider} · ${r.providerMessageId.slice(0, 24)}` : (r.provider ?? "sent"))}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-subtle">
                  {r.bookingId ? r.bookingId.slice(0, 8) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
