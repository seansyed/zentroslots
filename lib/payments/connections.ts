/**
 * Wave H — tenant payment provider vault: CRUD + encryption boundary.
 *
 * This module is the ONLY place that:
 *   • Calls `encryptSecret()` on inbound plaintext credentials
 *   • Calls `decryptSecret()` on stored envelopes
 *   • Hands plaintext `ProviderCredentials` to adapter calls
 *
 * Two strict rules:
 *   1. `getProvider()` (the public, route-safe accessor) NEVER returns
 *      a decrypted secret. It returns `RedactedProviderRow`, with
 *      `secretPreview` masked via `previewSecret()`.
 *   2. `getProviderWithCredentials()` (internal) returns the plaintext
 *      bundle. Only the adapter-driving helpers in THIS file + the
 *      Phase-3 booking POST + the Phase-4 webhook receiver may call it.
 *      It is NOT exported by name from a `route.ts` accidentally — keep
 *      the call site list short and grep-auditable.
 *
 * No HTTP, no Next, no React in this module — pure DB + crypto + adapter
 * dispatch. Tests can drive it with a mocked `db`.
 */

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  tenantPaymentProviders,
  type TenantPaymentProvider,
} from "@/db/schema";
import { decryptSecret, encryptSecret, previewSecret } from "@/lib/crypto";

import { getAdapter } from "./registry";
import type {
  PaymentMode,
  PaymentProviderId,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderStatus,
  ValidationResult,
} from "./types";

// ─── Public, redacted row shape ────────────────────────────────────────
// The shape the UI + dashboards consume. Crucially: NO decrypted secret.

