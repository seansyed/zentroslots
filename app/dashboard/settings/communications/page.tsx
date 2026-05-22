/**
 * Communications Command Center (Phase 15A).
 *
 * Strict invariants this rewrite preserves:
 *   - The existing `SmsProviderClient` component (Twilio / Telnyx
 *     connect, disconnect, test-SMS, credential encryption flow)
 *     mounts UNCHANGED inside the new layout. Phase 15A is a
 *     surrounding presentation layer — it never touches the SMS
 *     provider client, the encrypted credential APIs, or the
 *     reminder cron jobs.
 *   - The original `auditLogs` query (last 50 `sms.%` events) is
 *     preserved verbatim and still feeds `SmsProviderClient`.
 *   - Admin-only gate untouched.
 *   - No fabricated metrics. Every KPI tile, channel-status card,
 *     and automation count comes from a real query against
 *     `communicationLogs`, `tenantSmsProviders`,
 *     `communicationTemplates`, `automationRules`, or
 *     `followupAutomationRules`.
 *   - Locked future-feature sections (Push, WhatsApp, drip flows)
 *     render as visibly disabled with explanatory copy — never as
 *     fake-clickable buttons.
 */
import { redirect } from "next/navigation";
import { and, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  automationRules,
  communicationLogs,
  communicationTemplates,
  followupAutomationRules,
  tenants,
  tenantSmsProviders,
  users,
} from "@/db/schema";
import { getSession } from "@/lib/auth";
import { planFeature } from "@/lib/quotas";
import { getPlan } from "@/lib/plans";
import Shell from "@/components/dashboard/Shell";
import SmsProviderClient from "@/components/dashboard/SmsProviderClient";
import CommunicationsCommandCenterClient from "@/components/dashboard/CommunicationsCommandCenterClient";

export const metadata = { title: "Communications" };
export const dynamic = "force-dynamic";

const WINDOW_DAYS = 7;

