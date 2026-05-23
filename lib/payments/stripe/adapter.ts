/**
 * Wave H — Stripe adapter (tenant-owned account).
 *
 * Implements the `PaymentProvider` contract. EVERY call constructs a
 * fresh Stripe client from the tenant's decrypted secret key — never
 * caches across tenants, never falls back to the platform key
 * (`STRIPE_SECRET_KEY`). The platform key is reserved EXCLUSIVELY for
 * ZentroMeet's own subscription billing flow (`/api/billing/checkout`,
 * `/api/webhooks/stripe`) and must never appear in this file.
 *
 * No Stripe Connect: there is no `application_fee_amount`, no
 * `transfer_data`, no `on_behalf_of`. Charges land in the tenant's
 * own balance directly. ZentroMeet does not appear in the money path.
 *
 * Stateless on purpose, mirrors `lib/calendar/google.ts` — adapter is
 * pure SDK-call surface, every method takes creds + args.
 */

import type Stripe from "stripe";

import type { PaymentProvider } from "../provider";
import type {
  CheckoutArgs,
  CheckoutResult,
  ProviderCapabilities,
  ProviderCredentials,
  RefundArgs,
  RefundResult,
  StripeCredentials,
  ValidationErrorClass,
  ValidationResult,
  VerifyWebhookResult,
  WebhookEventKind,
} from "../types";

// ─── Per-call client factory ───────────────────────────────────────────
// We import the SDK once (`import type Stripe from "stripe"` is
// type-only; the runtime import is dynamic so this module can be
// imported by tests without the SDK on the path).

let _StripeCtor: typeof import("stripe").default | null = null;
async function loadStripeCtor(): Promise<typeof import("stripe").default> {
  if (_StripeCtor) return _StripeCtor;
  const mod = await import("stripe");
  _StripeCtor = mod.default;
  return _StripeCtor;
}

/** Builds a fresh client per call. NEVER cache — each call is for a
 *  potentially different tenant, and key bleed would be catastrophic. */
async function clientFor(secretKey: string): Promise<Stripe> {
  const Ctor = await loadStripeCtor();
  return new Ctor(secretKey, {
    // No apiVersion pin — let the SDK pick its own default, same as
    // `lib/stripe.ts` does for the platform key. Avoids drift.
    appInfo: {
      name: "ZentroMeet (tenant vault)",
      url: "https://app.zentromeet.com",
    },
    // Stripe SDK retries some idempotent calls automatically. We
    // leave that default behavior intact.
  });
}

function assertStripeCreds(creds: ProviderCredentials): StripeCredentials {
  if (creds.kind !== "stripe") {
    throw new Error(
      `Stripe adapter received non-Stripe credentials: kind='${creds.kind}'`,
    );
  }
  if (!creds.secretKey || !creds.secretKey.trim()) {
    throw new Error("Stripe credentials missing secretKey");
  }
  return creds;
}

// ─── validateCredentials ───────────────────────────────────────────────

