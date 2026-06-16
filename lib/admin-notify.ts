/**
 * Phase 3 — Central admin / operational notification service.
 *
 * Single source of truth for routing platform-level critical events
 * to admin@zentromeet.com (and fallback inboxes). Every webhook
 * handler, cron worker, security heuristic, and fatal-error catch
 * goes THROUGH this module — direct `sendEmail()` calls for admin
 * alerts are a violation of the architecture.
 *
 * Why a dedicated service (vs. ad-hoc sendEmail calls)?
 *
 *   1. **Rate limiting + dedupe.** A flapping Stripe webhook or a
 *      misconfigured SMTP credential should NOT send 200 identical
 *      alerts to admin@. We bucket per (kind, dedupeKey) within a
 *      cooldown window and collapse the storm into 1 email.
 *
 *   2. **Severity tagging.** info / warning / critical determine the
 *      subject prefix and (in future) the routing — e.g. critical
 *      could PagerDuty later without rewriting every call site.
 *
 *   3. **Structured templates.** Every alert renders through one
 *      template with a fixed header (tenant, env, ts, summary) plus
 *      a free-form details block, so the recipient gets a uniform
 *      operational view regardless of which subsystem fired.
 *
 *   4. **Secret safety.** The renderer scrubs strings that look like
 *      tokens / API keys / Stripe secret-key prefixes — operational
 *      emails are auditable artifacts and must never leak secrets.
 *
 *   5. **Never throws.** Fire-and-forget. A failure in the admin
 *      alerter MUST NOT bring down a Stripe webhook or a booking
 *      POST. We log structured failures to stdout so a log
 *      aggregator can surface them, but we always return.
 *
 * IMPORTANT: this module sends EMAIL ONLY. It does not write to
 * the in-app `notifications` table (that's lib/notify.ts, a
 * tenant-scoped surface). Admin alerts are platform-level, with
 * no tenantId tie-in unless the caller passes one as context.
 */

import { sendEmail as defaultSendEmail } from "@/lib/email";

// ── Test-injectable email sender ─────────────────────────────────────
// ESM exports are read-only, so we route the email call through a
// module-local variable that tests can swap. Production code path is
// unchanged: by default this is the real sendEmail from lib/email.
type SendArgs = Parameters<typeof defaultSendEmail>[0];
type SendResult = Awaited<ReturnType<typeof defaultSendEmail>>;
let _sender: (args: SendArgs) => Promise<SendResult> = defaultSendEmail;

/** Test-only: swap the email sender. Returns the previous sender so
 *  tests can restore after. Do NOT call from production code. */
export function __setEmailSenderForTests(
  fn: (args: SendArgs) => Promise<SendResult>,
): (args: SendArgs) => Promise<SendResult> {
  const prev = _sender;
  _sender = fn;
  return prev;
}

// ─── Public types ───────────────────────────────────────────────────

/** All recognised admin alert kinds. Closed enum — typos at call
 *  sites are caught at compile time. Adding a new kind:
 *    1. Add to this union.
 *    2. Add an entry in DEFAULT_COOLDOWN_MS if non-default.
 *    3. Document in docs/ADMIN_NOTIFICATIONS.md. */
export type AdminAlertKind =
  // Billing / subscription lifecycle
  | "new_tenant_signup"
  | "new_subscription"
  | "trial_started"
  | "trial_expired"
  | "subscription_cancelled"
  | "plan_upgrade"
  | "plan_downgrade"
  | "payment_failed"
  | "subscription_reconcile_drift"   // DB tenant subscription drifted from Stripe
  // Webhook / integration plane
  | "stripe_webhook_error"
  | "oauth_provider_error"
  | "domain_verification_failed"
  | "email_provider_error"
  // Tenant lifecycle
  | "tenant_suspended"
  | "tenant_reactivated"
  // Operational health
  | "booking_volume_spike"
  | "queue_failure"
  | "reminder_delivery_failure"
  | "worker_crash"
  | "payment_hold_backlog"   // SA-Stab: pending_payment bookings overdue
  | "cron_missed_run"        // SA-Stab: cron not heard from in expected window
  // Security
  | "repeated_login_failures"
  | "fatal_exception";

export type AdminAlertSeverity = "info" | "warning" | "critical";

export type AdminAlertResult = {
  /** Dispatched to ≥1 inbox successfully. */
  ok: boolean;
  /** True when the alert was suppressed by the dedupe / cooldown
   *  layer. Not a failure — the alert *would* have gone out but a
   *  recent identical one already did. */
  throttled?: boolean;
  /** Inbox the alert was sent to (highest-priority resolved). */
  to?: string | null;
  /** Categorized failure reason (matches lib/email.ts categories). */
  reason?: string;
};

