/**
 * Activity Mission Control — client-safe shared constants.
 *
 * Pure data (no db/client imports) — safe to import from both server
 * and "use client" components. Kept separate from
 * activity-mission-control.ts which transitively imports db/client.
 */

export type ActivityPreset = {
  id: string;
  label: string;
  /** Activity kinds to filter by. Empty = all kinds. */
  kinds: string[];
  severity: "" | "info" | "warning" | "critical";
  tone: "neutral" | "warning" | "critical" | "primary";
  /** Lucide icon name — UI maps to the icon component. */
  icon: "shield" | "key" | "zap" | "bell" | "credit-card" | "activity";
};

export const ACTIVITY_PRESETS: ActivityPreset[] = [
  {
    id: "all",
    label: "All activity",
    kinds: [],
    severity: "",
    tone: "neutral",
    icon: "activity",
  },
  {
    id: "critical",
    label: "Critical only",
    kinds: [],
    severity: "critical",
    tone: "critical",
    icon: "zap",
  },
  {
    id: "security",
    label: "Security incidents",
    kinds: ["login_failure", "suspicious_activity", "impersonation_started", "bulk_admin_action"],
    severity: "",
    tone: "critical",
    icon: "shield",
  },
  {
    id: "oauth",
    label: "OAuth issues",
    kinds: ["oauth_failed", "oauth_token_expired", "calendar_sync_failed"],
    severity: "",
    tone: "warning",
    icon: "key",
  },
  {
    id: "billing",
    label: "Billing failures",
    kinds: ["payment_failed", "subscription_cancelled", "webhook_failed"],
    severity: "",
    tone: "warning",
    icon: "credit-card",
  },
  {
    id: "deliverability",
    label: "Delivery failures",
    kinds: ["reminder_failed", "ses_bounce", "sms_failure", "webhook_failed"],
    severity: "",
    tone: "warning",
    icon: "bell",
  },
];

export type ActivityCategory =
  | "security"
  | "billing"
  | "infrastructure"
  | "auth"
  | "tenant"
  | "info";

export const KIND_CATEGORY: Record<string, ActivityCategory> = {
  // Security
  login_failure: "auth",
  suspicious_activity: "security",
  impersonation_started: "security",
  bulk_admin_action: "security",
  // OAuth / infrastructure
  oauth_connected: "infrastructure",
  oauth_failed: "infrastructure",
  oauth_token_expired: "infrastructure",
  calendar_sync_failed: "infrastructure",
  webhook_failed: "infrastructure",
  webhook_recovered: "infrastructure",
  cron_failure: "infrastructure",
  queue_spike: "infrastructure",
  reminder_failed: "infrastructure",
  ses_bounce: "infrastructure",
  sms_failure: "infrastructure",
  // Billing
  subscription_created: "billing",
  subscription_upgraded: "billing",
  subscription_downgraded: "billing",
  subscription_cancelled: "billing",
  payment_failed: "billing",
  invoice_paid: "billing",
  // Tenant lifecycle
  new_signup: "tenant",
  tenant_suspended: "tenant",
  tenant_reactivated: "tenant",
  custom_domain_connected: "tenant",
};

export type ActivityStreamHealth = "calm" | "active" | "elevated" | "incident";

/** Pure types — server returns these shapes via /api/admin/activity/mission. */
export type ActivityMissionKpis = {
  activeIncidents24h: number;
  warnings24h: number;
  authFailures24h: number;
  oauthFailures24h: number;
  webhookFailures24h: number;
  impersonations24h: number;
  billingFailures24h: number;
  eventsLastHour: number;
  baselineEventsPerHour: number;
  anomalyScore: number | null;
  streamHealth: ActivityStreamHealth;
  throughput12h: number[];
  severityPulse12h: number[];
  generatedAt: string;
  computedInMs: number;
};
