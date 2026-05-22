/**
 * CommunicationsCommandCenterClient — Phase 15A.
 *
 * Premium presentation layer that wraps the existing settings flow.
 * It is intentionally pure: every interactive flow (provider connect,
 * test SMS, template editor, automation editor) lives at its own
 * dedicated route. This component owns:
 *
 *   - Hero with insight chips
 *   - KPI cockpit (8 honest tiles from window aggregates)
 *   - Channel status cards (Email · SMS connected today, Push +
 *     WhatsApp staged as future-ready locked)
 *   - Quick action grid → Templates / Logs / Test / Automations
 *   - Template snapshot (last 8 modified)
 *   - Reminder automation cards (real counts per event type)
 *   - Future automation flows section (locked, aspirational)
 *
 * No internal mutation, no forms, no fetches — receives everything
 * the server computed and renders. Hydration-safe.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { PremiumCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Beaker,
  Braces,
  Calendar,
  CalendarX,
  CheckCircle2,
  Clock,
  Copy,
  FileText,
  Filter,
  Lock,
  Mail,
  MailCheck,
  MailX,
  MessageSquare,
  Phone,
  Play,
  RefreshCcw,
  Send,
  ShieldAlert,
  Sparkles,
  Star,
  TrendingUp,
  Wand2,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";

// Template variables — kept in sync with lib/communications/variables.ts.
// Duplicated here intentionally so this client component stays a pure
// "use client" boundary without importing server-side types.
const TEMPLATE_VARIABLES: ReadonlyArray<{ token: string; description: string }> = [
  { token: "customer_name", description: "Full name of the booking customer" },
  { token: "customer_first_name", description: "First name only" },
  { token: "business_name", description: "Your workspace display name" },
  { token: "service_name", description: "Booked service title" },
  { token: "staff_name", description: "Assigned staff member name" },
  { token: "appointment_date", description: "Booking date (localized)" },
  { token: "appointment_time", description: "Booking start time" },
  { token: "appointment_end_time", description: "Booking end time" },
  { token: "location_name", description: "Physical or virtual location" },
  { token: "meeting_link", description: "Video meeting URL (Zoom/Meet)" },
  { token: "booking_link", description: "Customer-facing booking detail URL" },
  { token: "cancel_link", description: "One-click cancellation URL" },
  { token: "reschedule_link", description: "One-click reschedule URL" },
  { token: "business_phone", description: "Workspace contact phone" },
  { token: "business_email", description: "Workspace contact email" },
  { token: "notes", description: "Booking notes / intake answers" },
  { token: "review_url", description: "Review request landing page" },
  { token: "review_platform", description: "Configured review platform name" },
  { token: "claim_url", description: "Waitlist claim URL" },
  { token: "claim_expires_at", description: "When the claim window expires" },
];

// ─── Types ─────────────────────────────────────────────────────────

type Summary = {
  windowDays: number;
  messages7: number;
  totalSent7: number;
  totalFailed7: number;
  skipped7: number;
  last24Sent: number;
  last24Failed: number;
  emailSent: number;
  emailFailed: number;
  smsSent: number;
  smsFailed: number;
  reminderSent: number;
  reminderFailed: number;
  emailSuccessPct: number | null;
  smsSuccessPct: number | null;
  reminderSuccessPct: number | null;
  eventTypeTotals: Record<string, number>;
  templatesCount: number;
  templatesEnabled: number;
  automationsCount: number;
  automationsEnabled: number;
  followupRulesCount: number;
  followupRulesEnabled: number;
  lastEmailSuccessAt: string | null;
  lastEmailProvider: string | null;
};

type ChannelData = {
  name: string;
  icon: "email" | "sms" | "push" | "whatsapp";
  connected: boolean;
  provider: string | null;
  detail: string;
  successPct: number | null;
  sentCount: number;
  failedCount: number;
  locked: boolean;
};

type TemplateRow = {
  id: string;
  templateType: string;
  channel: string;
  subject: string | null;
  enabled: boolean;
  systemDefault: boolean;
  updatedAt: string;
};

type AutomationRow = {
  id: string;
  triggerEvent: string;
  delayMinutes: number;
  channel: string;
  enabled: boolean;
  updatedAt: string;
};

type FollowupRow = {
  id: string;
  triggerEvent: string;
  enabled: boolean;
  updatedAt: string;
};

type FailureRow = {
  id: string;
  eventType: string;
  channel: string;
  provider: string | null;
  failureReason: string | null;
  createdAt: string;
};

type ActivityRow = {
  id: string;
  eventType: string;
  channel: string;
  status: string;
  provider: string | null;
  createdAt: string;
};

const EVENT_LABELS: Record<string, string> = {
  "appointment.created": "Booking confirmation",
  "appointment.cancelled": "Cancellation",
  "appointment.rescheduled": "Reschedule",
  "appointment.reminder_24h": "Reminder · 24h",
  "appointment.reminder_1h": "Reminder · 1h",
  "appointment.completed": "Completion follow-up",
  "appointment.no_show": "Missed booking",
  "booking.created": "Booking confirmation",
  "booking.cancelled": "Cancellation",
  "booking.rescheduled": "Reschedule",
  "booking.completed": "Completion follow-up",
  "booking.no_show": "Missed booking",
};

const EVENT_ICONS: Record<string, LucideIcon> = {
  "appointment.created": MailCheck,
  "booking.created": MailCheck,
  "appointment.reminder_24h": Bell,
  "appointment.reminder_1h": Clock,
  "appointment.cancelled": CalendarX,
  "booking.cancelled": CalendarX,
  "appointment.rescheduled": Calendar,
  "booking.rescheduled": Calendar,
  "appointment.completed": Star,
  "booking.completed": Star,
  "appointment.no_show": AlertTriangle,
  "booking.no_show": AlertTriangle,
};

// ─── Component ─────────────────────────────────────────────────────

export default function CommunicationsCommandCenterClient({
  tenantName,
  summary,
  insightChips,
  emailChannel,
  smsChannel,
  templates,
  automations,
  followupRules,
  recentFailures,
  recentActivity,
  hasAnalytics,
  currentPlanName,
}: {
  tenantName: string;
  summary: Summary;
  insightChips: string[];
  emailChannel: ChannelData;
  smsChannel: ChannelData;
  templates: TemplateRow[];
  automations: AutomationRow[];
  followupRules: FollowupRow[];
  recentFailures: FailureRow[];
  recentActivity: ActivityRow[];
  hasAnalytics: boolean;
  currentPlanName: string;
}) {
  const sendingLive =
    summary.lastEmailSuccessAt !== null &&
    Date.now() - new Date(summary.lastEmailSuccessAt).getTime() < 60 * 60_000;

  return (
    <div className="relative mt-2 space-y-5 pb-2">
      {/* Ambient depth */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 top-24 -z-10 h-[28rem] w-[28rem] rounded-full bg-brand-accent/[0.06] blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 top-80 -z-10 h-[24rem] w-[24rem] rounded-full bg-emerald-300/[0.05] blur-[120px]"
      />

      {/* ── Hero ─────────────────────────────────────────────── */}
      <FadeIn>
        <CommandHero
          tenantName={tenantName}
          insightChips={insightChips}
          sendingLive={sendingLive}
          smsConnected={smsChannel.connected}
          hasAnalytics={hasAnalytics}
        />
      </FadeIn>

      {/* ── Quick actions ────────────────────────────────────── */}
      <FadeIn delay={1}>
        <div>
          <SectionHead
            eyebrow="Operate"
            title="Quick actions"
            hint="The four most common communication workflows, one click away."
          />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <QuickActionCard
              icon={FileText}
              title="Edit templates"
              body="Confirmations, reminders, cancellations — every customer-facing message."
              href="/dashboard/settings/communications/templates"
              tone="brand"
            />
            <QuickActionCard
              icon={Activity}
              title="View delivery logs"
              body="Every send, skip, and failure with structured reasons."
              href="/dashboard/settings/communications/logs"
              tone="positive"
            />
            <QuickActionCard
              icon={Send}
              title="Test provider"
              body={
                smsChannel.connected
                  ? "Send a verification SMS via the connected provider."
                  : "Connect Twilio or Telnyx below to enable test sends."
              }
              href="#sms-provider"
              tone={smsChannel.connected ? "brand" : "neutral"}
              disabled={!smsChannel.connected}
              disabledReason={
                smsChannel.connected ? undefined : "Connect a provider below to send tests."
              }
            />
            <QuickActionCard
              icon={Workflow}
              title="Manage automations"
              body="Reminder rules, follow-ups, and event-driven sends."
              href="/dashboard/settings/automations"
              tone="amber"
            />
          </div>
        </div>
      </FadeIn>

      {/* ── KPI cockpit ──────────────────────────────────────── */}
      <FadeIn delay={2}>
        <div>
          <SectionHead
            eyebrow="Snapshot"
            title="Communication KPIs"
            hint={`Last ${summary.windowDays} days · ${summary.messages7} event${summary.messages7 === 1 ? "" : "s"} logged.`}
          />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Messages sent"
              value={String(summary.totalSent7)}
              detail={`${summary.last24Sent} in last 24h · email + SMS combined`}
              icon={Send}
              tone="brand"
            />
            <KpiCard
              label="Email success"
              value={
                summary.emailSuccessPct !== null
                  ? `${summary.emailSuccessPct}%`
                  : "—"
              }
              detail={
                summary.emailSuccessPct !== null
                  ? `${summary.emailSent} accepted · ${summary.emailFailed} failed`
                  : "No email traffic yet"
              }
              icon={MailCheck}
              tone={
                summary.emailSuccessPct === null
                  ? "neutral"
                  : summary.emailSuccessPct >= 95
                    ? "positive"
                    : summary.emailSuccessPct >= 80
                      ? "warning"
                      : "warning"
              }
            />
            <KpiCard
              label="SMS success"
              value={
                summary.smsSuccessPct !== null
                  ? `${summary.smsSuccessPct}%`
                  : smsChannel.connected
                    ? "—"
                    : "Not connected"
              }
              detail={
                summary.smsSuccessPct !== null
                  ? `${summary.smsSent} accepted · ${summary.smsFailed} failed`
                  : smsChannel.connected
                    ? "No SMS traffic in window"
                    : "Connect Twilio or Telnyx to enable"
              }
              icon={MessageSquare}
              tone={
                summary.smsSuccessPct === null
                  ? "neutral"
                  : summary.smsSuccessPct >= 95
                    ? "positive"
                    : "warning"
              }
            />
            <KpiCard
              label="Reminder delivery"
              value={
                summary.reminderSuccessPct !== null
                  ? `${summary.reminderSuccessPct}%`
                  : "—"
              }
              detail={
                summary.reminderSuccessPct !== null
                  ? `${summary.reminderSent} sent · ${summary.reminderFailed} failed`
                  : "Reminders dispatch automatically 24h + 1h before"
              }
              icon={Bell}
              tone={
                summary.reminderSuccessPct === null
                  ? "neutral"
                  : summary.reminderSuccessPct >= 95
                    ? "positive"
                    : "warning"
              }
            />
            <KpiCard
              label="Failures"
              value={String(summary.totalFailed7)}
              detail={
                summary.last24Failed > 0
                  ? `${summary.last24Failed} in last 24h`
                  : "No failures in last 24h"
              }
              icon={MailX}
              tone={summary.totalFailed7 > 0 ? "warning" : "neutral"}
            />
            <KpiCard
              label="Skipped"
              value={String(summary.skipped7)}
              detail="Suppressed by policy, gate, or idempotency"
              icon={ShieldAlert}
              tone="neutral"
            />
            <KpiCard
              label="Active templates"
              value={`${summary.templatesEnabled} / ${summary.templatesCount || 0}`}
              detail={
                summary.templatesCount === 0
                  ? "Customize how confirmations and reminders read"
                  : `${summary.templatesEnabled} enabled of ${summary.templatesCount} configured`
              }
              icon={FileText}
              tone="brand"
            />
            <KpiCard
              label="Automations running"
              value={String(summary.automationsEnabled + summary.followupRulesEnabled)}
              detail={`${summary.automationsCount + summary.followupRulesCount} configured · ${(summary.automationsEnabled + summary.followupRulesEnabled)} enabled`}
              icon={Workflow}
              tone="positive"
            />
          </div>
        </div>
      </FadeIn>

      {/* ── Channels ─────────────────────────────────────────── */}
      <FadeIn delay={3}>
        <div>
          <SectionHead
            eyebrow="Channels"
            title="Communication channels"
            hint="One row per outbound surface — connected, future-ready, or staged for upgrade."
          />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <ChannelCard data={emailChannel} />
            <ChannelCard data={smsChannel} />
            <ChannelCard
              data={{
                name: "Push notifications",
                icon: "push",
                connected: false,
                provider: null,
                detail: "Native push for mobile apps — included in the upcoming workforce-app release.",
                successPct: null,
                sentCount: 0,
                failedCount: 0,
                locked: true,
              }}
            />
            <ChannelCard
              data={{
                name: "WhatsApp",
                icon: "whatsapp",
                connected: false,
                provider: null,
                detail: "WhatsApp Business API integration — staged for enterprise rollout.",
                successPct: null,
                sentCount: 0,
                failedCount: 0,
                locked: true,
              }}
            />
          </div>
        </div>
      </FadeIn>

      {/* ── Phase 15B — Test center ──────────────────────────── */}
      <FadeIn delay={4}>
        <TestCenterSection
          smsConnected={smsChannel.connected}
          smsProvider={smsChannel.provider}
        />
      </FadeIn>

      {/* ── Phase 15B — Delivery intelligence ────────────────── */}
      <FadeIn delay={4}>
        <DeliveryIntelligenceSection
          recentFailures={recentFailures}
          skipped7={summary.skipped7}
          failureRatePct={
            summary.totalSent7 + summary.totalFailed7 > 0
              ? Math.round(
                  (summary.totalFailed7 /
                    (summary.totalSent7 + summary.totalFailed7)) *
                    100,
                )
              : 0
          }
          hasAnalytics={hasAnalytics}
          currentPlanName={currentPlanName}
        />
      </FadeIn>

      {/* ── Reminder automation ──────────────────────────────── */}
      <FadeIn delay={5}>
        <ReminderAutomationSection
          eventTotals={summary.eventTypeTotals}
          automations={automations}
          followupRules={followupRules}
        />
      </FadeIn>

      {/* ── Phase 15B — Template variables reference ─────────── */}
      <FadeIn delay={5}>
        <TemplateVariablesReference />
      </FadeIn>

      {/* ── Template snapshot ────────────────────────────────── */}
      <FadeIn delay={6}>
        <TemplateSnapshotSection
          templates={templates}
          totalCount={summary.templatesCount}
          enabledCount={summary.templatesEnabled}
        />
      </FadeIn>

      {/* ── Future automation flows (locked) ─────────────────── */}
      <FadeIn delay={7}>
        <FutureFlowsSection
          hasAnalytics={hasAnalytics}
          currentPlanName={currentPlanName}
        />
      </FadeIn>

      {/* ── Phase 15B — Inline communication timeline ────────── */}
      <FadeIn delay={7}>
        <ActivityTimelineSection rows={recentActivity} />
      </FadeIn>

      {/* ── SMS provider anchor ──────────────────────────────── */}
      <FadeIn delay={8}>
        <div id="sms-provider">
          <SectionHead
            eyebrow="Provider"
            title="SMS provider configuration"
            hint="Bring your own Twilio or Telnyx account. Credentials are encrypted at rest — only the last few characters of the auth token are ever shown."
          />
        </div>
      </FadeIn>
    </div>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────