export interface RedactedProviderRow {
  id: string;
  tenantId: string;
  provider: PaymentProviderId;
  mode: PaymentMode;
  accountLabel: string;
  /** "•••XXXX" — last 4 of the stored secret. NEVER the secret itself. */
  secretPreview: string;
  publishableKey: string | null;
  clientId: string | null;
  /** Boolean — we don't even surface the preview of a webhook secret,
   *  the tenant just needs to know "it's set" / "it's not set". */
  hasWebhookSecret: boolean;
  status: ProviderStatus;
  lastVerifiedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  capabilities: ProviderCapabilities;
  isDefault: boolean;
  enabled: boolean;
  lastPaymentEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function redact(row: TenantPaymentProvider): RedactedProviderRow {
  // For preview we want the LAST 4 chars of the plaintext. We don't
  // have plaintext on read, only the envelope — so we decrypt JUST
  // enough to derive the preview, then drop the plaintext from the
  // stack frame. This is the only "leak" path and it's bounded.
  let secretPreview = "•••";
  try {
    const pt = decryptSecret(row.secretEncrypted);
    if (pt) secretPreview = previewSecret(pt);
  } catch {
    // Envelope tampered or key rotated — surface as a generic mask
    // rather than throwing on every dashboard load.
    secretPreview = "•••";
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    provider: row.provider as PaymentProviderId,
    mode: row.mode as PaymentMode,
    accountLabel: row.accountLabel,
    secretPreview,
    publishableKey: row.publishableKey,
    clientId: row.clientId,
    hasWebhookSecret: !!row.webhookSecretEncrypted,
    status: row.status as ProviderStatus,
    lastVerifiedAt: row.lastVerifiedAt,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    capabilities: (row.capabilities ?? {}) as ProviderCapabilities,
    isDefault: row.isDefault,
    enabled: row.enabled,
    lastPaymentEventAt: row.lastPaymentEventAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── List / read (redacted) ────────────────────────────────────────────

export async function listProvidersForTenant(
  tenantId: string,
): Promise<RedactedProviderRow[]> {
  const rows = await db.query.tenantPaymentProviders.findMany({
    where: eq(tenantPaymentProviders.tenantId, tenantId),
    orderBy: [desc(tenantPaymentProviders.updatedAt)],
  });
  return rows.map(redact);
}

export async function getProviderRedacted(
  tenantId: string,
  providerRowId: string,
): Promise<RedactedProviderRow | null> {
  const row = await db.query.tenantPaymentProviders.findFirst({
    where: and(
      eq(tenantPaymentProviders.id, providerRowId),
      eq(tenantPaymentProviders.tenantId, tenantId),
    ),
  });
  return row ? redact(row) : null;
}

/**
 * Resolves the default provider for a (tenant, mode) selection. Returns
 * the redacted row — the booking POST will then call the internal
 * `getProviderWithCredentials` to actually charge. Returns null when
 * the tenant has no default configured for this mode (booking POST
 * then falls back to the legacy platform path or refuses, depending
 * on the tenant's feature flag).
 */
export async function getDefaultProviderRedacted(
  tenantId: string,
  mode: PaymentMode,
): Promise<RedactedProviderRow | null> {
  const row = await db.query.tenantPaymentProviders.findFirst({
    where: and(
      eq(tenantPaymentProviders.tenantId, tenantId),
      eq(tenantPaymentProviders.mode, mode),
      eq(tenantPaymentProviders.isDefault, true),
      eq(tenantPaymentProviders.enabled, true),
    ),
  });
  return row ? redact(row) : null;
}

// ─── Internal: load + decrypt for an adapter call ─────────────────────
//
// CALL SITES (grep-auditable — keep this list TIGHT):
//   • lib/payments/connections.ts  — testConnection, this file
//   • app/api/bookings/route.ts    — Phase 3 (not yet wired)
//   • app/api/webhooks/payments/[providerId]/route.ts — Phase 4
//
// Adding a new call site requires explicit review.

export interface ProviderWithCredentials {
  row: TenantPaymentProvider;
  creds: ProviderCredentials;
}

export async function getProviderWithCredentials(
  tenantId: string,
  providerRowId: string,
): Promise<ProviderWithCredentials | null> {
  const row = await db.query.tenantPaymentProviders.findFirst({
    where: and(
      eq(tenantPaymentProviders.id, providerRowId),
      eq(tenantPaymentProviders.tenantId, tenantId),
    ),
  });
  if (!row) return null;
  const creds = decryptRowToCredentials(row);
  return { row, creds };
}

function decryptRowToCredentials(row: TenantPaymentProvider): ProviderCredentials {
  const secret = decryptSecret(row.secretEncrypted);
  if (!secret) {
    throw new Error(
      `tenant_payment_providers ${row.id}: secret_encrypted decrypted to null`,
    );
  }
  const webhookSecret = row.webhookSecretEncrypted
    ? decryptSecret(row.webhookSecretEncrypted)
    : null;

  if (row.provider === "stripe") {
    return {
      kind: "stripe",
      secretKey: secret,
      publishableKey: row.publishableKey,
      webhookSecret: webhookSecret,
    };
  }
  if (row.provider === "paypal") {
    return {
      kind: "paypal",
      clientId: row.clientId ?? "",
      clientSecret: secret,
      webhookId: webhookSecret,
      mode: (row.mode as PaymentMode) ?? "live",
    };
  }
  throw new Error(`Unknown provider '${row.provider}' on row ${row.id}`);
}

// ─── Create / update (encrypted boundary) ──────────────────────────────

/** Plaintext bundle accepted by `upsertProvider`. The caller (a route
 *  handler validating user input) is responsible for whitespace trim
 *  + obvious shape checks. Encryption happens HERE, never upstream. */
export interface UpsertInput {
  tenantId: string;
  provider: PaymentProviderId;
  mode: PaymentMode;
  accountLabel: string;
  /** Plaintext master credential (Stripe secret key / PayPal client_secret).
   *  Encrypted before INSERT/UPDATE. */
  secret: string;
  publishableKey?: string | null;
  clientId?: string | null;
  /** Plaintext webhook signing secret. Optional — tenants typically
   *  set this in a second step after configuring the webhook in the
   *  provider's dashboard. Encrypted before INSERT/UPDATE. */
  webhookSecret?: string | null;
  createdByUserId?: string | null;
}

export async function upsertProvider(input: UpsertInput): Promise<RedactedProviderRow> {
  if (!input.secret || !input.secret.trim()) {
    throw new Error("upsertProvider: secret is required");
  }
  const secretEncrypted = encryptSecret(input.secret.trim());
  if (!secretEncrypted) {
    throw new Error("upsertProvider: failed to encrypt secret");
  }
  const webhookSecretEncrypted = input.webhookSecret?.trim()
    ? encryptSecret(input.webhookSecret.trim())
    : null;

  // ON CONFLICT (tenant_id, provider, mode) → overwrite credentials +
  // reset status to 'pending'. The caller is expected to immediately
  // run testConnection(), which flips status to 'verified' on success.
  const now = new Date();
  const [row] = await db
    .insert(tenantPaymentProviders)
    .values({
      tenantId: input.tenantId,
      provider: input.provider,
      mode: input.mode,
      accountLabel: input.accountLabel ?? "",
      secretEncrypted,
      publishableKey: input.publishableKey ?? null,
      clientId: input.clientId ?? null,
      webhookSecretEncrypted,
      status: "pending",
      lastVerifiedAt: null,
      lastError: null,
      lastErrorAt: null,
      capabilities: {},
      isDefault: false,
      enabled: true,
      createdByUserId: input.createdByUserId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        tenantPaymentProviders.tenantId,
        tenantPaymentProviders.provider,
        tenantPaymentProviders.mode,
      ],
      set: {
        accountLabel: input.accountLabel ?? "",
        secretEncrypted,
        publishableKey: input.publishableKey ?? null,
        clientId: input.clientId ?? null,
        // Only overwrite the webhook secret when a new one was passed.
        // Saving "main credential only" must not blank a separately-
        // configured webhook signing secret.
        ...(webhookSecretEncrypted ? { webhookSecretEncrypted } : {}),
        // Re-saving credentials resets verification state — caller
        // immediately runs testConnection() to refresh it.
        status: "pending",
        lastVerifiedAt: null,
        lastError: null,
        lastErrorAt: null,
        capabilities: {},
        updatedAt: now,
      },
    })
    .returning();
  return redact(row);
}

/** Patch the webhook secret in place, leaving every other field
 *  untouched. Used by the "I've set up the webhook in Stripe, here's
 *  the signing secret" second-step UI. */
export async function setWebhookSecret(
  tenantId: string,
  providerRowId: string,
  plaintext: string,
): Promise<RedactedProviderRow | null> {
  const encrypted = encryptSecret(plaintext.trim());
  if (!encrypted) {
    throw new Error("setWebhookSecret: failed to encrypt");
  }
  const [row] = await db
    .update(tenantPaymentProviders)
    .set({ webhookSecretEncrypted: encrypted, updatedAt: new Date() })
    .where(
      and(
        eq(tenantPaymentProviders.id, providerRowId),
        eq(tenantPaymentProviders.tenantId, tenantId),
      ),
    )
    .returning();
  return row ? redact(row) : null;
}

export async function setEnabled(
  tenantId: string,
  providerRowId: string,
  enabled: boolean,
): Promise<RedactedProviderRow | null> {
  const [row] = await db
    .update(tenantPaymentProviders)
    .set({
      enabled,
      // Toggling enabled → false should NOT silently keep is_default
      // true: the partial unique index would then point at a disabled
      // row, which the dashboard would misrender as "active default".
      ...(enabled ? {} : { isDefault: false }),
      // Disabled rows surface as status='disabled' for clarity; re-
      // enabling resets to 'pending' so the next test re-verifies.
      status: enabled ? "pending" : "disabled",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tenantPaymentProviders.id, providerRowId),
        eq(tenantPaymentProviders.tenantId, tenantId),
      ),
    )
    .returning();
  return row ? redact(row) : null;
}

/**
 * Toggle which provider row is the default for a (tenant, mode). Wrapped
 * in a transaction so the partial unique index
 *   tenant_payment_providers_default ON (tenant_id, mode) WHERE is_default
 * never sees two true rows mid-transition. The clear-then-set order
 * matters: doing it as a single UPDATE with `id = ?` would leave the
 * old default true until the new one was set, briefly violating uniq.
 */
export async function setDefault(
  tenantId: string,
  providerRowId: string,
  mode: PaymentMode,
): Promise<RedactedProviderRow | null> {
  return db.transaction(async (tx) => {
    await tx
      .update(tenantPaymentProviders)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(tenantPaymentProviders.tenantId, tenantId),
          eq(tenantPaymentProviders.mode, mode),
          eq(tenantPaymentProviders.isDefault, true),
        ),
      );
    const [row] = await tx
      .update(tenantPaymentProviders)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(
        and(
          eq(tenantPaymentProviders.id, providerRowId),
          eq(tenantPaymentProviders.tenantId, tenantId),
          eq(tenantPaymentProviders.mode, mode),
        ),
      )
      .returning();
    return row ? redact(row) : null;
  });
}