export default async function CommunicationsSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const hasAnalytics = planFeature(tenant.currentPlan, "analytics");
  const currentPlan = getPlan(tenant.currentPlan);

  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60_000);
  const last24h = new Date(now.getTime() - 24 * 60 * 60_000);
  const tenantOnlyLogs = eq(communicationLogs.tenantId, tenant.id);

  // ── Original audit-log query (preserved) ─────────────────────────
  const recentSmsLogs = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.tenantId, tenant.id), sql`${auditLogs.action} LIKE 'sms.%'`))
    .orderBy(desc(auditLogs.createdAt))
    .limit(50);

  // ── Window aggregate over communication_logs ─────────────────────
  // One scan, grouped by channel/status/event. All KPI tiles derive
  // from this in memory. Wrapped in `.catch()` so an old DB without
  // the table still renders the page.
  type AggregateRow = {
    channel: string;
    status: string;
    eventType: string;
    n: number;
  };
  const windowAggregate: AggregateRow[] = await db
    .select({
      channel: communicationLogs.channel,
      status: communicationLogs.status,
      eventType: communicationLogs.eventType,
      n: sql<number>`count(*)::int`,
    })
    .from(communicationLogs)
    .where(and(tenantOnlyLogs, gte(communicationLogs.createdAt, windowStart)))
    .groupBy(
      communicationLogs.channel,
      communicationLogs.status,
      communicationLogs.eventType,
    )
    .catch(() => [] as AggregateRow[]);

  // 24h counters + last-successful timestamp + recent failures +
  // recent activity feed — small parallel queries that power the
  // intelligence sections. Each `.catch()` falls open to an empty
  // array so a brand-new tenant DB still renders the page.
  const [
    last24Row,
    lastEmailSuccess,
    smsProvider,
    templates,
    automations,
    followupRules,
    recentFailures,
    recentActivity,
  ] = await Promise.all([
      db
        .select({
          sent: sql<number>`SUM(CASE WHEN ${communicationLogs.status} = 'sent' THEN 1 ELSE 0 END)::int`,
          failed: sql<number>`SUM(CASE WHEN ${communicationLogs.status} = 'failed' THEN 1 ELSE 0 END)::int`,
        })
        .from(communicationLogs)
        .where(and(tenantOnlyLogs, gte(communicationLogs.createdAt, last24h)))
        .catch(() => [{ sent: 0, failed: 0 }]),
      db
        .select({
          sentAt: communicationLogs.sentAt,
          provider: communicationLogs.provider,
        })
        .from(communicationLogs)
        .where(
          and(
            tenantOnlyLogs,
            eq(communicationLogs.status, "sent"),
            eq(communicationLogs.channel, "email"),
          ),
        )
        .orderBy(desc(communicationLogs.sentAt))
        .limit(1)
        .catch(() => [] as Array<{ sentAt: Date | null; provider: string | null }>),
      db
        .select()
        .from(tenantSmsProviders)
        .where(eq(tenantSmsProviders.tenantId, tenant.id))
        .limit(1)
        .catch(() => [] as Array<typeof tenantSmsProviders.$inferSelect>),
      db
        .select({
          id: communicationTemplates.id,
          templateType: communicationTemplates.templateType,
          channel: communicationTemplates.channel,
          subject: communicationTemplates.subject,
          enabled: communicationTemplates.enabled,
          systemDefault: communicationTemplates.systemDefault,
          updatedAt: communicationTemplates.updatedAt,
        })
        .from(communicationTemplates)
        .where(eq(communicationTemplates.tenantId, tenant.id))
        .orderBy(desc(communicationTemplates.updatedAt))
        .limit(8)
        .catch(() => [] as Array<{
          id: string;
          templateType: string;
          channel: string;
          subject: string | null;
          enabled: boolean;
          systemDefault: boolean;
          updatedAt: Date;
        }>),
      db
        .select({
          id: automationRules.id,
          triggerEvent: automationRules.triggerEvent,
          delayMinutes: automationRules.delayMinutes,
          channel: automationRules.channel,
          enabled: automationRules.enabled,
          updatedAt: automationRules.updatedAt,
        })
        .from(automationRules)
        .where(eq(automationRules.tenantId, tenant.id))
        .orderBy(desc(automationRules.updatedAt))
        .limit(10)
        .catch(() => [] as Array<{
          id: string;
          triggerEvent: string;
          delayMinutes: number;
          channel: string;
          enabled: boolean;
          updatedAt: Date;
        }>),
      db
        .select({
          id: followupAutomationRules.id,
          triggerEvent: followupAutomationRules.triggerEvent,
          enabled: followupAutomationRules.enabled,
          updatedAt: followupAutomationRules.updatedAt,
        })
        .from(followupAutomationRules)
        .where(eq(followupAutomationRules.tenantId, tenant.id))
        .orderBy(desc(followupAutomationRules.updatedAt))
        .limit(10)
        .catch(() => [] as Array<{
          id: string;
          triggerEvent: string;
          enabled: boolean;
          updatedAt: Date;
        }>),
      // Phase 15B — recent failure samples for the delivery
      // intelligence strip. Limit 5, ordered by createdAt desc.
      db
        .select({
          id: communicationLogs.id,
          eventType: communicationLogs.eventType,
          channel: communicationLogs.channel,
          provider: communicationLogs.provider,
          failureReason: communicationLogs.failureReason,
          createdAt: communicationLogs.createdAt,
        })
        .from(communicationLogs)
        .where(and(tenantOnlyLogs, eq(communicationLogs.status, "failed")))
        .orderBy(desc(communicationLogs.createdAt))
        .limit(5)
        .catch(() => [] as Array<{
          id: string;
          eventType: string;
          channel: string;
          provider: string | null;
          failureReason: string | null;
          createdAt: Date;
        }>),
      // Phase 15B — inline activity timeline feed. Last 10 events
      // across all statuses for the unified communication feed.
      db
        .select({
          id: communicationLogs.id,
          eventType: communicationLogs.eventType,
          channel: communicationLogs.channel,
          status: communicationLogs.status,
          provider: communicationLogs.provider,
          createdAt: communicationLogs.createdAt,
        })
        .from(communicationLogs)
        .where(tenantOnlyLogs)
        .orderBy(desc(communicationLogs.createdAt))
        .limit(10)
        .catch(() => [] as Array<{
          id: string;
          eventType: string;
          channel: string;
          status: string;
          provider: string | null;
          createdAt: Date;
        }>),
    ]);

  // ── Derive aggregate KPIs ─────────────────────────────────────────
  let emailSent = 0;
  let emailFailed = 0;
  let smsSent = 0;
  let smsFailed = 0;
  let skipped7 = 0;
  let reminderSent = 0;
  let reminderFailed = 0;
  const eventTypeTotals: Record<string, number> = {};
  for (const r of windowAggregate) {
    const n = Number(r.n);
    if (r.status === "skipped") {
      skipped7 += n;
      continue;
    }
    eventTypeTotals[r.eventType] = (eventTypeTotals[r.eventType] ?? 0) + n;

    // Channel split (email vs sms). Other channels (push) ignored
    // because we don't ship them yet.
    if (r.channel === "email") {
      if (r.status === "sent") emailSent += n;
      else if (r.status === "failed") emailFailed += n;
    } else if (r.channel === "sms") {
      if (r.status === "sent") smsSent += n;
      else if (r.status === "failed") smsFailed += n;
    }

    // Reminder bucket — both 24h and 1h sends counted together.
    if (r.eventType === "appointment.reminder_24h" || r.eventType === "appointment.reminder_1h") {
      if (r.status === "sent") reminderSent += n;
      else if (r.status === "failed") reminderFailed += n;
    }
  }
  const totalSent7 = emailSent + smsSent;
  const totalFailed7 = emailFailed + smsFailed;
  const messages7 = totalSent7 + totalFailed7 + skipped7;
  const emailSuccessPct =
    emailSent + emailFailed > 0
      ? Math.round((emailSent / (emailSent + emailFailed)) * 100)
      : null;
  const smsSuccessPct =
    smsSent + smsFailed > 0
      ? Math.round((smsSent / (smsSent + smsFailed)) * 100)
      : null;
  const reminderSuccessPct =
    reminderSent + reminderFailed > 0
      ? Math.round((reminderSent / (reminderSent + reminderFailed)) * 100)
      : null;

  const last24 = last24Row[0] ?? { sent: 0, failed: 0 };

  // ── Channel state ─────────────────────────────────────────────────
  const sms = smsProvider[0] ?? null;
  const emailChannel = {
    name: "Email",
    icon: "email" as const,
    connected: true, // SMTP/SES is platform-managed — always available
    provider: lastEmailSuccess[0]?.provider ?? null,
    detail: lastEmailSuccess[0]?.sentAt
      ? `Last successful send ${relativeTimeFromIso(lastEmailSuccess[0].sentAt.toISOString())}`
      : emailSent > 0
        ? `${emailSent} email${emailSent === 1 ? "" : "s"} sent in last ${WINDOW_DAYS} days`
        : "No traffic yet — confirmations and reminders fire automatically",
    successPct: emailSuccessPct,
    sentCount: emailSent,
    failedCount: emailFailed,
    locked: false,
  };

  const smsChannel = sms
    ? {
        name: "SMS",
        icon: "sms" as const,
        connected: Boolean(sms.active),
        provider: sms.provider,
        detail: sms.lastSendAt
          ? `Last successful send ${relativeTimeFromIso(sms.lastSendAt.toISOString())} via ${sms.provider}`
          : sms.lastError
            ? `Last error ${relativeTimeFromIso(sms.lastErrorAt?.toISOString() ?? new Date().toISOString())}`
            : `${sms.provider} connected · sender ${sms.senderId}`,
        successPct: smsSuccessPct,
        sentCount: Number(sms.totalSent),
        failedCount: Number(sms.totalFailed),
        locked: false,
      }
    : {
        name: "SMS",
        icon: "sms" as const,
        connected: false,
        provider: null,
        detail: "Connect Twilio or Telnyx below to send SMS reminders.",
        successPct: null,
        sentCount: 0,
        failedCount: 0,
        locked: false,
      };

  // ── Insight chips for hero ────────────────────────────────────────
  const insightChips: string[] = [];
  if (Number(last24.sent) > 0) {
    insightChips.push(
      `${Number(last24.sent)} message${Number(last24.sent) === 1 ? "" : "s"} sent in the last 24h.`,
    );
  }
  if (emailSuccessPct !== null && emailSuccessPct >= 95) {
    insightChips.push(`${emailSuccessPct}% email delivery success this week.`);
  } else if (emailSuccessPct !== null && emailSuccessPct < 80) {
    insightChips.push(`Email delivery at ${emailSuccessPct}% — review failures below.`);
  }
  if (reminderSuccessPct !== null) {
    insightChips.push(`Reminders delivering at ${reminderSuccessPct}%.`);
  }
  if (templates.length > 0) {
    const enabled = templates.filter((t) => t.enabled).length;
    insightChips.push(`${enabled} of ${templates.length} templates enabled.`);
  }

  // ── Snapshot summary for client ───────────────────────────────────
  const summary = {
    windowDays: WINDOW_DAYS,
    messages7,
    totalSent7,
    totalFailed7,
    skipped7,
    last24Sent: Number(last24.sent),
    last24Failed: Number(last24.failed),
    emailSent,
    emailFailed,
    smsSent,
    smsFailed,
    reminderSent,
    reminderFailed,
    emailSuccessPct,
    smsSuccessPct,
    reminderSuccessPct,
    eventTypeTotals,
    templatesCount: templates.length,
    templatesEnabled: templates.filter((t) => t.enabled).length,
    automationsCount: automations.length,
    automationsEnabled: automations.filter((a) => a.enabled).length,
    followupRulesCount: followupRules.length,
    followupRulesEnabled: followupRules.filter((r) => r.enabled).length,
    lastEmailSuccessAt: lastEmailSuccess[0]?.sentAt?.toISOString() ?? null,
    lastEmailProvider: lastEmailSuccess[0]?.provider ?? null,
  };

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Communications"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Communications" },
      ]}
    >
      <CommunicationsCommandCenterClient
        tenantName={tenant.name}
        summary={summary}
        insightChips={insightChips}
        emailChannel={emailChannel}
        smsChannel={smsChannel}
        templates={templates.map((t) => ({
          ...t,
          updatedAt: t.updatedAt.toISOString(),
        }))}
        automations={automations.map((a) => ({
          ...a,
          updatedAt: a.updatedAt.toISOString(),
        }))}
        followupRules={followupRules.map((r) => ({
          ...r,
          updatedAt: r.updatedAt.toISOString(),
        }))}
        recentFailures={recentFailures.map((f) => ({
          ...f,
          createdAt: f.createdAt.toISOString(),
        }))}
        recentActivity={recentActivity.map((a) => ({
          ...a,
          createdAt: a.createdAt.toISOString(),
        }))}
        hasAnalytics={hasAnalytics}
        currentPlanName={currentPlan.name}
      />

      {/* ── SMS provider — UNCHANGED (Phase 7A / 14A artifact) ── */}
      <div className="mt-6">
        <SmsProviderClient
          initialLogs={recentSmsLogs.map((r) => ({
            id: r.id,
            action: r.action,
            createdAt: r.createdAt.toISOString(),
            metadata: r.metadata as Record<string, unknown> | null,
          }))}
        />
      </div>
    </Shell>
  );
}

// Tiny helper — duplicated from the client to format the SMS provider
// detail string at the server. Keeps the client component pure.
function relativeTimeFromIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
}