function CommandHero({
  tenantName,
  insightChips,
  sendingLive,
  smsConnected,
  hasAnalytics,
}: {
  tenantName: string;
  insightChips: string[];
  sendingLive: boolean;
  smsConnected: boolean;
  hasAnalytics: boolean;
}) {
  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/55 via-surface to-surface"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-28 -top-28 h-72 w-72 rounded-full bg-brand-accent/[0.14] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-20 -bottom-20 h-56 w-56 rounded-full bg-emerald-200/[0.18] blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            <MessageSquare className="h-3 w-3" strokeWidth={2} />
            Communications command center
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Communications
          </h1>
          <p className="mt-0.5 max-w-2xl text-[12px] text-ink-muted">
            <span className="font-medium text-ink">{tenantName}</span> &middot; messaging
            infrastructure, reminders, templates, delivery intelligence, and customer
            communication controls.
          </p>

          {insightChips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {insightChips.slice(0, 4).map((line, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-border/60 backdrop-blur-sm"
                >
                  <Sparkles className="h-3 w-3 text-brand-accent" strokeWidth={2} />
                  {line}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {sendingLive && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.10em] text-emerald-700 ring-1 ring-emerald-200/40">
              <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inset-0 inline-flex animate-ping rounded-full bg-emerald-400/60" />
                <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              Delivery live
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.10em] ring-1",
              smsConnected
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
                : "bg-amber-50 text-amber-700 ring-amber-200/40",
            )}
          >
            {smsConnected ? (
              <>
                <Phone className="h-3 w-3" strokeWidth={2} />
                SMS connected
              </>
            ) : (
              <>
                <Phone className="h-3 w-3" strokeWidth={2} />
                SMS not configured
              </>
            )}
          </span>
          <Link
            href="/dashboard/settings/communications/templates"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
          >
            <FileText className="h-3.5 w-3.5" strokeWidth={1.75} />
            Templates
          </Link>
          {!hasAnalytics && (
            <Link
              href="/dashboard/billing"
              className="zm-pulse-glow inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-r from-brand-accent to-brand-hover px-3 text-[12px] font-semibold text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
            >
              <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
              Unlock automations
            </Link>
          )}
        </div>
      </div>
    </PremiumCard>
  );
}