export type AdminAlertArgs = {
  kind: AdminAlertKind;
  severity: AdminAlertSeverity;
  /** One-line subject summary. Will be prefixed with severity + env. */
  summary: string;
  /** Multi-line details block. Pre-formatted; preserves newlines. */
  details?: string;
  /** Optional tenant context — appears in the email header and
   *  feeds the dedupe key so a noisy tenant doesn't suppress
   *  alerts from other tenants. */
  tenantId?: string | null;
  /** Optional human label for the tenant (slug, name) for the
   *  email header. Never substitute for tenantId in dedupe. */
  tenantLabel?: string | null;
  /** Structured key/value pairs surfaced in the email as a small
   *  facts table. Common keys: provider, eventId, errorCategory.
   *  Values are STRINGIFIED + SCRUBBED for secrets before rendering. */
  metadata?: Record<string, unknown>;
  /** Custom dedupe key. When omitted we synthesize one from
   *  (kind, tenantId, summary slug). Override when the caller knows
   *  a finer-grained key (e.g. stripe eventId, booking id). */
  dedupeKey?: string;
};

// ─── Inbox resolution ───────────────────────────────────────────────

/** Resolves the admin inbox via env var cascade.
 *    1. ADMIN_EMAIL          — primary operational inbox
 *    2. OPERATIONS_EMAIL     — secondary
 *    3. SUPPORT_EMAIL        — falls back to support if ops not set
 *    4. EMAIL_FROM           — last-resort so a misconfigured deploy
 *                              still surfaces *somewhere* reachable
 *  Returns null only when ALL four are unset (dev / stub).
 */
export function resolveAdminInbox(): string | null {
  return (
    process.env.ADMIN_EMAIL ??
    process.env.OPERATIONS_EMAIL ??
    process.env.SUPPORT_EMAIL ??
    process.env.EMAIL_FROM ??
    null
  );
}

// ─── Cooldown / dedupe ──────────────────────────────────────────────

/** Per-kind cooldown windows. Loud kinds (failed payments, webhook
 *  errors) get longer windows to prevent floods. Catastrophic kinds
 *  (worker_crash, fatal_exception) get shorter windows since each
 *  occurrence is signal. Tunable via env var `ADMIN_ALERT_COOLDOWN_MS`
 *  for the global default. */
const DEFAULT_COOLDOWN_MS = Number(
  process.env.ADMIN_ALERT_COOLDOWN_MS ?? 15 * 60_000,
);

const PER_KIND_COOLDOWN_MS: Partial<Record<AdminAlertKind, number>> = {
  // Loud but rate-limited so we get hourly digests, not floods.
  payment_failed: 60 * 60_000,
  // Chronic subscription drift should surface hourly, not every cron tick.
  subscription_reconcile_drift: 60 * 60_000,
  stripe_webhook_error: 30 * 60_000,
  email_provider_error: 30 * 60_000,
  reminder_delivery_failure: 30 * 60_000,
  // Spikes: 1h window is enough to observe trend without re-spamming.
  booking_volume_spike: 60 * 60_000,
  // Crashes / fatal: 5 min — short enough to see flapping, long
  // enough to not amplify a tight-loop error storm.
  worker_crash: 5 * 60_000,
  fatal_exception: 5 * 60_000,
  queue_failure: 5 * 60_000,
  // Repeated logins: 1h — admin doesn't need per-attempt alerts.
  repeated_login_failures: 60 * 60_000,
  // Stab wave — backlog / missed cron alerts get hourly windows so
  // a chronic infra issue surfaces once an hour, not every tick.
  payment_hold_backlog: 60 * 60_000,
  cron_missed_run: 60 * 60_000,
  // Lifecycle events: 1 minute. These are usually 1x events but
  // protect against duplicate webhooks etc.
  new_tenant_signup: 60_000,
  new_subscription: 60_000,
  subscription_cancelled: 60_000,
  plan_upgrade: 60_000,
  plan_downgrade: 60_000,
  trial_started: 60_000,
  trial_expired: 60_000,
  tenant_suspended: 60_000,
  tenant_reactivated: 60_000,
  oauth_provider_error: 30 * 60_000,
  domain_verification_failed: 60 * 60_000,
};

