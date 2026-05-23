/**
 * Wave H — Payment routing activation state machine.
 *
 * Centralizes ALL logic for whether a tenant may flip
 * `tenants.use_tenant_payment_providers` to `true`. The flag itself is
 * unchanged (additive); this module is the ONLY place that decides what
 * "ready" means, so the UI checklist, the API endpoint, and any future
 * automation can never drift on the prereq definition.
 *
 * ── State machine ─────────────────────────────────────────────────────
 *
 *                     ┌──────────────────────┐
 *                     │ legacy_platform      │   default: flag=false
 *                     │ (booking → platform) │
 *                     └──────────┬───────────┘
 *                                │ admin POSTs enable=true
 *                                ▼
 *               re-evaluatePrerequisites(tenantId)
 *                ┌─────────────┴─────────────┐
 *                │ all 5 prereqs ok          │ any prereq missing
 *                ▼                           ▼
 *      ┌──────────────────────┐   ┌──────────────────────┐
 *      │ flag flipped → true  │   │ 409 — blocked,       │
 *      │ audit success        │   │ audit blocked attempt│
 *      │ routingMode =        │   │ flag stays false     │
 *      │   tenant_vault_active│   └──────────────────────┘
 *      └──────────┬───────────┘
 *                 │ admin POSTs enable=false
 *                 ▼
 *      ┌──────────────────────┐
 *      │ flag flipped → false │   ALWAYS allowed (kill-switch UX)
 *      │ audit success        │
 *      │ routingMode =        │
 *      │   legacy_platform    │
 *      └──────────────────────┘
 *
 * Kill-switch override (PHASE3_KILL_SWITCH env var): when active, the
 * route resolver in `tenantVaultBooking.ts` short-circuits to
 * `legacy_platform` regardless of the tenant flag. We surface this as
 * `routingMode: "kill_switch"` so the UI shows the operator-panic state
 * accurately. The tenant flag itself is NOT touched by the kill switch.
 *
 * Mode scope: activation always evaluates the LIVE-mode default
 * provider, because the booking POST always passes `mode: "live"`.
 * Tenants can have a TEST default for sandbox testing without affecting
 * activation eligibility.
 */

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantPaymentProviders, tenants } from "@/db/schema";

// ─── Kill-switch (mirrored from tenantVaultBooking.ts) ────────────────
//
// Re-evaluated on every call (NEVER memoized) so a hot env flip rolls
// back instantly. We don't import from tenantVaultBooking to avoid a
// dependency cycle — the constant is intentionally duplicated and the
// regex pattern is byte-identical.