// ─── KPI tile ──────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone: "brand" | "positive" | "warning" | "neutral";
}) {
  const iconTone =
    tone === "positive"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
      : tone === "warning"
        ? "bg-amber-50 text-amber-700 ring-amber-200/40"
        : tone === "brand"
          ? "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15"
          : "bg-surface-inset text-ink-subtle ring-border/40";
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            {label}
          </div>
          <div className="mt-1 text-[20px] font-semibold tracking-tight text-ink tabular-nums">
            {value}
          </div>
          <p className="mt-1 text-[11px] text-ink-muted">{detail}</p>
        </div>
        <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1", iconTone)}>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
      </div>
    </div>
  );
}

// ─── Quick action card ─────────────────────────────────────────────

function QuickActionCard({
  icon: Icon,
  title,
  body,
  href,
  tone,
  disabled,
  disabledReason,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  href: string;
  tone: "brand" | "positive" | "amber" | "neutral";
  disabled?: boolean;
  disabledReason?: string;
}) {
  const iconTone =
    tone === "positive"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
      : tone === "amber"
        ? "bg-amber-50 text-amber-700 ring-amber-200/40"
        : tone === "neutral"
          ? "bg-surface-inset text-ink-subtle ring-border/40"
          : "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15";

  const inner = (
    <>
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="flex items-start gap-2.5">
        <span className={cn("inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1", iconTone)}>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{body}</p>
        </div>
      </div>
      <div className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium">
        {disabled ? (
          <span className="text-ink-subtle">{disabledReason ?? "Disabled"}</span>
        ) : (
          <>
            <span className="text-brand-accent">Open</span>
            <ArrowUpRight className="h-3.5 w-3.5 text-brand-accent transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" strokeWidth={2} />
          </>
        )}
      </div>
    </>
  );

  const base =
    "group relative block overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]";

  if (disabled) {
    return (
      <div className={cn(base, "opacity-70")} title={disabledReason ?? undefined}>
        {inner}
      </div>
    );
  }

  return (
    <Link href={href} className={cn(base, "hover:-translate-y-0.5 hover:shadow-soft")}>
      {inner}
    </Link>
  );
}