/** In-process dedupe ledger. Key = dedupe key, Value = lastSentAt ms.
 *  Single-process scope by design: scheduling-saas runs as a single
 *  PM2 fork-mode worker today. If we move to cluster / multi-instance,
 *  this ledger should migrate to Redis or a Postgres advisory lock —
 *  see docs/ADMIN_NOTIFICATIONS.md. */
const recentDispatch = new Map<string, number>();

function shouldThrottle(kind: AdminAlertKind, dedupeKey: string): boolean {
  const cooldown = PER_KIND_COOLDOWN_MS[kind] ?? DEFAULT_COOLDOWN_MS;
  const last = recentDispatch.get(dedupeKey);
  if (last === undefined) return false;
  return Date.now() - last < cooldown;
}

function recordDispatch(dedupeKey: string): void {
  recentDispatch.set(dedupeKey, Date.now());
  // Bound ledger size so a long-running process doesn't OOM from
  // alert key accumulation. 1000 keys * ~100 bytes = 100 kB max.
  if (recentDispatch.size > 1000) {
    const oldest = [...recentDispatch.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, 200);
    for (const [k] of oldest) recentDispatch.delete(k);
  }
}

function defaultDedupeKey(args: AdminAlertArgs): string {
  const tenant = args.tenantId ?? "platform";
  // Normalise summary to a short slug so a unique-message-per-tick
  // (e.g. timestamps in the summary) doesn't defeat dedupe.
  const slug = args.summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 80);
  return `${args.kind}::${tenant}::${slug}`;
}

// ─── Secret scrubbing ──────────────────────────────────────────────

/** Patterns that look like secrets we DO NOT want in operational
 *  emails. The list is conservative; if a value matches any of these
 *  it's redacted as `[REDACTED]` before rendering into the email
 *  body. Detection is best-effort — call sites MUST still avoid
 *  passing raw secrets in metadata. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk_live_|sk_test_|rk_live_|rk_test_)[A-Za-z0-9_]{16,}\b/g, // Stripe
  /\bre_[A-Za-z0-9]{16,}\b/g, // Resend
  /\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\b/g, // SendGrid
  /\bA[A-Z0-9]{16,}\b/g, // AWS access key id (loose — could collide w/ booking IDs, but those are UUIDs)
  /\bgho_[A-Za-z0-9]{30,}\b/g, // GitHub OAuth
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT (header.payload.signature)
];

function scrub(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

function safeStringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return scrub(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return scrub(JSON.stringify(v));
  } catch {
    return "[unserializable]";
  }
}

// ─── Template ──────────────────────────────────────────────────────

const SEV_PREFIX: Record<AdminAlertSeverity, string> = {
  info: "ℹ️",
  warning: "⚠️",
  critical: "🚨",
};

function renderAlert(args: AdminAlertArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const env = process.env.NODE_ENV ?? "production";
  const brand = process.env.BRAND_NAME ?? "ZentroMeet";
  const ts = new Date().toISOString();
  const sevTag = args.severity.toUpperCase();
  const subject = `${SEV_PREFIX[args.severity]} [${sevTag}] ${brand}: ${scrub(args.summary)}`;

  // Facts block — uniform header for every alert. Aggregators that
  // parse subject lines can also grep these lines reliably.
  const facts: Array<[string, string]> = [
    ["Severity", sevTag],
    ["Kind", args.kind],
    ["Env", env],
    ["Time", ts],
  ];
  if (args.tenantId) facts.push(["Tenant ID", args.tenantId]);
  if (args.tenantLabel) facts.push(["Tenant", args.tenantLabel]);
  if (args.metadata) {
    for (const [k, v] of Object.entries(args.metadata)) {
      const stringified = safeStringify(v);
      if (stringified === "") continue;
      facts.push([k, stringified.slice(0, 500)]);
    }
  }

  const factsText = facts.map(([k, v]) => `${k}: ${v}`).join("\n");
  const factsHtml = facts
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#64748b;font-size:13px;vertical-align:top;white-space:nowrap">${escapeHtml(
          k,
        )}</td><td style="padding:4px 0;font-size:13px;font-family:ui-monospace,Menlo,Consolas,monospace;color:#0f172a;word-break:break-word">${escapeHtml(
          v,
        )}</td></tr>`,
    )
    .join("");

  const detailsScrub = args.details ? scrub(args.details) : "";

  const text = [
    `[${sevTag}] ${scrub(args.summary)}`,
    "",
    factsText,
    detailsScrub ? "\n— Details —\n" + detailsScrub : "",
  ]
    .filter(Boolean)
    .join("\n");

  const html = `<!doctype html><html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;padding:24px"><div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden"><div style="padding:20px 24px;border-bottom:1px solid #e2e8f0;background:${
    args.severity === "critical"
      ? "#fef2f2"
      : args.severity === "warning"
      ? "#fffbeb"
      : "#f0f9ff"
  }"><div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:${
    args.severity === "critical"
      ? "#dc2626"
      : args.severity === "warning"
      ? "#d97706"
      : "#2563eb"
  }">${SEV_PREFIX[args.severity]} ${sevTag}</div><div style="font-size:17px;font-weight:600;color:#0f172a;margin-top:4px">${escapeHtml(
    scrub(args.summary),
  )}</div></div><div style="padding:20px 24px"><table style="border-collapse:collapse;width:100%">${factsHtml}</table>${
    detailsScrub
      ? `<div style="margin-top:20px;padding-top:20px;border-top:1px solid #e2e8f0"><div style="font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Details</div><pre style="margin:0;padding:12px;background:#f1f5f9;border-radius:6px;font-size:12px;line-height:1.5;color:#0f172a;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(
          detailsScrub,
        )}</pre></div>`
      : ""
  }</div><div style="padding:12px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8">Automated operational alert from ${escapeHtml(
    brand,
  )}. Do not reply.</div></div></body></html>`;

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Public dispatch ───────────────────────────────────────────────

/**
 * Dispatch an operational alert to the resolved admin inbox.
 *
 * Never throws. Returns a structured result for the caller to log.
 * The caller MUST NOT block on this — treat it as fire-and-forget:
 *
 *   void adminNotify({ kind: "payment_failed", ... });
 *
 * Or await only inside a try/catch that won't propagate.
 */
