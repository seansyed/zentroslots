/**
 * Wave H Phase 2 — PayPal adapter (tenant-owned account).
 *
 * Implements the `PaymentProvider` contract using PayPal's REST API
 * directly (no SDK — `@paypal/checkout-server-sdk` is deprecated and
 * unmaintained as of 2024; PayPal recommends raw REST). Every call
 * fetches a fresh OAuth2 access token from the tenant's stored
 * (client_id, client_secret) — we NEVER cache tokens across calls or
 * tenants, mirroring the Stripe adapter's per-call client lifecycle.
 *
 * Architectural constraints honored:
 *   • Tenant-owned account model — funds land in the tenant's PayPal
 *     balance directly. No platform fee, no marketplace partner ref,
 *     no on-behalf-of. ZentroMeet never appears in the money path.
 *   • Mode-aware base URL (sandbox vs live) — selected from the row's
 *     `mode` column, never from a global env var.
 *   • Signature verification uses PayPal's
 *     `/v1/notifications/verify-webhook-signature` endpoint — never
 *     hand-rolled HMAC against the raw body.
 *   • Errors are redacted of any token-shaped substring before being
 *     returned to the caller.
 */

import type { PaymentProvider } from "../provider";
import type {
  CheckoutArgs,
  CheckoutResult,
  PaymentMode,
  PayPalCredentials,
  ProviderCapabilities,
  ProviderCredentials,
  RefundArgs,
  RefundResult,
  ValidationErrorClass,
  ValidationResult,
  VerifyWebhookResult,
  WebhookEventKind,
} from "../types";

// ─── Fetch timeout (Phase 3) ───────────────────────────────────────────
// Wraps fetch() with an AbortController so PayPal-side hangs can't tie
// up the webhook receiver / booking POST indefinitely. 10s is comfortable
// — PayPal's verify-webhook-signature typically responds in <500ms; if
// it's slower than 10s something is genuinely broken upstream and the
// caller's retry path is the right answer.
const PAYPAL_FETCH_TIMEOUT_MS = 10_000;

async function paypalFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PAYPAL_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Environment routing ────────────────────────────────────────────────

const PAYPAL_LIVE_BASE = "https://api-m.paypal.com";
const PAYPAL_SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

function baseUrl(mode: PaymentMode): string {
  // 'live' → live API. 'test' → sandbox. PayPal calls test mode
  // "sandbox"; our shared `PaymentMode` keeps it as 'test' for cross-
  // provider parity, mapped here.
  return mode === "test" ? PAYPAL_SANDBOX_BASE : PAYPAL_LIVE_BASE;
}

function assertPayPalCreds(creds: ProviderCredentials): PayPalCredentials {
  if (creds.kind !== "paypal") {
    throw new Error(
      `PayPal adapter received non-PayPal credentials: kind='${creds.kind}'`,
    );
  }
  if (!creds.clientId || !creds.clientId.trim()) {
    throw new Error("PayPal credentials missing clientId");
  }
  if (!creds.clientSecret || !creds.clientSecret.trim()) {
    throw new Error("PayPal credentials missing clientSecret");
  }
  return creds;
}

// ─── OAuth: per-call access token ──────────────────────────────────────

interface AccessTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  app_id?: string;
}

/**
 * Exchanges (client_id, client_secret) for a short-lived bearer token.
 * Never cached — every adapter call mints a fresh one and discards it
 * when the call returns. Token lifetime in the response (`expires_in`)
 * is informational only; we don't reuse.
 *
 * Throws PayPalApiError on any non-2xx — caller's outer try/catch
 * classifies via `classifyError`.
 */
async function getAccessToken(creds: PayPalCredentials): Promise<string> {
  const url = `${baseUrl(creds.mode)}/v1/oauth2/token`;
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString(
    "base64",
  );
  const res = await paypalFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    // PayPal returns JSON error bodies with shape:
    //   { error: 'invalid_client', error_description: '...' }
    // We swallow whatever body comes back — even if PayPal echoes the
    // (already-bad) credentials in the message, redactSecrets() will
    // scrub them before persistence.
    const body = await safeReadText(res);
    throw new PayPalApiError(res.status, body || res.statusText);
  }
  const json = (await res.json()) as AccessTokenResponse;
  if (!json.access_token) {
    throw new PayPalApiError(res.status, "Missing access_token in response");
  }
  return json.access_token;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

class PayPalApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PayPalApiError";
    this.status = status;
  }
}

// ─── validateCredentials ───────────────────────────────────────────────

async function validateCredentials(
  raw: ProviderCredentials,
): Promise<ValidationResult> {
  let creds: PayPalCredentials;
  try {
    creds = assertPayPalCreds(raw);
  } catch (e) {
    return {
      ok: false,
      errorClass: "config",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  // Step 1: prove the (clientId, clientSecret) authenticate. This is
  // PayPal's equivalent of Stripe's accounts.retrieve() for own
  // account — a cheap, side-effect-free read.
  try {
    const accessToken = await getAccessToken(creds);

    // Step 2: best-effort enrichment. /v1/identity/oauth2/userinfo
    // returns the merchant's business email + payer_id. Some sandbox
    // accounts and certain live accounts without the "openid" scope
    // 401 here — we treat that as non-fatal and still return ok with
    // a minimal capabilities snapshot.
    let capabilities: ProviderCapabilities = {
      // PayPal doesn't surface a per-currency list via this endpoint;
      // PayPal merchant accounts accept whatever the buyer's currency
      // is and route through PayPal's FX. We leave currencies absent
      // rather than over-claim.
      chargesEnabled: true,
      // Mode echo for the dashboard — useful when both live + sandbox
      // rows are configured side by side.
      paypalMode: creds.mode,
    };

    try {
      const userinfo = await paypalFetch(
        `${baseUrl(creds.mode)}/v1/identity/oauth2/userinfo?schema=paypalv1.1`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
        },
      );
      if (userinfo.ok) {
        const ui = (await userinfo.json()) as {
          user_id?: string;
          payer_id?: string;
          email?: string;
          email_verified?: boolean;
          name?: string;
          verified_account?: boolean;
        };
        capabilities = {
          ...capabilities,
          accountId: ui.payer_id ?? ui.user_id,
          email: ui.email,
          emailVerified: ui.email_verified,
          merchantName: ui.name,
          verifiedAccount: ui.verified_account,
        };
      }
      // 401/403 on userinfo isn't a creds failure — the token from
      // step 1 already proved auth. Just skip enrichment.
    } catch {
      // Network blip enriching — swallow; the validate already passed.
    }

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

interface OrderResponse {
  id: string;
  status?: string;
  links?: Array<{ href: string; rel: string; method?: string }>;
}

async function createCheckout(
  raw: ProviderCredentials,
  args: CheckoutArgs,
): Promise<CheckoutResult> {
  const creds = assertPayPalCreds(raw);
  const accessToken = await getAccessToken(creds);

  // PayPal's idempotency mechanism is the `PayPal-Request-Id` header.
  // Same booking id retried → same order id returned, never a duplicate
  // charge attempt. Bounded to 40 chars by PayPal; UUID + `booking_`
  // prefix fits comfortably.
  const requestId = `booking_${args.bookingId}`;

  // Amount: PayPal uses decimal strings (e.g. "12.50"), NOT cents. We
  // convert from our normalized integer cents. Use Math.round to be
  // float-safe (mirroring Wave G).
  const decimalAmount = (Math.round(args.amountCents) / 100).toFixed(2);

  const body = {
    intent: "CAPTURE" as const,
    purchase_units: [
      {
        // reference_id lets the webhook resolve which line item paid;
        // we mirror the booking id here for cross-referencing.
        reference_id: args.bookingId,
        description: args.description.slice(0, 127), // PayPal max
        custom_id: args.bookingId,
        amount: {
          currency_code: args.currency.toUpperCase(),
          value: decimalAmount,
        },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          return_url: args.successUrl,
          cancel_url: args.cancelUrl,
          // user_action=PAY_NOW shows the buyer a "Pay Now" button on
          // the approve page rather than "Continue", reducing drop-off.
          user_action: "PAY_NOW",
        },
      },
    },
  };

  const res = await paypalFetch(`${baseUrl(creds.mode)}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "PayPal-Request-Id": requestId,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await safeReadText(res);
    throw new PayPalApiError(res.status, text || res.statusText);
  }
  const order = (await res.json()) as OrderResponse;
  // PayPal returns multiple links — `rel: 'payer-action'` (newer) or
  // `rel: 'approve'` (older). Pick whichever is present.
  const approve = order.links?.find(
    (l) => l.rel === "payer-action" || l.rel === "approve",
  );
  if (!approve?.href) {
    throw new Error(
      `PayPal order ${order.id} created but no approval link returned`,
    );
  }
  return { sessionId: order.id, checkoutUrl: approve.href };
}

// ─── verifyWebhook ─────────────────────────────────────────────────────

interface VerifyWebhookSignatureBody {
  auth_algo: string;
  cert_url: string;
  transmission_id: string;
  transmission_sig: string;
  transmission_time: string;
  webhook_id: string;
  webhook_event: unknown;
}

async function verifyWebhook(
  raw: ProviderCredentials,
  rawBody: string,
  headers: Record<string, string>,
): Promise<VerifyWebhookResult> {
  const creds = assertPayPalCreds(raw);
  if (!creds.webhookId) {
    // No webhook id configured yet — receiver should reject. PayPal's
    // verify endpoint requires the webhook_id we registered in the
    // tenant's PayPal dashboard.
    return null;
  }

  // PayPal sends five headers per event. The receiver normalizes all
  // header keys to lowercase before calling us. Missing any one is a
  // hard reject — null signals "invalid" to the receiver.
  const authAlgo = headers["paypal-auth-algo"];
  const certUrl = headers["paypal-cert-url"];
  const transmissionId = headers["paypal-transmission-id"];
  const transmissionSig = headers["paypal-transmission-sig"];
  const transmissionTime = headers["paypal-transmission-time"];
  if (
    !authAlgo ||
    !certUrl ||
    !transmissionId ||
    !transmissionSig ||
    !transmissionTime
  ) {
    return null;
  }

  // Defense against cert_url spoofing: PayPal certs live on
  // *.paypal.com (live + sandbox). Reject anything else BEFORE we
  // hand the URL to PayPal's verify endpoint — even though the
  // endpoint itself would catch a forged cert, refusing upstream
  // means we never expose the verify endpoint to a hostile URL.
  if (!isPayPalCertUrl(certUrl)) {
    return null;
  }

  // Parse the body once so we can hand the PARSED event to PayPal's
  // verify endpoint (it requires `webhook_event` as a JSON object,
  // not a string).
  let parsedEvent: Record<string, unknown>;
  try {
    parsedEvent = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return null;
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(creds);
  } catch {
    // We can't reach PayPal to verify — receiver should NOT trust
    // the event on a temporary error. Null = reject, the receiver
    // will log invalid_signature and PayPal will retry.
    return null;
  }

  const verifyBody: VerifyWebhookSignatureBody = {
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: creds.webhookId,
    webhook_event: parsedEvent,
  };

  let verifyRes: Response;
  try {
    verifyRes = await paypalFetch(
      `${baseUrl(creds.mode)}/v1/notifications/verify-webhook-signature`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(verifyBody),
      },
    );
  } catch {
    return null;
  }
  if (!verifyRes.ok) return null;

  const verifyJson = (await verifyRes.json()) as { verification_status?: string };
  if (verifyJson.verification_status !== "SUCCESS") return null;

  return normalizePayPalEvent(parsedEvent);
}

function isPayPalCertUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    // PayPal cert hostnames: api.paypal.com, api.sandbox.paypal.com,
    // and a few variants. We pin to the *.paypal.com suffix.
    return (
      parsed.hostname === "paypal.com" ||
      parsed.hostname.endsWith(".paypal.com")
    );
  } catch {
    return false;
  }
}

function normalizePayPalEvent(
  event: Record<string, unknown>,
): VerifyWebhookResult {
  const id = typeof event.id === "string" ? event.id : "";
  const eventType = typeof event.event_type === "string" ? event.event_type : "";
  if (!id || !eventType) return null;

  const kind = classifyPayPalEventType(eventType);

  // Try to pull the booking id from custom_id on the captured payment,
  // or reference_id on the purchase unit, depending on the event
  // shape. PayPal's capture-completed events nest the resource under
  // resource.purchase_units[0] OR resource directly — we check both.
  const resource = (event.resource as Record<string, unknown> | undefined) ?? {};
  let bookingId: string | null = null;
  const customId = resource.custom_id;
  if (typeof customId === "string") {
    bookingId = customId;
  } else {
    const units = resource.purchase_units as
      | Array<Record<string, unknown>>
      | undefined;
    const first = units?.[0];
    const refId = first?.reference_id;
    if (typeof refId === "string") bookingId = refId;
    else if (typeof first?.custom_id === "string") bookingId = first.custom_id;
  }

  // Amount + currency: PayPal events expose either
  //   resource.amount.value (capture-completed) — decimal string
  //   resource.purchase_units[0].amount.value (order-completed)
  // We normalize back to cents (integer).
  let amountCents: number | null = null;
  let currency: string | null = null;
  const amt =
    (resource.amount as { value?: string; currency_code?: string } | undefined) ??
    (
      (resource.purchase_units as Array<{ amount?: { value?: string; currency_code?: string } }> | undefined)?.[0]
        ?.amount
    );
  if (amt?.value) {
    const v = Number.parseFloat(amt.value);
    if (Number.isFinite(v)) amountCents = Math.round(v * 100);
  }
  if (amt?.currency_code) currency = amt.currency_code.toLowerCase();

  return {
    id,
    kind,
    rawType: eventType,
    bookingId,
    amountCents,
    currency,
    raw: event,
  };
}

function classifyPayPalEventType(t: string): WebhookEventKind {
  // PayPal's event taxonomy. Mapped to our normalized kinds; anything
  // unmapped becomes 'unhandled' (receiver logs + ignores).
  switch (t) {
    case "PAYMENT.CAPTURE.COMPLETED":
    case "CHECKOUT.ORDER.COMPLETED":
      return "checkout.completed";
    case "PAYMENT.CAPTURE.DENIED":
    case "PAYMENT.CAPTURE.DECLINED":
    case "CHECKOUT.ORDER.VOIDED":
      return "checkout.failed";
    case "PAYMENT.CAPTURE.REFUNDED":
    case "PAYMENT.CAPTURE.REVERSED":
      return "refund.created";
    case "MERCHANT.ONBOARDING.COMPLETED":
    case "MERCHANT.PARTNER-CONSENT.REVOKED":
      return "account.updated";
    default:
      return "unhandled";
  }
}

// ─── refund (Phase 3) ─────────────────────────────────────────────────
//
// PayPal refund flow: POST /v2/payments/captures/{capture_id}/refund.
// The `externalChargeId` we receive IS the capture id (PayPal's
// capture-completed events carry it as `resource.id`). For Stripe the
// equivalent is the payment_intent_id.
//
// Idempotency: `PayPal-Request-Id` header, deterministic on
// (capture_id, booking_id). PayPal enforces this for 1 hour after the
// first request — long enough for any retry storm but not so long
// that a legitimate second refund (e.g. an admin partial-refunding the
// same booking a week later) would collide.

async function refund(
  raw: ProviderCredentials,
  args: RefundArgs,
): Promise<RefundResult> {
  let creds: PayPalCredentials;
  try {
    creds = assertPayPalCreds(raw);
  } catch (e) {
    return {
      ok: false,
      errorClass: "config",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
  let accessToken: string;
  try {
    accessToken = await getAccessToken(creds);
  } catch (err) {
    return {
      ok: false,
      errorClass: classifyError(err),
      reason: errorMessage(err),
    };
  }

  const requestId = `refund:${args.externalChargeId}:${args.bookingId}`;
  // PayPal refund body: empty for full refund, { amount: { value, currency_code } }
  // for partial. We don't know the currency at refund time from RefundArgs
  // alone — for partial refunds the caller must include it via a
  // future args extension. For Phase 3 we ONLY issue full refunds
  // from the receiver's auto-refund paths, so this is fine.
  const body: Record<string, unknown> = {};
  if (args.amountCents !== null) {
    // Caller asked for partial; we don't have currency here. Fail
    // structured rather than guess.
    return {
      ok: false,
      errorClass: "config",
      reason: "Partial PayPal refunds not yet supported by adapter (Phase 3 issues full refunds only)",
    };
  }

  let res: Response;
  try {
    res = await paypalFetch(
      `${baseUrl(creds.mode)}/v2/payments/captures/${encodeURIComponent(args.externalChargeId)}/refund`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "PayPal-Request-Id": requestId,
          // Prefer return=representation so the response body includes
          // the refund id. Without this PayPal can return 204 + empty.
          Prefer: "return=representation",
        },
        body: JSON.stringify(body),
      },
    );
  } catch (err) {
    return {
      ok: false,
      errorClass: classifyError(err),
      reason: errorMessage(err),
    };
  }

  if (!res.ok) {
    const text = await safeReadText(res);
    return {
      ok: false,
      errorClass: classifyError(new PayPalApiError(res.status, text || res.statusText)),
      reason: redactSecrets(text || res.statusText).slice(0, 500),
    };
  }

  // 200/201 → JSON body with refund id. 204 → no body, but with
  // Prefer: return=representation that shouldn't happen. Defensive
  // either way.
  let refundId = `paypal-refund:${args.externalChargeId}`;
  try {
    const r = (await res.json()) as { id?: string };
    if (r?.id) refundId = r.id;
  } catch {
    // Empty body — refund still succeeded; we just don't have the id.
  }
  return { ok: true, refundId };
}

// ─── Error classification + redaction ──────────────────────────────────

function classifyError(err: unknown): ValidationErrorClass {
  if (err instanceof PayPalApiError) {
    if (err.status === 401 || err.status === 403) return "auth";
    if (err.status === 429) return "rate_limit";
    if (err.status >= 500) return "transient";
    if (err.status === 400) return "config";
    return "unknown";
  }
  const e = err as { code?: string; message?: string };
  if (typeof e?.code === "string") {
    if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(e.code)) {
      return "transient";
    }
  }
  // fetch() throws a TypeError on network failures.
  if (e?.message?.includes("fetch failed")) return "transient";
  return "unknown";
}

/** Redact anything that looks like a PayPal credential or token in
 *  error messages BEFORE returning them to the caller (who will
 *  persist them to `last_error` and surface to the dashboard).
 *
 *  Patterns covered:
 *    Authorization: Basic <base64>   → header echo of basic-auth creds
 *    access_token=…                   → URL-form access tokens
 *    "access_token":"…"               → JSON-form access tokens
 *    A21AA[a-zA-Z0-9_-]+              → PayPal access token prefix
 *    sandbox- or live- client/secret  → defensive (PayPal IDs/secrets
 *                                       have no fixed prefix but can
 *                                       be lengthy alphanumerics)
 */
function redactSecrets(s: string): string {
  return s
    .replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic [REDACTED]")
    .replace(/(access_token=)[^&\s"]+/g, "$1[REDACTED]")
    .replace(/("access_token"\s*:\s*")[^"]+(")/g, "$1[REDACTED]$2")
    .replace(/A21AA[A-Za-z0-9_-]{10,}/g, "A21AA[REDACTED]")
    .replace(/("client_secret"\s*:\s*")[^"]+(")/g, "$1[REDACTED]$2")
    .replace(/("client_id"\s*:\s*")[^"]+(")/g, "$1[REDACTED]$2");
}

function errorMessage(err: unknown): string {
  const e = err as { message?: string };
  const m = e?.message ?? String(err);
  return redactSecrets(m).slice(0, 500);
}

// ─── Adapter export ────────────────────────────────────────────────────

export const paypalAdapter: PaymentProvider = {
  id: "paypal",
  validateCredentials,
  createCheckout,
  verifyWebhook,
  refund,
};
