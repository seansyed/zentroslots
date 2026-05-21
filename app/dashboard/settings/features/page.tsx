import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
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

  // ── Live system health snapshot ──────────────────────────────────────
  // Every signal below comes from REAL backend state. The UI uses it
  // ONLY to render read-only health pills next to each toggle ("SMTP
  // ready", "1 Google calendar connected", etc.) — it never invents a
  // status, never green-lights a flag the runtime won't honor.
  const [calCount, domainCount] = await Promise.all([
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
      .from(tenantDomains)
      .where(eq(tenantDomains.tenantId, tenant.id)),
  ]);

  const plan = getPlan(tenant.currentPlan);
  const integrations = readEnabledIntegrations(tenant.enabledIntegrations);
  const googleProviderEnabled = isProviderEnabled(integrations, "google_calendar");
  const smtpReady = Boolean(process.env.SMTP_HOST && process.env.SMTP_HOST.length > 0);

  const systemHealth: SystemHealthSnapshot = {
    smtpReady,
    googleCalendarConnections: calCount[0]?.c ?? 0,
    googleProviderEnabled,
    customDomainsCount: domainCount[0]?.c ?? 0,
    webhookConfigured: Boolean(tenant.notificationWebhookUrl && tenant.notificationWebhookUrl.length > 0),
    hidePoweredBy: tenant.hidePoweredBy,
  };

  // ── 4-section command center layout ──────────────────────────────────
  // Each `keys` entry MUST already exist in lib/features.ts — the type
  // system enforces honesty. Adding a section without a backed flag is
  // a compile-time error.
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
      id: "calendar",
      title: "Calendar & Scheduling",
      summary:
        "How the scheduling engine builds availability and attaches video links to confirmed bookings.",
      keys: ["bookingBuffers", "googleMeet"],
    },
    {
      id: "branding",
      title: "Branding & White Label",
      summary:
        "Plan-gated workspace identity — custom domains and powered-by removal are managed on dedicated pages.",
      keys: [],
    },
  ];

  // ── External (read-only) policy references ───────────────────────────
  // These items are gated elsewhere — by plan limits, integration
  // toggles, or per-page settings. Rendering them here gives admins a
  // single map of the workspace's capability surface without
  // duplicating the toggle (and inviting drift).
  const externalRefs: ExternalPolicyRef[] = [
    {
      sectionId: "automation",
      label: "SMTP delivery",
      detail: systemHealth.smtpReady
        ? "Outbound mail is live via the configured SMTP provider."
        : "SMTP is not configured. Email notifications will fail until a provider is set up.",
      status: systemHealth.smtpReady ? "active" : "disabled",
      manageHref: "/dashboard/settings/communications",
      manageLabel: "Manage communications",
    },
    {
      sectionId: "automation",
      label: "Operational webhook URL",
      detail: systemHealth.webhookConfigured
        ? "A notification URL is set. Booking events are delivered when the toggle above is on."
        : "No notification URL configured — set one to start receiving operational alerts.",
      status: systemHealth.webhookConfigured ? "active" : "available",
      manageHref: "/dashboard/settings/notifications",
      manageLabel: "Manage webhook URL",
    },
    {
      sectionId: "calendar",
      label: "Google Calendar sync",
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
      manageHref: "/dashboard/settings/integrations",
      manageLabel: "Manage integrations",
    },
    {
      sectionId: "calendar",
      label: "Staff calendar connections",
      detail:
        systemHealth.googleCalendarConnections > 0
          ? "Each connected staff member contributes busy time to the availability engine in real time."
          : "Staff haven't connected calendars. Availability uses configured working hours only.",
      status: systemHealth.googleCalendarConnections > 0 ? "active" : "available",
      manageHref: "/dashboard/settings/calendar",
      manageLabel: "Open calendar connections",
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
      manageHref: "/dashboard/settings/domain",
      manageLabel: "Manage custom domains",
    },
    {
      sectionId: "branding",
      label: "Remove \"Powered by\"",
      detail: !plan.limits.customBranding
        ? `The ${plan.name} plan keeps the \"Powered by\" footer. Upgrade to a branding-enabled plan to remove it.`
        : systemHealth.hidePoweredBy
          ? "Powered-by footer is hidden on your public booking pages."
          : "Branding removal is available on your plan — toggle it on under workspace branding.",
      status: !plan.limits.customBranding
        ? "plan_gated"
        : systemHealth.hidePoweredBy
          ? "active"
          : "available",
      manageHref: "/dashboard/settings/branding",
      manageLabel: "Open branding settings",
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
