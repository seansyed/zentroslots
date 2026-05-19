/**
 * Governance closed unions + safe defaults.
 *
 * Adding a new retention target requires adding it to RETENTION_TARGETS
 * AND to the retention engine's per-target SQL switch. The closed
 * union surfaces missing handlers at compile time.
 *
 * Defaults match the platform's CURRENT behavior:
 *   - All retention windows null = retain forever (no pruning today)
 *   - password_min_length = 10 (already enforced in reset-password)
 *   - session_max_age_days = 0 = use platform default (7 days)
 *
 * Hard floors (enforced in code, NOT in schema) for compliance:
 *   - audit_logs: at least 90 days even if a tenant sets less
 *   - export_audit_events: at least 90 days
 */

export const RETENTION_TARGETS = [
  "audit_logs",
  "session_audit_events",
  "password_reset_tokens",
  "analytics_daily_snapshots",
  "export_audit_events",
] as const;
export type RetentionTarget = (typeof RETENTION_TARGETS)[number];

export const SUSPICIOUS_SENSITIVITY = ["low", "medium", "high"] as const;
export type SuspiciousSensitivity = (typeof SUSPICIOUS_SENSITIVITY)[number];

export const EXPORT_TYPES = [
  "analytics",
  "analytics_executive",
  "bookings",
  "scheduled_reports",
  "audit_logs",
  "other",
] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

/** Hard floor (days) per retention target. The tenant CAN set a lower
 *  retention window, but the engine will not prune any row newer than
 *  this floor — compliance-grade records (audit, export audit) are
 *  protected against accidental short-retention configs.
 *
 *  Null = no hard floor (analytics, sessions, reset tokens may be
 *  pruned aggressively if a tenant chooses).
 */
export const HARD_FLOOR_DAYS: Record<RetentionTarget, number | null> = {
  audit_logs: 90,
  session_audit_events: null,
  password_reset_tokens: null,
  analytics_daily_snapshots: null,
  export_audit_events: 90,
};

/** Platform-wide safe defaults. The engine uses these when a tenant
 *  has NO row in tenant_governance_settings (most tenants today). */
export const PLATFORM_DEFAULTS = {
  passwordMinLength: 10,
  passwordRequireUppercase: false,
  passwordRequireLowercase: false,
  passwordRequireDigit: false,
  passwordRequireSymbol: false,
  passwordMaxAgeDays: 0,
  sessionMaxAgeDays: 0,
  suspiciousLoginSensitivity: "medium" as SuspiciousSensitivity,
  restrictExports: false,
  requireAutomationApproval: false,
} as const;

/** Effective policy returned by loadEffectivePolicy(). Distinct from
 *  the DB row shape so callers don't have to worry about null vs
 *  default vs platform-default. */
export type EffectiveGovernancePolicy = {
  tenantId: string;
  retention: {
    auditLogs: number | null;
    sessionEvents: number | null;
    resetTokens: number | null;
    analytics: number | null;
    exportAudit: number | null;
  };
  password: {
    minLength: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireDigit: boolean;
    requireSymbol: boolean;
    maxAgeDays: number;
  };
  session: {
    maxAgeDays: number;
    suspiciousLoginSensitivity: SuspiciousSensitivity;
  };
  exports: {
    restrict: boolean;
    maxRows: number | null;
  };
  automation: {
    requireApproval: boolean;
  };
  allowedLoginIps: string[] | null;
  /** True when this tenant has a row in tenant_governance_settings.
   *  False = entirely default policy (current platform behavior). */
  hasCustomPolicy: boolean;
};