export function killSwitchActive(): boolean {
  const v = process.env.PHASE3_KILL_SWITCH;
  if (!v) return false;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

// ─── Routing mode (visibility) ────────────────────────────────────────

export type RoutingMode =
  /** Kill-switch is on. Booking POST hits legacy_platform regardless of the tenant flag. */
  | "kill_switch"
  /** Tenant flag is false. Booking POST → platform Stripe (or refuses if platform unconfigured). */
  | "legacy_platform"
  /** Tenant flag is true AND a usable live default exists. Booking POST → tenant's own provider. */
  | "tenant_vault_active"
  /** Tenant flag is true but no usable live default. Booking POST → 503 strict_no_provider. */
  | "tenant_vault_strict";

// ─── Prerequisite checklist ───────────────────────────────────────────

/**
 * The five prerequisite keys, in display order. Stable identifiers so
 * the UI and the audit metadata stay aligned.
 */
export type PrereqKey =
  | "providerExists"
  | "providerEnabled"
  | "providerDefault"
  | "providerVerified"
  | "webhookSecretConfigured";

export interface PrereqItem {
  key: PrereqKey;
  label: string;
  ok: boolean;
  /** Human-readable explanation (success OR failure). Never includes secrets. */
  detail: string;
}

export interface ActivationSnapshot {
  /** Current value of `tenants.use_tenant_payment_providers`. */
  enabled: boolean;
  /** True if PHASE3_KILL_SWITCH env var is set to a truthy value. */
  killSwitchActive: boolean;
  /** Resolved routing mode for this tenant right now. */
  routingMode: RoutingMode;
  /** Five-item ordered checklist. */
  checklist: PrereqItem[];
  /** True iff every checklist item is ok AND kill-switch is off. */
  canActivate: boolean;
  /** Short reason why the toggle is disabled, when applicable. NULL when ok. */
  blockedReason: string | null;
}

// ─── Internal helpers ─────────────────────────────────────────────────

/** Find the candidate live-mode provider for activation. We pick the
 *  default-flagged one if any (there's at most one per
 *  (tenant, mode, is_default=true) per the partial unique index in
 *  migration 0050). If none is default-flagged we still surface the
 *  best candidate so the checklist can explain WHICH step is missing
 *  (vs returning empty and saying "no provider"). */
async function findLiveCandidate(tenantId: string) {
  // First try the default. This is the row we'd activate against.
  const def = await db.query.tenantPaymentProviders.findFirst({
    where: and(
      eq(tenantPaymentProviders.tenantId, tenantId),
      eq(tenantPaymentProviders.mode, "live"),
      eq(tenantPaymentProviders.isDefault, true),
    ),
  });
  if (def) return { row: def, isDefault: true };

  // Fall back to ANY live provider so the checklist explains "promote
  // one to default" rather than "create a provider first" when at least
  // one exists.
  const any = await db.query.tenantPaymentProviders.findFirst({
    where: and(
      eq(tenantPaymentProviders.tenantId, tenantId),
      eq(tenantPaymentProviders.mode, "live"),
    ),
  });
  return any ? { row: any, isDefault: false } : null;
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Compute the full activation snapshot for a tenant.
 *
 * Pure read-only — never mutates the flag or any provider row. The two
 * callers (the GET endpoint and the POST endpoint's gate) both use this
 * so the UI's checklist matches the server's enforcement byte-for-byte.
 */
export async function evaluateActivation(tenantId: string): Promise<ActivationSnapshot> {
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: { useTenantPaymentProviders: true },
  });
  const enabled = Boolean(tenant?.useTenantPaymentProviders);
  const ksOn = killSwitchActive();

  const candidate = await findLiveCandidate(tenantId);

  // Build the 5-item checklist. We always emit all 5 items, even when
  // earlier items fail — that way the admin sees the full picture and
  // can plan the setup work. (UI may collapse trailing items if
  // earlier ones are blocking; that's a presentation choice.)
  const checklist: PrereqItem[] = [];

  // 1) A live provider row exists at all.
  const providerExistsOk = candidate !== null;
  checklist.push({
    key: "providerExists",
    label: "A live-mode payment provider is configured",
    ok: providerExistsOk,
    detail: providerExistsOk
      ? `${candidate!.row.provider} (${candidate!.row.accountLabel || "no label"})`
      : "Add a Stripe or PayPal provider above with mode = LIVE.",
  });

  // 2) Provider is `enabled = true` (soft toggle).
  const providerEnabledOk = providerExistsOk && Boolean(candidate!.row.enabled);
  checklist.push({
    key: "providerEnabled",
    label: "Provider is enabled (not soft-disabled)",
    ok: providerEnabledOk,
    detail: !providerExistsOk
      ? "Waiting for a live provider."
      : providerEnabledOk
        ? "Enabled."
        : "The provider is soft-disabled. Re-enable it from the provider row.",
  });

  // 3) Provider is the live default.
  const providerDefaultOk = providerExistsOk && Boolean(candidate!.isDefault);
  checklist.push({
    key: "providerDefault",
    label: "Provider is set as default for LIVE bookings",
    ok: providerDefaultOk,
    detail: !providerExistsOk
      ? "Waiting for a live provider."
      : providerDefaultOk
        ? "Default for live."
        : "Promote one live provider to default — bookings need a single source of truth.",
  });

  // 4) Last verification succeeded — status='verified' AND lastVerifiedAt non-null.
  const providerVerifiedOk =
    providerExistsOk &&
    candidate!.row.status === "verified" &&
    candidate!.row.lastVerifiedAt !== null;
  checklist.push({
    key: "providerVerified",
    label: "Last Test Connection succeeded",
    ok: providerVerifiedOk,
    detail: !providerExistsOk
      ? "Waiting for a live provider."
      : providerVerifiedOk
        ? `Verified at ${candidate!.row.lastVerifiedAt!.toISOString()}.`
        : candidate!.row.status === "invalid"
          ? "Last Test Connection failed. Re-run it from the provider row."
          : candidate!.row.status === "disabled"
            ? "Provider status is disabled. Re-enable + verify."
            : "Run Test Connection on the provider row.",
  });

  // 5) Webhook secret is configured. Either the encrypted secret column
  //    is set OR the webhook_status has moved past 'unconfigured'. Both
  //    signals exist for resilience — webhookStatus is updated by the
  //    receiver, the column is set by the admin save flow. Either alone
  //    is sufficient evidence that the secret is in place.
  const webhookSecretOk =
    providerExistsOk &&
    (Boolean(candidate!.row.webhookSecretEncrypted) ||
      candidate!.row.webhookStatus === "configured" ||
      candidate!.row.webhookStatus === "verified");
  checklist.push({
    key: "webhookSecretConfigured",
    label: "Webhook signing secret is configured",
    ok: webhookSecretOk,
    detail: !providerExistsOk
      ? "Waiting for a live provider."
      : webhookSecretOk
        ? candidate!.row.webhookStatus === "verified"
          ? `Verified (last event ${candidate!.row.lastWebhookVerifiedAt?.toISOString() ?? "—"}).`
          : "Secret saved. Will switch to Verified once the first event arrives."
        : "Paste your webhook signing secret on the provider row.",
  });

  const allOk = checklist.every((c) => c.ok);

  // Resolve the routing mode independently of canActivate so a tenant
  // with flag=true but a now-invalid provider shows the strict state.
  let routingMode: RoutingMode;
  if (ksOn) {
    routingMode = "kill_switch";
  } else if (!enabled) {
    routingMode = "legacy_platform";
  } else {
    // Flag is on. Match the booking resolver's logic exactly:
    //   live default + status NOT IN ('invalid','disabled') → active
    //   anything else → strict_no_provider (booking POST 503s)
    const usable =
      candidate?.isDefault &&
      candidate.row.status !== "invalid" &&
      candidate.row.status !== "disabled";
    routingMode = usable ? "tenant_vault_active" : "tenant_vault_strict";
  }

  // canActivate is what gates the toggle. Distinct from routingMode —
  // an already-enabled tenant can always disable, but enabling requires
  // all prereqs AND kill-switch off (you can't opt-in while the panic
  // lever is pulled).
  const canActivate = allOk && !ksOn;

  let blockedReason: string | null = null;
  if (!canActivate) {
    if (ksOn) {
      blockedReason =
        "The PHASE3_KILL_SWITCH operator override is active. Activation is paused platform-wide.";
    } else {
      const firstFailing = checklist.find((c) => !c.ok);
      blockedReason = firstFailing
        ? `Setup incomplete: ${firstFailing.label.toLowerCase()}.`
        : "Setup incomplete.";
    }
  }

  return {
    enabled,
    killSwitchActive: ksOn,
    routingMode,
    checklist,
    canActivate,
    blockedReason,
  };
}

/** Reduced shape used by the POST handler to record audit metadata
 *  without dragging the labels (which are presentation strings). */
export function summarizeChecklistForAudit(
  snap: ActivationSnapshot,
): Record<PrereqKey, boolean> {
  const out = {} as Record<PrereqKey, boolean>;
  for (const item of snap.checklist) {
    out[item.key] = item.ok;
  }
  return out;
}