export async function deleteProvider(
  tenantId: string,
  providerRowId: string,
): Promise<boolean> {
  // We delete rather than soft-delete: secrets shouldn't linger on
  // a disabled record any longer than necessary. Audit history lives
  // in `tenant_payment_webhook_events` (kept via ON DELETE CASCADE
  // not firing — those rows reference provider_id not tenant; the
  // CASCADE on provider would actually wipe them. Keep that in mind
  // for Phase 4 if we want long-term audit retention.)
  const res = await db
    .delete(tenantPaymentProviders)
    .where(
      and(
        eq(tenantPaymentProviders.id, providerRowId),
        eq(tenantPaymentProviders.tenantId, tenantId),
      ),
    )
    .returning({ id: tenantPaymentProviders.id });
  return res.length > 0;
}

// ─── Test connection ───────────────────────────────────────────────────

/**
 * Decrypts the stored credentials, dispatches to the provider's adapter
 * `validateCredentials()`, persists the outcome on the row, returns the
 * normalized result. This is the ONLY mutation path that touches
 * `status`/`lastVerifiedAt`/`lastError`/`capabilities` post-save.
 *
 * Called from:
 *   • The Test Connection button in the dashboard (Phase 5 UI)
 *   • Immediately after `upsertProvider()` to confirm a fresh save
 *   • The periodic re-validation worker (Phase 5)
 */