// ─── Channel card ──────────────────────────────────────────────────

function ChannelCard({ data }: { data: ChannelData }) {
  const ChannelIcon: LucideIcon =
    data.icon === "email"
      ? Mail
      : data.icon === "sms"
        ? MessageSquare
        : data.icon === "push"
          ? Bell
          : Phone;
  const status: "connected" | "warning" | "disconnected" | "locked" = data.locked
    ? "locked"
    : data.connected
      ? data.failedCount > 0 && data.successPct !== null && data.successPct < 90
        ? "warning"
        : "connected"
      : "disconnected";
  const ring =
    status === "connected"
      ? "ring-emerald-200/40 bg-emerald-50/40"
      : status === "warning"
        ? "ring-amber-200/40 bg-amber-50/40"
        : status === "disconnected"
          ? "ring-border/40 bg-surface-inset/30"
          : "ring-border/40 bg-surface-inset/50";
  const iconTone =
    status === "connected"
      ? "bg-emerald-100/80 text-emerald-700"
      : status === "warning"
        ? "bg-amber-100/80 text-amber-700"
        : status === "disconnected"
          ? "bg-surface text-ink-subtle"
          : "bg-surface-inset text-ink-subtle";
  const dotTone =
    status === "connected"
      ? "bg-emerald-500"
      : status === "warning"
        ? "bg-amber-500"
        : "bg-ink-subtle";
  const statusLabel =
    status === "connected"
      ? "Connected"
      : status === "warning"
        ? "Warning"
        : status === "disconnected"
          ? "Not connected"
          : "Coming soon";

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border/60 p-4 ring-1 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft",
        ring,
      )}
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", iconTone)}>
              <ChannelIcon className="h-4 w-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold tracking-tight text-ink">{data.name}</div>
              {data.provider && (
                <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
                  via {data.provider}
                </div>
              )}
            </div>
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-muted">{data.detail}</p>
          {data.successPct !== null && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Success
              </span>
              <span className="text-[12.5px] font-semibold tabular-nums text-ink">
                {data.successPct}%
              </span>
              <span className="text-[10px] text-ink-subtle">
                ({data.sentCount} sent · {data.failedCount} failed)
              </span>
            </div>
          )}
        </div>
        {data.locked && (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle ring-1 ring-border/40">
            <Lock className="h-2.5 w-2.5" strokeWidth={2} />
            Soon
          </span>
        )}
      </div>
      <div className="mt-3 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-muted">
        <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
          {status === "connected" && (
            <span className={cn("absolute inset-0 inline-flex animate-ping rounded-full opacity-60", dotTone)} />
          )}
          <span className={cn("relative inline-block h-1.5 w-1.5 rounded-full", dotTone)} />
        </span>
        {statusLabel}
      </div>
    </div>
  );
}

// ─── Reminder automation ───────────────────────────────────────────