async function validateCredentials(
  raw: ProviderCredentials,
): Promise<ValidationResult> {
  let creds: StripeCredentials;
  try {
    creds = assertStripeCreds(raw);
  } catch (e) {
    return {
      ok: false,
      errorClass: "config",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  // Cheap, side-effect-free read that confirms the key authenticates
  // AND yields the capability metadata we want to cache:
  //   • country
  //   • default_currency
  //   • charges_enabled
  //   • payouts_enabled
  //   • capabilities (provider's own list — not used in Phase 1 logic
  //     but stored for future "you must enable X on your Stripe
  //     account" hints).
  try {
    const stripe = await clientFor(creds.secretKey);
    // Stripe Node SDK ≥22 typed `accounts.retrieve` as `(id: string)` —
    // but the underlying HTTP method `GET /v1/account` requires no
    // arguments and returns the OWN account that the secret key belongs
    // to. The SDK supports this at runtime via the no-arg call; the
    // type system just doesn't expose that overload.
    //
    // ⚠ Binding note: the resource method uses `this._makeRequest(...)`
    // internally (see `node_modules/stripe/cjs/resources/Accounts.js`),
    // so we MUST call it as a method on `stripe.accounts` — extracting
    // the bare function reference into a local (`const fn = stripe.accounts.retrieve`)
    // would detach `this`, and the SDK would throw
    //   "Cannot read properties of undefined (reading '_makeRequest')"
    // at runtime. We cast the parent resource (not the method) so the
    // call site stays a method invocation and the binding survives.
    const accountsResource = stripe.accounts as unknown as {
      retrieve: () => Promise<Stripe.Account>;
    };
    const account = await accountsResource.retrieve();
    const capabilities: ProviderCapabilities = {
      accountId: account.id,
      country: account.country ?? undefined,
      defaultCurrency: account.default_currency ?? undefined,
      chargesEnabled: account.charges_enabled ?? undefined,
      payoutsEnabled: account.payouts_enabled ?? undefined,
      // `capabilities` is a Record<string, "active"|"inactive"|"pending">
      // — keep it as-is for surface area. The dashboard can render
      // "card_payments: active" etc. without us shaping further.
      stripeCapabilities: account.capabilities ?? {},
      businessType: account.business_type ?? undefined,
      email: account.email ?? undefined,
    };
    return { ok: true, capabilities };
  } catch (err) {
    return {
      ok: false,
      errorClass: classifyError(err),
      message: errorMessage(err),
    };
  }
}

// ─── createCheckout ────────────────────────────────────────────────────

async function createCheckout(
  raw: ProviderCredentials,
  args: CheckoutArgs,
): Promise<CheckoutResult> {
  const creds = assertStripeCreds(raw);
  const stripe = await clientFor(creds.secretKey);

  // Idempotency: same bookingId → same session. Stripe stores
  // idempotency keys for 24h, which comfortably covers any retry the
  // booking POST might do. The booking record links to the session id
  // so a second visit to the booking POST after a network blip
  // returns the same Stripe Checkout URL rather than creating a
  // duplicate session (and potentially a duplicate hold).
  const idempotencyKey = `booking_${args.bookingId}`;

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    customer_email: args.customerEmail,
    line_items: [
      {
        price_data: {
          currency: args.currency.toLowerCase(),
          unit_amount: args.amountCents,
          product_data: {
            name: args.description,
          },
        },
        quantity: 1,
      },
    ],
    // Echoed back on the webhook event under
    // `data.object.metadata.bookingId` — the receiver uses this to
    // resolve the booking without trusting URL params.
    metadata: {
      bookingId: args.bookingId,
      tenantId: args.tenantId,
      ...args.metadata,
    },
    // Also stamp the PaymentIntent metadata so refund events
    // (charge.refunded) — which only surface the PI, not the
    // session — still carry the booking pointer.
    payment_intent_data: {
      metadata: {
        bookingId: args.bookingId,
        tenantId: args.tenantId,
        ...args.metadata,
      },
    },
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  };

  const session = await stripe.checkout.sessions.create(params, {
    idempotencyKey,
  });

  if (!session.url) {
    // Stripe always returns a hosted URL for `mode:'payment'` without
    // `ui_mode:'embedded'`. Defensive only — never seen in practice.
    throw new Error("Stripe returned a checkout session with no URL");
  }

  return {
    sessionId: session.id,
    checkoutUrl: session.url,
  };
}

// ─── verifyWebhook ─────────────────────────────────────────────────────

async function verifyWebhook(
  raw: ProviderCredentials,
  rawBody: string,
  headers: Record<string, string>,
): Promise<VerifyWebhookResult> {
  const creds = assertStripeCreds(raw);
  if (!creds.webhookSecret) {
    // No secret configured yet — receiver should reject. We return
    // null rather than throwing so the route can log it as
    // "invalid_signature" rather than a 500.
    return null;
  }
  // Stripe concentrates everything into a single `stripe-signature`
  // header. The receiver normalizes header keys to lowercase before
  // calling us, so lookup is case-stable.
  const signatureHeader = headers["stripe-signature"];
  if (!signatureHeader) return null;

  const stripe = await clientFor(creds.secretKey);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      creds.webhookSecret,
    );
  } catch {
    // Signature mismatch / replay outside tolerance. Stripe's library
    // throws — we swallow and signal "reject" via null.
    return null;
  }

  return normalizeStripeEvent(event);
}

function normalizeStripeEvent(event: Stripe.Event): VerifyWebhookResult {
  const kind = classifyStripeEventType(event.type);

  // Pull amount + currency + bookingId out of whichever object the
  // event carries. Cast through `unknown` to avoid leaning on the
  // discriminated union which varies per event type.
  const data = event.data?.object as unknown as
    | Record<string, unknown>
    | undefined;

  let bookingId: string | null = null;
  let amountCents: number | null = null;
  let currency: string | null = null;

  if (data) {
    const meta = (data.metadata as Record<string, string> | undefined) ?? undefined;
    bookingId = meta?.bookingId ?? null;

    // Common amount fields across event shapes:
    //   • checkout.session.completed → amount_total
    //   • payment_intent.* → amount / amount_received
    //   • charge.refunded → amount_refunded (delta) + amount (total)
    const candidates = [
      data.amount_total,
      data.amount_received,
      data.amount_refunded,
      data.amount,
    ];
    for (const c of candidates) {
      if (typeof c === "number") {
        amountCents = c;
        break;
      }
    }
    if (typeof data.currency === "string") {
      currency = data.currency.toLowerCase();
    }
  }

  return {
    id: event.id,
    kind,
    rawType: event.type,
    bookingId,
    amountCents,
    currency,
    raw: event,
  };
}