export async function adminNotify(args: AdminAlertArgs): Promise<AdminAlertResult> {
  const inbox = resolveAdminInbox();
  const dedupeKey = args.dedupeKey ?? defaultDedupeKey(args);

  // ── 1. Cooldown / dedupe ──────────────────────────────────────
  if (shouldThrottle(args.kind, dedupeKey)) {
    // Structured log so we can observe throttle behavior, but no
    // email goes out.
    try {
      console.warn(
        JSON.stringify({
          evt: "admin_notify_throttled",
          kind: args.kind,
          severity: args.severity,
          ts: new Date().toISOString(),
          dedupe_key: dedupeKey,
        }),
      );
    } catch {
      // Logging itself must never throw.
    }
    return { ok: false, throttled: true, to: inbox };
  }

  // ── 2. Inbox configured? ──────────────────────────────────────
  if (!inbox) {
    try {
      console.error(
        JSON.stringify({
          evt: "admin_notify_no_inbox",
          kind: args.kind,
          severity: args.severity,
          ts: new Date().toISOString(),
        }),
      );
    } catch {}
    return { ok: false, reason: "no_inbox_configured", to: null };
  }

  // ── 3. Render + dispatch ──────────────────────────────────────
  const { subject, text, html } = renderAlert(args);
  let result: AdminAlertResult;
  try {
    const r = await _sender({ to: inbox, subject, text, html });
    result = { ok: r.ok, to: inbox, reason: r.ok ? undefined : r.reason };
  } catch (err) {
    // sendEmail() is supposed to swallow its own errors, but belt-
    // and-braces: this whole function MUST NOT throw under any
    // circumstance — callers depend on that.
    const msg = err instanceof Error ? err.message : "unknown";
    result = { ok: false, to: inbox, reason: `dispatch_exception: ${msg.slice(0, 200)}` };
  }

  // ── 4. Record dispatch for dedupe even on failure ─────────────
  // Rationale: if SMTP is down, we don't want to retry the same
  // alert every minute. Record + back off until the cooldown lapses.
  recordDispatch(dedupeKey);

  // ── 5. Structured log ─────────────────────────────────────────
  try {
    console.log(
      JSON.stringify({
        evt: result.ok ? "admin_notify_sent" : "admin_notify_failed",
        kind: args.kind,
        severity: args.severity,
        ts: new Date().toISOString(),
        to_domain: inbox.split("@")[1] ?? "?",
        reason: result.reason,
      }),
    );
  } catch {}

  return result;
}

/** Test-only helper. Clears the in-process dedupe ledger so unit
 *  tests can assert dispatch behavior without cross-test bleed. */
export function __resetAdminNotifyForTests(): void {
  recentDispatch.clear();
}