function ReminderAutomationSection({
  eventTotals,
  automations,
  followupRules,
}: {
  eventTotals: Record<string, number>;
  automations: AutomationRow[];
  followupRules: FollowupRow[];
}) {
  // Roll up by trigger event — sums automationRules + followupRules,
  // showing the combined enabled count. Every entry is rendered.
  type RowAgg = { event: string; enabled: number; total: number; lastUpdated: string | null };
  const rolledUp = new Map<string, RowAgg>();
  for (const a of automations) {
    const cur =
      rolledUp.get(a.triggerEvent) ?? { event: a.triggerEvent, enabled: 0, total: 0, lastUpdated: null };
    cur.total += 1;
    if (a.enabled) cur.enabled += 1;
    if (!cur.lastUpdated || a.updatedAt > cur.lastUpdated) cur.lastUpdated = a.updatedAt;
    rolledUp.set(a.triggerEvent, cur);
  }
  for (const r of followupRules) {
    const cur =
      rolledUp.get(r.triggerEvent) ?? { event: r.triggerEvent, enabled: 0, total: 0, lastUpdated: null };
    cur.total += 1;
    if (r.enabled) cur.enabled += 1;
    if (!cur.lastUpdated || r.updatedAt > cur.lastUpdated) cur.lastUpdated = r.updatedAt;
    rolledUp.set(r.triggerEvent, cur);
  }

  // Default surface — show the lifecycle events even if the tenant
  // has no rules yet, so the workspace doesn't feel barren.
  const defaultEvents = [
    "appointment.created",
    "appointment.reminder_24h",
    "appointment.reminder_1h",
    "appointment.cancelled",
    "appointment.rescheduled",
    "appointment.completed",
    "appointment.no_show",
  ];
  for (const ev of defaultEvents) {
    if (!rolledUp.has(ev)) {
      rolledUp.set(ev, { event: ev, enabled: 0, total: 0, lastUpdated: null });
    }
  }

  const rows = Array.from(rolledUp.values()).sort((a, b) => {
    // Stable lifecycle order: defaults first, custom events appended.
    const idxA = defaultEvents.indexOf(a.event);
    const idxB = defaultEvents.indexOf(b.event);
    if (idxA === -1 && idxB === -1) return a.event.localeCompare(b.event);
    if (idxA === -1) return 1;
    if (idxB === -1) return -1;
    return idxA - idxB;
  });

  return (
    <div>
      <SectionHead
        eyebrow="Lifecycle"
        title="Reminder automation center"
        hint="Every event that triggers an outbound message — configure timing, channel, and template per rule."
      />
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => {
          const Icon = EVENT_ICONS[row.event] ?? Mail;
          const label = EVENT_LABELS[row.event] ?? row.event;
          const sentCount = eventTotals[row.event] ?? 0;
          const isEnabled = row.enabled > 0;
          const isConfigured = row.total > 0;
          return (
            <Link
              key={row.event}
              href="/dashboard/settings/automations"
              className="group relative block overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft"
            >
              <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
              <div className="flex items-start gap-2.5">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-[12.5px] font-semibold tracking-tight text-ink">{label}</h3>
                    <span
                      className={cn(
                        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ring-1",
                        isEnabled
                          ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
                          : isConfigured
                            ? "bg-amber-50 text-amber-700 ring-amber-200/40"
                            : "bg-surface-inset text-ink-subtle ring-border/40",
                      )}
                    >
                      {isEnabled ? "Enabled" : isConfigured ? "Disabled" : "Not configured"}
                    </span>
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-ink-muted">
                    <span>
                      <span className="font-semibold tabular-nums text-ink">{sentCount}</span> sent
                    </span>
                    <span>
                      <span className="font-semibold tabular-nums text-ink">{row.enabled}</span>/
                      <span className="tabular-nums text-ink">{row.total}</span> rules on
                    </span>
                  </div>
                  {row.lastUpdated && (
                    <p className="mt-1 text-[10.5px] text-ink-subtle">
                      Last edited {relativeTime(row.lastUpdated)}
                    </p>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ─── Template snapshot ─────────────────────────────────────────────

function TemplateSnapshotSection({
  templates,
  totalCount,
  enabledCount,
}: {
  templates: TemplateRow[];
  totalCount: number;
  enabledCount: number;
}) {
  return (
    <div>
      <SectionHead
        eyebrow="Library"
        title="Template snapshot"
        hint={
          totalCount === 0
            ? "Customize how confirmations, reminders, and cancellations read for your customers."
            : `${enabledCount} of ${totalCount} templates currently enabled · most recently edited first.`
        }
      />
      <PremiumCard className="relative mt-3 overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
        {templates.length === 0 ? (
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
                <FileText className="h-4 w-4" strokeWidth={1.75} />
              </div>
              <div className="min-w-0">
                <h3 className="text-[13.5px] font-semibold tracking-tight text-ink">
                  Default templates active
                </h3>
                <p className="mt-0.5 max-w-xl text-[11.5px] leading-relaxed text-ink-muted">
                  Confirmations, reminders, and cancellations use a tasteful built-in default until
                  you customize them. Open the template editor to brand them with your voice.
                </p>
              </div>
            </div>
            <Link
              href="/dashboard/settings/communications/templates"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-accent px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-[0_4px_14px_rgba(53,157,243,0.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(53,157,243,0.40)]"
            >
              <FileText className="h-3.5 w-3.5" strokeWidth={2} />
              Open templates
              <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
            </Link>
          </div>
        ) : (
          <>
            <ul className="space-y-2">
              {templates.slice(0, 6).map((t) => {
                const Icon = EVENT_ICONS[t.templateType] ?? FileText;
                const label = EVENT_LABELS[t.templateType] ?? t.templateType;
                return (
                  <li
                    key={t.id}
                    className="relative flex items-start gap-3 rounded-xl border border-border/60 bg-surface p-3 transition-colors hover:bg-surface-inset/40"
                  >
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
                      <Icon className="h-4 w-4" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-[12.5px] font-semibold text-ink">{label}</span>
                        <span className="inline-flex items-center rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle ring-1 ring-border/40">
                          {t.channel}
                        </span>
                        {t.systemDefault && (
                          <span className="inline-flex items-center rounded-full bg-brand-subtle/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-brand-accent ring-1 ring-brand-accent/20">
                            Default
                          </span>
                        )}
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ring-1",
                            t.enabled
                              ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
                              : "bg-surface-inset text-ink-subtle ring-border/40",
                          )}
                        >
                          {t.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </div>
                      {t.subject && (
                        <p className="mt-0.5 truncate text-[11px] text-ink-muted">{t.subject}</p>
                      )}
                      <p className="mt-0.5 text-[10.5px] text-ink-subtle">
                        Edited {relativeTime(t.updatedAt)}
                      </p>
                    </div>
                    <Link
                      href="/dashboard/settings/communications/templates"
                      className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-brand-accent hover:underline"
                    >
                      Edit
                      <ArrowUpRight className="h-3 w-3" strokeWidth={2.25} />
                    </Link>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 flex items-center justify-between text-[11px] text-ink-subtle">
              <span>Showing {Math.min(6, templates.length)} of {totalCount}</span>
              <Link
                href="/dashboard/settings/communications/templates"
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-accent hover:underline"
              >
                Open template editor
                <ArrowUpRight className="h-3 w-3" strokeWidth={2.25} />
              </Link>
            </div>
          </>
        )}
      </PremiumCard>
    </div>
  );
}

// ─── Future automation flows (locked, aspirational) ────────────────

function FutureFlowsSection({
  hasAnalytics,
  currentPlanName,
}: {
  hasAnalytics: boolean;
  currentPlanName: string;
}) {
  const flows: Array<{ icon: LucideIcon; title: string; body: string }> = [
    {
      icon: Workflow,
      title: "Multi-step workflows",
      body: "Chain reminders, follow-ups, and review requests into a single conditional flow.",
    },
    {
      icon: Wand2,
      title: "Conditional reminders",
      body: "Skip reminders for repeat customers · escalate to SMS when an email bounces.",
    },
    {
      icon: TrendingUp,
      title: "Drip campaigns",
      body: "Multi-touch nurturing sequences with cadence + send-time optimization.",
    },
    {
      icon: Star,
      title: "Review request automation",
      body: "Trigger review prompts a set delay after completion · only on high-confidence customers.",
    },
    {
      icon: RefreshCcw,
      title: "Abandoned booking recovery",
      body: "Detect started-but-not-completed bookings and re-engage with a tailored message.",
    },
    {
      icon: Zap,
      title: "VIP follow-up automation",
      body: "Identify your top-value customers and automate white-glove communication.",
    },
  ];
  return (
    <div>
      <SectionHead
        eyebrow="Future automation"
        title="Automation flows"
        hint="A visual preview of the workflow surfaces landing on Pro plans."
      />
      <PremiumCard className="relative mt-3 overflow-hidden bg-gradient-to-br from-amber-50/30 via-surface to-surface p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-amber-200/[0.18] blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
        <div className="relative">
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-50 to-surface text-amber-700 ring-1 ring-amber-200/40">
                <Workflow className="h-4 w-4" strokeWidth={1.75} />
              </div>
              <div>
                <div className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.10em] text-amber-700 ring-1 ring-amber-200/40">
                  <Lock className="h-2.5 w-2.5" strokeWidth={2} />
                  Pro · Coming soon
                </div>
                <h3 className="mt-1 text-[14px] font-semibold tracking-tight text-ink">
                  Workflow-grade automation
                </h3>
                <p className="mt-0.5 max-w-xl text-[11.5px] leading-relaxed text-ink-muted">
                  Phase 15A previews the surfaces. The underlying engine ships in a follow-up — until
                  then the cards below are visually staged, not clickable.
                </p>
              </div>
            </div>
            {!hasAnalytics && (
              <Link
                href="/dashboard/billing"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-accent px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-[0_4px_14px_rgba(53,157,243,0.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(53,157,243,0.40)]"
              >
                <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
                Unlock from {currentPlanName}
                <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
              </Link>
            )}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {flows.map((f) => {
              const Icon = f.icon;
              return (
                <div
                  key={f.title}
                  className="relative overflow-hidden rounded-2xl border border-border/60 bg-surface/80 p-3.5 opacity-80"
                  aria-disabled
                >
                  <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
                  <div className="flex items-start gap-2.5">
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700 ring-1 ring-amber-200/40">
                      <Icon className="h-4 w-4" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0">
                      <h4 className="text-[12.5px] font-semibold tracking-tight text-ink">{f.title}</h4>
                      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{f.body}</p>
                    </div>
                  </div>
                  <div className="mt-3 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
                    <Lock className="h-2.5 w-2.5" strokeWidth={2} />
                    Staged
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </PremiumCard>
    </div>
  );
}

// ─── Shared bits ───────────────────────────────────────────────────

function SectionHead({
  eyebrow,
  title,
  hint,
}: {
  eyebrow: string;
  title: string;
  hint?: string;
}) {
  return (
    <header className="mb-1">
      <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
        {eyebrow}
      </div>
      <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
      {hint && <p className="mt-0.5 text-[12px] text-ink-muted">{hint}</p>}
    </header>
  );
}

function relativeTime(iso: string): string {
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

// ─── Phase 15B · Test Center ───────────────────────────────────────

function TestCenterSection({
  smsConnected,
  smsProvider,
}: {
  smsConnected: boolean;
  smsProvider: string | null;
}) {
  // Three test surfaces — each card routes to the place that already
  // owns the real test flow. No fake forms, no fabricated delivery
  // attempts: every "Run test" button either links to a working
  // surface or renders disabled with an explanatory reason.
  return (
    <div>
      <SectionHead
        eyebrow="Test center"
        title="Verify before you send"
        hint="Each verification path runs against the real provider chain — no simulated delivery."
      />
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TestCard
          icon={Mail}
          tone="brand"
          title="Test email"
          body="Send a template to a recipient of your choice. Bypasses the customer-preference gate by design — this is an admin verification path."
          status="ready"
          actionLabel="Open template editor"
          href="/dashboard/settings/communications/templates"
          meta="Real send via SES/SMTP · rate-limited 10/10min"
        />
        <TestCard
          icon={MessageSquare}
          tone={smsConnected ? "positive" : "neutral"}
          title="Test SMS"
          body={
            smsConnected
              ? `Dispatch a verification SMS through your connected ${smsProvider} account.`
              : "Connect Twilio or Telnyx below to enable SMS verification."
          }
          status={smsConnected ? "ready" : "disabled"}
          actionLabel={smsConnected ? "Send test SMS" : "Connect provider"}
          href="#sms-provider"
          meta={
            smsConnected
              ? "Real send via your connected provider"
              : "Provider connection required"
          }
        />
        <TestCard
          icon={Braces}
          tone="amber"
          title="Variable preview"
          body="Render a template against sample data to validate placeholder substitution and copy in context."
          status="ready"
          actionLabel="Open template editor"
          href="/dashboard/settings/communications/templates"
          meta="Live preview inside the template editor"
        />
      </div>
    </div>
  );
}

function TestCard({
  icon: Icon,
  tone,
  title,
  body,
  status,
  actionLabel,
  href,
  meta,
}: {
  icon: LucideIcon;
  tone: "brand" | "positive" | "amber" | "neutral";
  title: string;
  body: string;
  status: "ready" | "disabled";
  actionLabel: string;
  href: string;
  meta: string;
}) {
  const iconTone =
    tone === "positive"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
      : tone === "amber"
        ? "bg-amber-50 text-amber-700 ring-amber-200/40"
        : tone === "neutral"
          ? "bg-surface-inset text-ink-subtle ring-border/40"
          : "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15";
  const isReady = status === "ready";
  const base =
    "group relative block overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]";
  const inner = (
    <>
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="flex items-start gap-2.5">
        <span className={cn("inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1", iconTone)}>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h3>
            <span
              className={cn(
                "inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ring-1",
                isReady
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
                  : "bg-surface-inset text-ink-subtle ring-border/40",
              )}
            >
              {isReady ? "Ready" : "Locked"}
            </span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{body}</p>
          <p className="mt-1.5 text-[10.5px] text-ink-subtle">{meta}</p>
        </div>
      </div>
      <div className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold">
        {isReady ? (
          <span className="inline-flex items-center gap-1 text-brand-accent">
            <Play className="h-3 w-3" strokeWidth={2.25} />
            {actionLabel}
            <ArrowUpRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" strokeWidth={2} />
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-ink-subtle">
            <Lock className="h-3 w-3" strokeWidth={2} />
            {actionLabel}
          </span>
        )}
      </div>
    </>
  );

  return (
    <Link
      href={href}
      className={cn(
        base,
        isReady
          ? "hover:-translate-y-0.5 hover:shadow-soft hover:border-brand-accent/40"
          : "opacity-80",
      )}
    >
      {inner}
    </Link>
  );
}

// ─── Phase 15B · Delivery intelligence ─────────────────────────────

function DeliveryIntelligenceSection({
  recentFailures,
  skipped7,
  failureRatePct,
  hasAnalytics,
  currentPlanName,
}: {
  recentFailures: FailureRow[];
  skipped7: number;
  failureRatePct: number;
  hasAnalytics: boolean;
  currentPlanName: string;
}) {
  const degradation: "healthy" | "warning" | "degraded" | "critical" =
    failureRatePct === 0
      ? "healthy"
      : failureRatePct < 5
        ? "healthy"
        : failureRatePct < 15
          ? "warning"
          : failureRatePct < 30
            ? "degraded"
            : "critical";
  return (
    <div>
      <SectionHead
        eyebrow="Diagnostics"
        title="Delivery intelligence"
        hint="Real signals from the delivery pipeline — failures, skips, and degradation warnings surfaced inline."
      />
      <PremiumCard className="relative mt-3 overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />

        {/* Degradation banner — pulls from the same failure rate the
            KPI cockpit derives. Renders only when there's signal. */}
        {(degradation === "warning" || degradation === "degraded" || degradation === "critical") && (
          <div
            className={cn(
              "mb-3 flex flex-col items-start gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between",
              degradation === "warning"
                ? "border-amber-200/40 bg-amber-50/40"
                : degradation === "degraded"
                  ? "border-orange-200/40 bg-orange-50/40"
                  : "border-rose-200/40 bg-rose-50/40",
            )}
          >
            <div className="flex items-start gap-2.5">
              <span
                className={cn(
                  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1",
                  degradation === "warning"
                    ? "bg-amber-100/80 text-amber-700 ring-amber-200/40"
                    : degradation === "degraded"
                      ? "bg-orange-100/80 text-orange-700 ring-orange-200/40"
                      : "bg-rose-100/80 text-rose-700 ring-rose-200/40",
                )}
              >
                <ShieldAlert className="h-4 w-4" strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <h3 className="text-[12.5px] font-semibold tracking-tight text-ink">
                  {degradation === "critical"
                    ? `Delivery critical — ${failureRatePct}% failure rate`
                    : degradation === "degraded"
                      ? `Delivery degraded — ${failureRatePct}% failure rate`
                      : `Delivery warning — ${failureRatePct}% failure rate`}
                </h3>
                <p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-ink-muted">
                  Review the most recent failures below. A spike here often correlates with
                  template-rendering issues, suppressed addresses, or provider quota hits.
                </p>
              </div>
            </div>
            <Link
              href="/dashboard/settings/communications/logs"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] font-semibold text-ink shadow-soft transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:shadow-md"
            >
              <Activity className="h-3 w-3" strokeWidth={2} />
              Open delivery logs
              <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
            </Link>
          </div>
        )}

        {/* Skipped + failure summary chips */}
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1",
              degradation === "healthy"
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
                : "bg-amber-50 text-amber-700 ring-amber-200/40",
            )}
          >
            <Activity className="h-3 w-3" strokeWidth={2.25} />
            Failure rate{" "}
            <span className="font-semibold tabular-nums">{failureRatePct}%</span>
          </span>
          {skipped7 > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-2 py-0.5 text-ink-muted ring-1 ring-border/40">
              <Filter className="h-3 w-3" strokeWidth={2.25} />
              {skipped7} skipped (policy / gate)
            </span>
          )}
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-2 py-0.5 text-ink-subtle ring-1 ring-border/40">
            Reasons captured per-event
          </span>
        </div>

        {/* Recent failures list */}
        {recentFailures.length === 0 ? (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-emerald-200/40 bg-emerald-50/30 p-3">
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100/80 text-emerald-700 ring-1 ring-emerald-200/40">
              <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <h3 className="text-[12.5px] font-semibold tracking-tight text-ink">
                No recent delivery failures
              </h3>
              <p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-ink-muted">
                Every outbound message this workspace tried to send has either been accepted by the
                provider or intentionally skipped. Failures will surface here when they happen.
              </p>
            </div>
          </div>
        ) : (
          <ul className="mt-4 space-y-2">
            {recentFailures.map((f) => {
              const Icon = EVENT_ICONS[f.eventType] ?? MailX;
              const label = EVENT_LABELS[f.eventType] ?? f.eventType;
              return (
                <li
                  key={f.id}
                  className="relative overflow-hidden rounded-xl border border-rose-200/40 bg-rose-50/30 p-3"
                >
                  <div className="flex items-start gap-2.5">
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rose-100/80 text-rose-700 ring-1 ring-rose-200/50">
                      <Icon className="h-4 w-4" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-[12.5px] font-semibold tracking-tight text-ink">
                          {label}
                        </span>
                        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                          {relativeTime(f.createdAt)}
                        </span>
                        <span className="inline-flex items-center rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle ring-1 ring-border/40">
                          {f.channel}
                        </span>
                        {f.provider && (
                          <span className="inline-flex items-center rounded-full bg-rose-100/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-rose-700 ring-1 ring-rose-200/40">
                            via {f.provider}
                          </span>
                        )}
                      </div>
                      {f.failureReason && (
                        <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap rounded-md border border-rose-200/40 bg-white/70 p-2 text-[10.5px] font-mono leading-relaxed text-rose-900">
                          {f.failureReason.length > 320
                            ? f.failureReason.slice(0, 320) + "…"
                            : f.failureReason}
                        </pre>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Pro upsell — diagnostics + retry queue is gated. */}
        {!hasAnalytics && (
          <div className="mt-4 rounded-xl border border-amber-200/40 bg-amber-50/30 p-3">
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2.5">
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100/80 text-amber-700 ring-1 ring-amber-200/40">
                  <Lock className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-0">
                  <div className="inline-flex items-center gap-1 rounded-full bg-amber-100/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.10em] text-amber-700 ring-1 ring-amber-200/40">
                    Pro feature
                  </div>
                  <h3 className="mt-1 text-[12.5px] font-semibold tracking-tight text-ink">
                    Advanced diagnostics &amp; retry queues
                  </h3>
                  <p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-ink-muted">
                    Upgrade from {currentPlanName} to unlock automated retry queues, suppression
                    handling, and provider-response forensics.
                  </p>
                </div>
              </div>
              <Link
                href="/dashboard/billing"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-accent px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-[0_4px_14px_rgba(53,157,243,0.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(53,157,243,0.40)]"
              >
                <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
                Unlock diagnostics
                <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
              </Link>
            </div>
          </div>
        )}
      </PremiumCard>
    </div>
  );
}

// ─── Phase 15B · Template variables reference ──────────────────────

function TemplateVariablesReference() {
  const [mode, setMode] = React.useState<"light" | "dark">("light");
  // Click-to-copy on a token chip — uses navigator.clipboard if
  // available, falls back silently. No fake feedback shown if
  // clipboard isn't available.
  const [copied, setCopied] = React.useState<string | null>(null);

  function copy(token: string) {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(`{{${token}}}`)
      .then(() => {
        setCopied(token);
        setTimeout(() => setCopied(null), 1200);
      })
      .catch(() => {
        /* silent — no toast yet */
      });
  }

  return (
    <div>
      <SectionHead
        eyebrow="Library"
        title="Template variables"
        hint="Drop these tokens into any subject or body — the engine substitutes them with real booking data at send time."
      />
      <PremiumCard className="relative mt-3 overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />

        {/* Header row with light/dark preview toggle (visual hint
            for the upcoming template-editor preview mode). */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
              <Braces className="h-4 w-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold tracking-tight text-ink">
                {TEMPLATE_VARIABLES.length} supported tokens
              </p>
              <p className="mt-0.5 text-[10.5px] text-ink-subtle">
                Click any token to copy its <code className="rounded bg-surface-inset px-1 py-0.5 font-mono text-[10px]">{`{{token}}`}</code> form.
              </p>
            </div>
          </div>
          <div className="inline-flex rounded-full border border-border bg-surface p-0.5">
            <button
              type="button"
              onClick={() => setMode("light")}
              className={cn(
                "rounded-full px-2.5 py-1 text-[10.5px] font-semibold transition-all",
                mode === "light"
                  ? "bg-brand-accent text-white shadow-[0_2px_8px_rgba(53,157,243,0.32)]"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              Light preview
            </button>
            <button
              type="button"
              onClick={() => setMode("dark")}
              className={cn(
                "rounded-full px-2.5 py-1 text-[10.5px] font-semibold transition-all",
                mode === "dark"
                  ? "bg-brand-accent text-white shadow-[0_2px_8px_rgba(53,157,243,0.32)]"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              Dark preview
            </button>
          </div>
        </div>

        {/* Token grid + visual preview surface */}
        <div className="mt-4 grid gap-3 lg:grid-cols-[1.5fr_1fr]">
          {/* Token grid */}
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {TEMPLATE_VARIABLES.map((v) => (
              <li key={v.token}>
                <button
                  type="button"
                  onClick={() => copy(v.token)}
                  className="group flex w-full items-start gap-2 rounded-md border border-border/60 bg-surface px-2 py-1.5 text-left transition-colors hover:border-brand-accent/30 hover:bg-surface-inset/40"
                  title={`Copy {{${v.token}}}`}
                >
                  <code className="shrink-0 rounded bg-brand-subtle/50 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-brand-accent">
                    {`{{${v.token}}}`}
                  </code>
                  <span className="min-w-0 flex-1 truncate text-[10.5px] text-ink-muted">
                    {v.description}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 transition-opacity",
                      copied === v.token ? "opacity-100" : "opacity-0 group-hover:opacity-60",
                    )}
                  >
                    {copied === v.token ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-600" strokeWidth={2.25} />
                    ) : (
                      <Copy className="h-3 w-3 text-ink-subtle" strokeWidth={2} />
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {/* Visual email preview — purely decorative. No fake
              content beyond the literal token names so it always
              reads honestly. */}
          <div
            className={cn(
              "relative overflow-hidden rounded-2xl border p-4 transition-colors",
              mode === "light"
                ? "border-border/60 bg-surface"
                : "border-slate-700 bg-slate-900",
            )}
            aria-hidden
          >
            <div
              className={cn(
                "text-[10px] font-semibold uppercase tracking-[0.10em]",
                mode === "light" ? "text-ink-subtle" : "text-slate-400",
              )}
            >
              Preview
            </div>
            <div className="mt-2 space-y-2">
              <div
                className={cn(
                  "h-3 w-3/4 rounded-md",
                  mode === "light" ? "bg-ink/[0.08]" : "bg-white/15",
                )}
              />
              <div
                className={cn(
                  "h-2.5 w-1/2 rounded-md",
                  mode === "light" ? "bg-ink/[0.06]" : "bg-white/10",
                )}
              />
            </div>
            <div className="mt-3 space-y-1.5">
              <div
                className={cn(
                  "rounded-md px-2 py-1.5 text-[11px] font-mono",
                  mode === "light"
                    ? "bg-brand-subtle/40 text-brand-accent"
                    : "bg-brand-accent/15 text-blue-300",
                )}
              >
                Hi {`{{customer_first_name}}`}!
              </div>
              <div
                className={cn(
                  "rounded-md px-2 py-1.5 text-[11px] font-mono",
                  mode === "light"
                    ? "bg-surface-inset text-ink"
                    : "bg-white/5 text-slate-200",
                )}
              >
                Your {`{{service_name}}`} is on {`{{appointment_date}}`} at {`{{appointment_time}}`}.
              </div>
              <div
                className={cn(
                  "rounded-md px-2 py-1.5 text-[11px] font-mono",
                  mode === "light"
                    ? "bg-surface-inset text-ink"
                    : "bg-white/5 text-slate-200",
                )}
              >
                Reschedule: {`{{reschedule_link}}`}
              </div>
            </div>
            <div
              className={cn(
                "mt-3 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em]",
                mode === "light" ? "text-ink-subtle" : "text-slate-400",
              )}
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand-accent" />
              {mode === "light" ? "Light theme" : "Dark theme"} · visual reference only
            </div>
          </div>
        </div>
      </PremiumCard>
    </div>
  );
}

// ─── Phase 15B · Activity timeline ─────────────────────────────────

function ActivityTimelineSection({ rows }: { rows: ActivityRow[] }) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <div>
      <SectionHead
        eyebrow="Live activity"
        title="Communication timeline"
        hint="The most recent 10 outbound events across every channel — full history is at the Delivery logs."
      />
      <PremiumCard className="relative mt-3 overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
        <ol className="relative space-y-2.5">
          <span
            aria-hidden
            className="pointer-events-none absolute left-[15px] top-1 bottom-1 w-px bg-gradient-to-b from-border via-border/60 to-transparent"
          />
          {rows.map((r) => {
            const Icon = EVENT_ICONS[r.eventType] ?? Mail;
            const label = EVENT_LABELS[r.eventType] ?? r.eventType;
            const statusTone =
              r.status === "sent"
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
                : r.status === "failed"
                  ? "bg-rose-50 text-rose-700 ring-rose-200/40"
                  : "bg-surface-inset text-ink-subtle ring-border/40";
            const iconTone =
              r.status === "sent"
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
                : r.status === "failed"
                  ? "bg-rose-50 text-rose-700 ring-rose-200/40"
                  : "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15";
            return (
              <li key={r.id} className="relative flex items-start gap-3 pl-0">
                <span
                  className={cn(
                    "relative z-10 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-2 ring-surface",
                    iconTone,
                  )}
                >
                  <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1 pb-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-[12.5px] font-semibold tracking-tight text-ink">{label}</span>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ring-1",
                        statusTone,
                      )}
                    >
                      {r.status}
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                      {relativeTime(r.createdAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-muted">
                    {r.channel}
                    {r.provider ? ` · via ${r.provider}` : ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
        <div className="mt-3 flex items-center justify-end">
          <Link
            href="/dashboard/settings/communications/logs"
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-accent hover:underline"
          >
            View full delivery log
            <ArrowUpRight className="h-3 w-3" strokeWidth={2.25} />
          </Link>
        </div>
      </PremiumCard>
    </div>
  );
}