function classifyStripeEventType(t: string): WebhookEventKind {
  switch (t) {
    case "checkout.session.completed":
    case "payment_intent.succeeded":
      return "checkout.completed";
    case "payment_intent.payment_failed":
    case "checkout.session.expired":
      return "checkout.failed";
    case "charge.refunded":
    case "refund.created":
    case "refund.updated":
      return "refund.created";
    case "account.updated":
    case "capability.updated":
      return "account.updated";
    default:
      return "unhandled";
  }
}

// ─── refund (Phase 3) ─────────────────────────────────────────────────

async function refund(
  raw: ProviderCredentials,
  args: RefundArgs,
): Promise<RefundResult> {
  let creds: StripeCredentials;
  try {
    creds = assertStripeCreds(raw);
  } catch (e) {
    return {
      ok: false,
      errorClass: "config",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
  try {
    const stripe = await clientFor(creds.secretKey);
    // Stripe idempotency keys are scoped to the API key, so we don't
    // need to namespace by tenant — the key is already tenant-bound.
    // (charge, booking) tuple → deterministic key → safe replay.
    const idempotencyKey = `refund:${args.externalChargeId}:${args.bookingId}`;
    const refundParams: Parameters<Stripe["refunds"]["create"]>[0] = {
      payment_intent: args.externalChargeId,
      // requested_by_customer is the closest semantically-neutral
      // Stripe enum; the real reason lives in metadata for forensics.
      reason: "requested_by_customer",
      metadata: {
        bookingId: args.bookingId,
        internalReason: args.reason.slice(0, 200),
      },
    };
    if (args.amountCents !== null) {
      refundParams.amount = args.amountCents;
    }
    const r = await stripe.refunds.create(refundParams, { idempotencyKey });
    return { ok: true, refundId: r.id };
  } catch (err) {
    return {
      ok: false,
      errorClass: classifyError(err),
      reason: errorMessage(err),
    };
  }
}

// ─── Error classification ──────────────────────────────────────────────

function classifyError(err: unknown): ValidationErrorClass {
  // Stripe SDK errors carry `.type` and `.statusCode`.
  const e = err as {
    type?: string;
    statusCode?: number;
    code?: string;
    message?: string;
  };
  if (e?.type === "StripeAuthenticationError") return "auth";
  if (e?.type === "StripePermissionError") return "permission";
  if (e?.type === "StripeRateLimitError") return "rate_limit";
  if (e?.type === "StripeConnectionError") return "transient";
  if (e?.type === "StripeAPIError") return "transient";
  if (typeof e?.statusCode === "number") {
    if (e.statusCode === 401 || e.statusCode === 403) return "auth";
    if (e.statusCode === 429) return "rate_limit";
    if (e.statusCode >= 500) return "transient";
  }
  if (typeof e?.code === "string") {
    if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(e.code)) {
      return "transient";
    }
  }
  return "unknown";
}

/** Redact anything that looks like a Stripe credential token. Stripe's
 *  own error messages sometimes echo back a fragment of the offending
 *  key (e.g. "Invalid API Key provided: sk_live_AbCd…XyZw"). We persist
 *  these messages to `tenant_payment_providers.lastError` and surface
 *  them to the dashboard, so we MUST scrub any token-shaped substring
 *  before it leaves this function.
 *
 *  Patterns covered:
 *    sk_live_… / sk_test_…  → live/test secret keys
 *    rk_live_… / rk_test_…  → restricted secret keys
 *    pk_live_… / pk_test_…  → publishable keys (less sensitive but
 *                              we redact for uniformity)
 *    whsec_…                → webhook signing secrets
 *  Anything after the prefix until whitespace, quote, comma, or
 *  end-of-string is replaced with the prefix + "[REDACTED]". */
function redactSecrets(s: string): string {
  return s
    .replace(/sk_(live|test)_[A-Za-z0-9]+/g, "sk_$1_[REDACTED]")
    .replace(/rk_(live|test)_[A-Za-z0-9]+/g, "rk_$1_[REDACTED]")
    .replace(/pk_(live|test)_[A-Za-z0-9]+/g, "pk_$1_[REDACTED]")
    .replace(/whsec_[A-Za-z0-9]+/g, "whsec_[REDACTED]");
}

function errorMessage(err: unknown): string {
  const e = err as { message?: string };
  const m = e?.message ?? String(err);
  return redactSecrets(m).slice(0, 500);
}

// ─── Adapter export ────────────────────────────────────────────────────

export const stripeAdapter: PaymentProvider = {
  id: "stripe",
  validateCredentials,
  createCheckout,
  verifyWebhook,
  refund,
};
