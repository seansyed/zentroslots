/**
 * Communication Delivery Center (Phase 14A).
 *
 * Server entry for the email delivery log workspace. This rewrite is
 * strictly additive over the previous 123-line page:
 *
 *   - The `?status=` / `?event=` / `?q=` URL contract is preserved
 *     verbatim. Existing bookmarks keep working.
 *   - Tenant + role isolation untouched (admin / manager only).
 *   - The `communicationLogs` rows query (limit 200) is unchanged.
 *   - All new queries are wrapped in tenant predicates and `.catch()`
 *     fall through to safe defaults so a brand-new tenant never sees
 *     an empty-table error.
 *
 * The page now also derives honest aggregations from data already
 * stored in `communication_logs`:
 *
 *   - Send / failure / skip totals over a 7-day window
 *   - Delivery success rate + 24h-vs-prior-24h delta
 *   - Last successful send timestamp + provider
 *   - Reminder breakdown (24h vs 1h reminders, plus confirmations,
 *     cancellations, reschedules)
 *   - Daily-bucketed series for the inline sparkline
 *   - Provider mix
 *   - Recent failures (last 5, with reason snippet)
 *
 * No metrics that the schema can't honestly populate (opens, bounces,
 * delivery latency, retry queue depth) are computed — the brief's rule
 * "No fake email history. Only render real delivery data" is honored.
 */