export async function testConnection(
  tenantId: string,
  providerRowId: string,
): Promise<ValidationResult> {
  // decryptRowToCredentials() throws if the envelope can't decrypt
  // (e.g. COMMS_ENCRYPTION_KEY rotated, row tampered). Catch here so
  // the caller gets a structured ValidationResult instead of an
  // uncaught exception whose stack trace could end up in a generic
  // 500-handler log line. The thrown Error message intentionally
  // references row.id only, never plaintext — but we wrap it
  // defensively anyway.
  let loaded: Awaited<ReturnType<typeof getProviderWithCredentials>>;
  try {
    loaded = await getProviderWithCredentials(tenantId, providerRowId);
  } catch {
    return {
      ok: false,
      errorClass: "config",
      message: "Stored credentials could not be decrypted",
    };
  }
  if (!loaded) {
    return {
      ok: false,
      errorClass: "unknown",
      message: "Provider row not found",
    };
  }
  const adapter = getAdapter(loaded.row.provider as PaymentProviderId);
  const result = await adapter.validateCredentials(loaded.creds);

  if (result.ok) {
    await db
      .update(tenantPaymentProviders)
      .set({
        status: "verified",
        lastVerifiedAt: new Date(),
        lastError: null,
        lastErrorAt: null,
        capabilities: result.capabilities,
        updatedAt: new Date(),
      })
      // Defense-in-depth: tenantId is in the WHERE even though we
      // already ownership-checked via getProviderWithCredentials. A
      // future refactor that drops that guard can't accidentally write
      // across tenants from here.
      .where(
        and(
          eq(tenantPaymentProviders.id, providerRowId),
          eq(tenantPaymentProviders.tenantId, tenantId),
        ),
      );
  } else {
    await db
      .update(tenantPaymentProviders)
      .set({
        // 'invalid' for auth/permission/config — caller can act on it.
        // 'pending' for transient/rate_limit — UI shouldn't scream
        // "broken" on a 429 retry-friendly blip.
        status:
          result.errorClass === "transient" || result.errorClass === "rate_limit"
            ? "pending"
            : "invalid",
        // Adapter is contractually required to redact provider tokens
        // before returning `message` — see redactSecrets() in the
        // Stripe adapter. The .slice(0, 500) is a belt-and-braces cap
        // on row size, not a redaction step.
        lastError: result.message.slice(0, 500),
        lastErrorAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tenantPaymentProviders.id, providerRowId),
          eq(tenantPaymentProviders.tenantId, tenantId),
        ),
      );
  }
  return result;
}
