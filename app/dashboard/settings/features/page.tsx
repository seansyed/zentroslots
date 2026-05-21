import { redirect } from "next/navigation";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  calendarConnections,
  tenantDomains,
  tenantFeatureSettings,
  tenants,
  users,
} from "@/db/schema";
import { getSession } from "@/lib/auth";
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAGS,
  FEATURE_FLAG_META,
  type FeatureFlag,
  mergeFlags,
} from "@/lib/features";
import { getPlan } from "@/lib/plans";
import {
  isProviderEnabled,
  readEnabledIntegrations,
} from "@/lib/integrations";
import Shell from "@/components/dashboard/Shell";
import FeatureControlsClient, {
  type FeatureSectionDef,
  type SystemHealthSnapshot,
  type ExternalPolicyRef,
  type FlagAuditEntry,
  type OperationalHealthItem,
  type DependencyWarning,
} from "@/components/dashboard/FeatureControlsClient";

export const metadata = { title: "Feature controls" };
export const dynamic = "force-dynamic";

export default async function FeatureControlsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  // Admin-only — managers don't have the keys to the workspace switches.
  if (!user || user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  // ── Flags ────────────────────────────────────────────────────────────
  const row = await db.query.tenantFeatureSettings.findFirst({
    where: eq(tenantFeatureSettings.tenantId, tenant.id),
  });
  const initial = mergeFlags(row?.flags);

  // ── Live workspace counters ──────────────────────────────────────────
  const [calActiveRows, calErrorRows, domainCountRows] = await Promise.all([
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.tenantId, tenant.id),
          eq(calendarConnections.status, "active"),
        ),
      ),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.tenantId, tenant.id),
          isNotNull(calendarConnections.lastError),
        ),
      ),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(tenantDomains)
      .where(eq(tenantDomains.tenantId, tenant.id)),
  ]);

  const plan = getPlan(tenant.currentPlan);
  const integrations = readEnabledIntegrations(tenant.enabledIntegrations);
  const googleProviderEnabled = isProviderEnabled(integrations, "google_calendar");
  const smtpReady = Boolean(process.env.SMTP_HOST && process.env.SMTP_HOST.length > 0);
  const webhookUrlSet = Boolean(
    tenant.notificationWebhookUrl && tenant.notificationWebhookUrl.length > 0,
  );

  const systemHealth: SystemHealthSnapshot = {
    smtpReady,
    googleCalendarConnections: calActiveRows[0]?.c ?? 0,
    googleCalendarErrors: calErrorRows[0]?.c ?? 0,
    googleProviderEnabled,
    customDomainsCount: domainCountRows[0]?.c ?? 0,
    webhookConfigured: webhookUrlSet,
    hidePoweredBy: tenant.hidePoweredBy,
    workspaceActive: tenant.active,
  };

  // ── Audit history per flag ──────────────────────────────────────────
  // We pull the most recent 100 feature.update events for the tenant and
  // walk them oldest→newest in reverse to find the most recent actor +
  // timestamp per flag. The metadata.changed object is keyed by flag name.
  // Reads only — no joins — so this is cheap.
  const auditRows = await db
    .select({
      actorUserId: auditLogs.actorUserId,
      actorLabel: auditLogs.actorLabel,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
      ipAddress: auditLogs.ipAddress,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.tenantId, tenant.id),
        eq(auditLogs.action, "feature.update"),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(100);

  // Collect actor user IDs for a single lookup (avoids N queries when
  // multiple flags trace back to the same admin).
  const actorIds = Array.from(
    new Set(auditRows.map((r) => r.actorUserId).filter((x): x is string => Boolean(x))),
  );
  const actorMap = new Map<string, { name: string; email: string }>();
  if (actorIds.length > 0) {
    const actorRows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, actorIds));
    for (const a of actorRows) actorMap.set(a.id, { name: a.name, email: a.email });
  }

  const flagAudit: Partial<Record<FeatureFlag, FlagAuditEntry>> = {};
  // Rows already DESC; first hit wins per flag.
  for (const ev of auditRows) {
    const meta = (ev.metadata as { changed?: Record<string, unknown> }) ?? {};
    const changed = meta.changed ?? {};
    for (const k of FEATURE_FLAGS) {
      if (flagAudit[k]) continue;
      if (k in changed) {
        const actor = ev.actorUserId ? actorMap.get(ev.actorUserId) : undefined;
        flagAudit[k] = {
          actorName: actor?.name ?? ev.actorLabel ?? null,
          actorEmail: actor?.email ?? null,
          at: ev.createdAt.toISOString(),
          source: "audit_logs:feature.update",
        };
      }
    }
  }

  // ── Operational health strip ────────────────────────────────────────
  // Every signal here is derived from REAL backend state. No hard-coded
  // "all systems normal" — if a prereq is missing we surface it.
  const opHealth: OperationalHealthItem[] = [
    {
      id: "booking-engine",
      label: "Booking engine",
      // The page rendered → the Next.js server + DB pool are healthy.
      status: "ok",
      detail: "Slot computation + booking writes operational.",
    },
    {
      id: "reminder-engine",
      label: "Reminder engine",
      status: !smtpReady
        ? "down"
        : !initial.emailNotifications || !initial.reminders
          ? "degraded"
          : "ok",
      detail: !smtpReady
        ? "SMTP is not configured — reminders cannot deliver."
        : !initial.emailNotifications
          ? "Email notifications are disabled by policy — reminders will not send."
          : !initial.reminders
            ? "Reminders disabled by policy — cron will skip booked appointments."
            : "Reminder cron is wired and SMTP is ready.",
    },
    {
      id: "smtp",
      label: "SMTP transport",
      status: smtpReady ? "ok" : "down",
      detail: smtpReady
        ? `Configured provider: ${process.env.SMTP_HOST ?? "unknown"}.`
        : "SMTP_HOST env var is not set on this instance.",
    },
    {
      id: "calendar-oauth",
      label: "Calendar OAuth",
      status: !googleProviderEnabled
        ? "down"
        : systemHealth.googleCalendarErrors > 0
          ? "degraded"
          : systemHealth.googleCalendarConnections > 0
            ? "ok"
            : "muted",
      detail: !googleProviderEnabled
        ? "Google Calendar provider disabled at the workspace level."
        : systemHealth.googleCalendarErrors > 0
          ? `${systemHealth.googleCalendarErrors} connection${
              systemHealth.googleCalendarErrors === 1 ? "" : "s"
            } reporting OAuth errors — reconnect required.`
          : systemHealth.googleCalendarConnections > 0
            ? `${systemHealth.googleCalendarConnections} active connection${
                systemHealth.googleCalendarConnections === 1 ? "" : "s"
              }.`
            : "Provider enabled, no staff connected yet.",
    },
    {
      id: "webhook-delivery",
      label: "Webhook delivery",
      status: !webhookUrlSet
        ? "muted"
        : !initial.webhookDelivery
          ? "degraded"
          : "ok",
      detail: !webhookUrlSet
        ? "No webhook URL set — events are not dispatched."
        : !initial.webhookDelivery
          ? "Webhook URL configured but delivery is disabled by policy."
          : "Direct POST dispatch on every booking lifecycle event.",
    },
  ];

  // ── Dependency warnings ─────────────────────────────────────────────
  // Per-flag amber callouts when the toggle is ON but a real-world
  // prerequisite is missing. Every warning is derived from observable
  // backend state — never invented.
  const dependencyWarnings: DependencyWarning[] = [];
  if (initial.emailNotifications && !smtpReady) {
    dependencyWarnings.push({
      flag: "emailNotifications",
      tone: "warning",
      message:
        "SMTP is not configured. With this toggle on, sends will be attempted and fail at the transport layer.",
      manageHref: "/dashboard/settings/communications",
      manageLabel: "Review SMTP configuration",
    });
  }
  if (initial.reminders && (!smtpReady || !initial.emailNotifications)) {
    dependencyWarnings.push({
      flag: "reminders",
      tone: "warning",
      message: !smtpReady
        ? "Reminders are enabled, but SMTP is not configured — none will deliver."
        : "Reminders are enabled, but email notifications are disabled at the workspace level — none will deliver.",
      manageHref: !smtpReady
        ? "/dashboard/settings/communications"
        : "/dashboard/settings/features",
      manageLabel: !smtpReady ? "Review SMTP configuration" : "Re-enable email notifications",
    });
  }
  if (initial.webhookDelivery && !webhookUrlSet) {
    dependencyWarnings.push({
      flag: "webhookDelivery",
      tone: "warning",
      message: "Webhook delivery is enabled, but no notification URL is configured. No events are being delivered.",
      manageHref: "/dashboard/settings/notifications",
      manageLabel: "Set a webhook URL",
    });
  }
  if (initial.googleMeet && !googleProviderEnabled) {
    dependencyWarnings.push({
      flag: "googleMeet",
      tone: "warning",
      message:
        "Google Meet auto-links are enabled, but the Google Calendar provider is disabled at the workspace level. No Meet links will be created.",
      manageHref: "/dashboard/settings/integrations",
      manageLabel: "Enable Google in integrations",
    });
  }
  if (
    initial.googleMeet &&
    googleProviderEnabled &&
    systemHealth.googleCalendarConnections === 0
  ) {
    dependencyWarnings.push({
      flag: "googleMeet",
      tone: "info",
      message:
        "Google Meet auto-links are enabled. They activate the moment a staff member connects a Google account.",
      manageHref: "/dashboard/settings/calendar",
      manageLabel: "Connect a calendar",
    });
  }

  // ── 4-section command center layout ──────────────────────────────────
  const sections: FeatureSectionDef[] = [
    {
      id: "booking",
      title: "Booking Experience",
      summary:
        "What customers can do once they reach your booking flow — intake, reschedule, cancel.",
      keys: ["intakeForms", "rescheduling", "cancellations"],
    },
    {
      id: "automation",
      title: "Automation",
      summary:
        "Outbound messaging your workspace triggers automatically — reminders, transactional email, operational webhooks.",
      keys: ["emailNotifications", "reminders", "webhookDelivery"],
    },
    {
      id: "scheduling",
      title: "Scheduling Infrastructure",
      summary:
        "How the engine builds availability and attaches meeting links. Some safeguards are core to the platform and run continuously.",
      keys: ["bookingBuffers", "googleMeet"],
    },
    {
      id: "branding",
      title: "Branding & White Label",
      summary:
        "Plan-gated workspace identity. Each capability links to its dedicated management page.",
      keys: [],
    },
  ];

  // ── External (read-only) policy references ───────────────────────────
  const externalRefs: ExternalPolicyRef[] = [
    // Automation refs ────────────────────────────────────────────────
    {
      sectionId: "automation",
      label: "SMTP delivery",
      detail: smtpReady
        ? "Outbound mail is live via the configured SMTP provider."
        : "SMTP is not configured. Email notifications will fail until a provider is set up.",
      status: smtpReady ? "active" : "disabled",
      planLocked: false,
      manageHref: "/dashboard/settings/communications",
      manageLabel: "Manage communications",
    },
    {
      sectionId: "automation",
      label: "Operational webhook URL",
      detail: webhookUrlSet
        ? "A notification URL is set. Booking events are delivered when the toggle above is on."
        : "No notification URL configured — set one to start receiving operational alerts.",
      status: webhookUrlSet ? "active" : "available",
      planLocked: false,
      manageHref: "/dashboard/settings/notifications",
      manageLabel: "Manage webhook URL",
    },
    // Scheduling Infrastructure refs ─────────────────────────────────
    {
      sectionId: "scheduling",
      label: "Calendar sync (Google)",
      detail: !googleProviderEnabled
        ? "Google Calendar is disabled at the workspace integrations level. Re-enable it before staff can connect."
        : systemHealth.googleCalendarConnections === 0
          ? "Google Calendar is enabled, but no staff member has connected an account yet."
          : `${systemHealth.googleCalendarConnections} active Google Calendar ${
              systemHealth.googleCalendarConnections === 1 ? "connection" : "connections"
            }. Busy events are honored in availability.`,
      status: googleProviderEnabled
        ? systemHealth.googleCalendarConnections > 0
          ? "active"
          : "available"
        : "disabled",
      planLocked: false,
      manageHref: "/dashboard/settings/integrations",
      manageLabel: "Manage integrations",
    },
    {
      sectionId: "scheduling",
      label: "Staff calendar connections",
      detail:
        systemHealth.googleCalendarConnections > 0
          ? "Each connected staff member contributes busy time to the availability engine in real time."
          : "Staff haven't connected calendars. Availability uses configured working hours only.",
      status: systemHealth.googleCalendarConnections > 0 ? "active" : "available",
      planLocked: false,
      manageHref: "/dashboard/settings/calendar",
      manageLabel: "Open calendar connections",
    },
    {
      sectionId: "scheduling",
      label: "Staff conflict detection",
      detail:
        "Core safety guarantee — the booking engine always rejects double-bookings against confirmed appointments and external busy time. Not a toggleable policy.",
      status: "always_on",
      planLocked: false,
      manageHref: "/dashboard/calendar",
      manageLabel: "Open calendar",
    },
    {
      sectionId: "scheduling",
      label: "Timezone detection",
      detail:
        "Public booking pages detect the visitor's browser timezone automatically and render slots in their local time. Always enabled.",
      status: "always_on",
      planLocked: false,
      manageHref: "/dashboard/settings/workspace-hours",
      manageLabel: "Manage workspace hours",
    },
    // Branding refs ──────────────────────────────────────────────────
    {
      sectionId: "branding",
      label: "Public booking page",
      detail: tenant.active
        ? `Live at /u/${tenant.slug}. Workspace status is active and customers can book.`
        : "Workspace is inactive. The public booking page returns 404 until reactivated.",
      status: tenant.active ? "active" : "disabled",
      planLocked: false,
      manageHref: `/u/${tenant.slug}`,
      manageLabel: "Open public page",
    },
    {
      sectionId: "branding",
      label: "Embed widget",
      detail: tenant.active
        ? "Inline + popup embed snippets are available. Page-level analytics track installations."
        : "Workspace is inactive. Embed widgets are paused until reactivated.",
      status: tenant.active ? "active" : "disabled",
      planLocked: false,
      manageHref: "/dashboard/settings/embed",
      manageLabel: "Open embed studio",
    },
    {
      sectionId: "branding",
      label: "Custom domains",
      detail:
        plan.limits.maxCustomDomains <= 0
          ? `The ${plan.name} plan does not include custom domains. Upgrade to connect a domain.`
          : systemHealth.customDomainsCount === 0
            ? `Your ${plan.name} plan includes ${plan.limits.maxCustomDomains} custom ${
                plan.limits.maxCustomDomains === 1 ? "domain" : "domains"
              }. None connected yet.`
            : `${systemHealth.customDomainsCount} of ${plan.limits.maxCustomDomains} custom ${
                plan.limits.maxCustomDomains === 1 ? "domain" : "domains"
              } in use.`,
      status:
        plan.limits.maxCustomDomains <= 0
          ? "plan_gated"
          : systemHealth.customDomainsCount > 0
            ? "active"
            : "available",
      planLocked: plan.limits.maxCustomDomains <= 0,
      manageHref: "/dashboard/settings/domain",
      manageLabel: plan.limits.maxCustomDomains <= 0 ? "Upgrade plan" : "Manage custom domains",
    },
    {
      sectionId: "branding",
      label: "Remove \"Powered by\"",
      detail: !plan.limits.customBranding
        ? `The ${plan.name} plan keeps the \"Powered by\" footer. Upgrade to a branding-enabled plan to remove it.`
        : tenant.hidePoweredBy
          ? "Powered-by footer is hidden on your public booking pages."
          : "Branding removal is available on your plan — toggle it on under workspace branding.",
      status: !plan.limits.customBranding
        ? "plan_gated"
        : tenant.hidePoweredBy
          ? "active"
          : "available",
      planLocked: !plan.limits.customBranding,
      manageHref: !plan.limits.customBranding ? "/pricing" : "/dashboard/settings/branding",
      manageLabel: !plan.limits.customBranding ? "Upgrade plan" : "Open branding settings",
    },
  ];

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Feature controls"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Feature controls" },
      ]}
    >
      <FeatureControlsClient
        initialFlags={initial}
        defaults={DEFAULT_FEATURE_FLAGS}
        meta={FEATURE_FLAG_META}
        keys={FEATURE_FLAGS as unknown as string[]}
        sections={sections}
        externalRefs={externalRefs}
        systemHealth={systemHealth}
        operationalHealth={opHealth}
        dependencyWarnings={dependencyWarnings}
        flagAudit={flagAudit as Record<string, FlagAuditEntry>}
        plan={{
          id: plan.id,
          name: plan.name,
          customBranding: plan.limits.customBranding,
          maxCustomDomains: plan.limits.maxCustomDomains,
        }}
      />
    </Shell>
  );
}