import { redirect } from "next/navigation";
import { and, desc, eq, gte, ilike, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, communicationLogs, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { planFeature } from "@/lib/quotas";
import { getPlan } from "@/lib/plans";
import Shell from "@/components/dashboard/Shell";
import CommunicationLogsClient from "@/components/dashboard/CommunicationLogsClient";

export const metadata = { title: "Delivery logs" };
export const dynamic = "force-dynamic";

const STATUS_OPTIONS = ["all", "sent", "failed", "skipped"] as const;

// Window the KPI strip + health center summarize. 7 days is short
// enough to remain interactive even for high-volume tenants; the
// detail table itself still scrolls back through the most-recent
// 200 rows regardless of status.
const WINDOW_DAYS = 7;

export default async function DeliveryLogsPage(props: {
  searchParams: Promise<{ status?: string; event?: string; q?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || (user.role !== "admin" && user.role !== "manager")) redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const sp = await props.searchParams;
  const statusFilter = (STATUS_OPTIONS as readonly string[]).includes(sp.status ?? "")
    ? sp.status
    : "all";
  const eventFilter = (sp.event ?? "").trim();
  const search = (sp.q ?? "").trim();

  const hasAnalytics = planFeature(tenant.currentPlan, "analytics");
  const currentPlan = getPlan(tenant.currentPlan);

  const conds = [eq(communicationLogs.tenantId, tenant.id)];
  if (statusFilter && statusFilter !== "all") {
    conds.push(eq(communicationLogs.status, statusFilter));
  }
  if (eventFilter) {
    conds.push(eq(communicationLogs.eventType, eventFilter));
  }

  // Search: matches booking_id prefix OR a booking's client_email
  // substring. Same logic as the prior page — tenant isolation
  // enforced via the booking-join predicate.
  if (search) {
    const looksLikeId = /^[0-9a-fA-F-]{4,}$/.test(search);
    const matchingBookings = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, tenant.id),
          or(
            ilike(bookings.clientEmail, `%${search}%`),
            ilike(bookings.clientName, `%${search}%`),
            looksLikeId ? sql`${bookings.id}::text ILIKE ${search + "%"}` : sql`false`,
          ),
        ),
      )
      .limit(500);

    const ids = matchingBookings.map((r) => r.id);

    if (ids.length === 0 && !looksLikeId) {
      conds.push(sql`false`);
    } else if (ids.length === 0 && looksLikeId) {
      conds.push(sql`${communicationLogs.bookingId}::text ILIKE ${search + "%"}`);
    } else {
      conds.push(sql`${communicationLogs.bookingId} = ANY(${ids})`);
    }
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60_000);
  const last24h = new Date(now.getTime() - 24 * 60 * 60_000);
  const prior24h = new Date(now.getTime() - 48 * 60 * 60_000);
  const tenantOnly = eq(communicationLogs.tenantId, tenant.id);

  // Single aggregate query over the 7-day window — one scan, all
  // KPIs derived in memory. `.catch()` falls open so the table still
  // renders even if the aggregation breaks on an unusual config.
  type AggregateRow = {
    status: string;
    eventType: string;
    provider: string | null;
    day: string;
    n: number;
  };
  const windowAggregate: AggregateRow[] = await db
    .select({
      status: communicationLogs.status,
      eventType: communicationLogs.eventType,
      provider: communicationLogs.provider,
      day: sql<string>`to_char(date_trunc('day', ${communicationLogs.createdAt}), 'YYYY-MM-DD')`,
      n: sql<number>`count(*)::int`,
    })
    .from(communicationLogs)
    .where(and(tenantOnly, gte(communicationLogs.createdAt, windowStart)))
    .groupBy(
      communicationLogs.status,
      communicationLogs.eventType,
      communicationLogs.provider,
      sql`date_trunc('day', ${communicationLogs.createdAt})`,
    )
    .catch(() => [] as AggregateRow[]);

  // 24h delta — compare last 24h failures to the prior 24h. Two cheap
  // count() rows, parallel.
  const [last24Row, prior24Row, lastSuccessful] = await Promise.all([
    db
      .select({
        sent: sql<number>`SUM(CASE WHEN ${communicationLogs.status} = 'sent' THEN 1 ELSE 0 END)::int`,
        failed: sql<number>`SUM(CASE WHEN ${communicationLogs.status} = 'failed' THEN 1 ELSE 0 END)::int`,
      })
      .from(communicationLogs)
      .where(and(tenantOnly, gte(communicationLogs.createdAt, last24h)))
      .catch(() => [{ sent: 0, failed: 0 }]),
    db
      .select({
        sent: sql<number>`SUM(CASE WHEN ${communicationLogs.status} = 'sent' THEN 1 ELSE 0 END)::int`,
        failed: sql<number>`SUM(CASE WHEN ${communicationLogs.status} = 'failed' THEN 1 ELSE 0 END)::int`,
      })
      .from(communicationLogs)
      .where(
        and(
          tenantOnly,
          gte(communicationLogs.createdAt, prior24h),
          sql`${communicationLogs.createdAt} < ${last24h}`,
        ),
      )
      .catch(() => [{ sent: 0, failed: 0 }]),
    db
      .select({
        sentAt: communicationLogs.sentAt,
        provider: communicationLogs.provider,
      })
      .from(communicationLogs)
      .where(and(tenantOnly, eq(communicationLogs.status, "sent")))
      .orderBy(desc(communicationLogs.sentAt))
      .limit(1)
      .catch(() => [] as Array<{ sentAt: Date | null; provider: string | null }>),
  ]);

  // Derive aggregate KPIs from the single window scan.
  let sent7 = 0;
  let failed7 = 0;
  let skipped7 = 0;
  const eventTypeTotals: Record<string, number> = {};
  const providerTotals: Record<string, number> = {};
  const dayBuckets: Record<string, number> = {};
  for (const row of windowAggregate) {
    const n = Number(row.n);
    if (row.status === "sent") sent7 += n;
    else if (row.status === "failed") failed7 += n;
    else if (row.status === "skipped") skipped7 += n;
    eventTypeTotals[row.eventType] = (eventTypeTotals[row.eventType] ?? 0) + n;
    if (row.provider && row.status === "sent") {
      providerTotals[row.provider] = (providerTotals[row.provider] ?? 0) + n;
    }
    if (row.status === "sent") {
      dayBuckets[row.day] = (dayBuckets[row.day] ?? 0) + n;
    }
  }
  const total7 = sent7 + failed7 + skipped7;
  const deliveryRatePct =
    sent7 + failed7 > 0 ? Math.round((sent7 / (sent7 + failed7)) * 100) : null;
  const failureRatePct =
    sent7 + failed7 > 0 ? Math.round((failed7 / (sent7 + failed7)) * 100) : 0;

  // Last-24h vs prior-24h failure delta — surfaces sudden regressions.
  const last24 = last24Row[0] ?? { sent: 0, failed: 0 };
  const prior24 = prior24Row[0] ?? { sent: 0, failed: 0 };
  const last24Total = Number(last24.sent) + Number(last24.failed);
  const prior24Total = Number(prior24.sent) + Number(prior24.failed);
  const last24FailPct =
    last24Total > 0 ? Math.round((Number(last24.failed) / last24Total) * 100) : 0;
  const prior24FailPct =
    prior24Total > 0 ? Math.round((Number(prior24.failed) / prior24Total) * 100) : 0;
  const last24SendDelta = Number(last24.sent) - Number(prior24.sent);

  // Reminder breakdown — confirmation + reminder_24h + reminder_1h +
  // cancellation + reschedule. Honors whatever subset the tenant
  // actually fires.
  const remindersByEvent: Array<{ eventType: string; label: string; count: number }> = [
    { eventType: "appointment.created", label: "Confirmations", count: 0 },
    { eventType: "appointment.reminder_24h", label: "Reminders · 24h", count: 0 },
    { eventType: "appointment.reminder_1h", label: "Reminders · 1h", count: 0 },
    { eventType: "appointment.cancelled", label: "Cancellations", count: 0 },
    { eventType: "appointment.rescheduled", label: "Reschedules", count: 0 },
  ].map((r) => ({ ...r, count: eventTypeTotals[r.eventType] ?? 0 }));

  // Daily sent series for the inline sparkline. Fill any missing days
  // with zero so the SVG path doesn't compress non-existent gaps.
  const daySeries: Array<{ day: string; n: number }> = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60_000);
    const key = d.toISOString().slice(0, 10);
    daySeries.push({ day: key, n: dayBuckets[key] ?? 0 });
  }

  // Provider mix — ordered descending by send count for the health
  // strip. Renders the top 3.
  const providerMix = Object.entries(providerTotals)
    .map(([provider, count]) => ({ provider, count }))
    .sort((a, b) => b.count - a.count);

  // Recent failure samples (separate query — small, ordered by time)
  const recentFailures = await db
    .select({
      id: communicationLogs.id,
      eventType: communicationLogs.eventType,
      provider: communicationLogs.provider,
      failureReason: communicationLogs.failureReason,
      createdAt: communicationLogs.createdAt,
    })
    .from(communicationLogs)
    .where(and(tenantOnly, eq(communicationLogs.status, "failed")))
    .orderBy(desc(communicationLogs.createdAt))
    .limit(5)
    .catch(() => [] as Array<{
      id: string;
      eventType: string;
      provider: string | null;
      failureReason: string | null;
      createdAt: Date;
    }>);

  // Original row + event-type queries — UNCHANGED behavior.
  const rows = await db
    .select()
    .from(communicationLogs)
    .where(and(...conds))
    .orderBy(desc(communicationLogs.createdAt))
    .limit(200);

  const eventTypeRows = await db
    .selectDistinct({ eventType: communicationLogs.eventType })
    .from(communicationLogs)
    .where(eq(communicationLogs.tenantId, tenant.id));
  const eventTypes = eventTypeRows.map((r) => r.eventType).sort();

  const summary = {
    windowDays: WINDOW_DAYS,
    total7,
    sent7,
    failed7,
    skipped7,
    deliveryRatePct,
    failureRatePct,
    last24Sent: Number(last24.sent),
    last24Failed: Number(last24.failed),
    prior24Sent: Number(prior24.sent),
    last24FailPct,
    prior24FailPct,
    last24SendDelta,
    lastSuccessfulAt:
      lastSuccessful[0]?.sentAt instanceof Date
        ? lastSuccessful[0].sentAt.toISOString()
        : null,
    lastSuccessfulProvider: lastSuccessful[0]?.provider ?? null,
    remindersByEvent,
    daySeries,
    providerMix,
  };

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
      <CommunicationLogsClient
        rows={rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          sentAt: r.sentAt?.toISOString() ?? null,
        }))}
        statusFilter={statusFilter ?? "all"}
        eventFilter={eventFilter}
        search={search}
        eventTypes={eventTypes}
        summary={summary}
        recentFailures={recentFailures.map((f) => ({
          ...f,
          createdAt: f.createdAt.toISOString(),
        }))}
        hasAnalytics={hasAnalytics}
        currentPlanName={currentPlan.name}
        tenantName={tenant.name}
      />
    </Shell>
  );
}
