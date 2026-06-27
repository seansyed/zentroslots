import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, tenants, tenantPhoneSettings } from "@/db/schema";
import { getStripe, isStripeConfigured, pickPlanFromPriceIds } from "@/lib/stripe";
import {
  resolveAddonEntitlement,
  shouldStripeWriteEntitlement,
  readEntitlementSource,
  isBusinessPhoneAddonPrice,
} from "@/lib/business-phone-addon";
import { recordBillingEvent } from "@/lib/billing/recordBillingEvent";
import {
  autoRefundCharge,
  confirmPendingPaymentBooking,
  markBookingPaymentFailed,
  markBookingRefunded,
} from "@/lib/billing/paymentLifecycle";
import { runPostConfirmationHooks } from "@/lib/billing/postBookingHooks";
import { tryClaimStripeEvent } from "@/lib/billing/webhookIdempotency";
import { applyTenantBillingMutation } from "@/lib/billing/planTransitions";
import { adminNotify } from "@/lib/admin-notify";
import { PLAN_RANK, type PlanId } from "@/lib/plans";

// Use Node runtime so we can read the raw body for signature verification.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 16B / Phase 1 add-on — delegated to lib/stripe.ts so the mapping stays
// in sync with the plan catalog. A subscription may carry MULTIPLE line items
// (base plan + the Business Phone add-on), so we scan ALL item price ids for the
// first that maps to a plan tier rather than assuming items[0]. When no item
// maps to a known plan, this returns null and the webhook leaves
// `tenants.currentPlan` UNCHANGED — never clobbers with a wrong value or `free`.
function planLabelFromItems(priceIds: Array<string | null | undefined>): string | null {
  return pickPlanFromPriceIds(priceIds)?.plan ?? null;
}

/**
 * Phase 1 — sync the BILLING-DRIVEN Business Phone add-on entitlement into
 * `tenant_phone_settings.metadata` (no schema change, no entitlement-reader
 * change). Writes ONLY the entitlement flag derived from the subscription's
 * line items + status. NEVER overwrites a MANUAL pilot grant (docs-demo).
 * Idempotent — sets the flag to the computed value, so re-delivered events are
 * harmless. Wrapped in try/catch so add-on sync can never break the core
 * billing webhook. While STRIPE_PRICE_BUSINESS_PHONE_MONTH is unset,
 * isBusinessPhoneAddonPrice() is always false ⇒ subscribed=false ⇒ no row is
 * ever created and the feature stays fully dark.
 */
async function syncBusinessPhoneAddon(args: {
  tenantId: string;
  priceIds: Array<string | null | undefined>;
  subscriptionStatus: string | null | undefined;
}): Promise<void> {
  try {
    const settings = await db.query.tenantPhoneSettings.findFirst({
      where: eq(tenantPhoneSettings.tenantId, args.tenantId),
      columns: { id: true, metadata: true },
    });
    // Manual pilot/comp grants are operator-owned — billing logic never touches.
    if (!shouldStripeWriteEntitlement(readEntitlementSource(settings?.metadata))) return;

    const { subscribed, active } = resolveAddonEntitlement({
      items: args.priceIds.map((priceId) => ({ priceId })),
      subscriptionStatus: args.subscriptionStatus,
      isAddonPrice: isBusinessPhoneAddonPrice,
    });

    // No settings row yet AND not subscribed → nothing to do (don't spawn rows
    // for every unrelated subscription event).
    if (!settings && !subscribed) return;

    const baseMeta =
      settings?.metadata && typeof settings.metadata === "object" && !Array.isArray(settings.metadata)
        ? (settings.metadata as Record<string, unknown>)
        : {};
    const nextMeta = {
      ...baseMeta,
      entitlementActive: active,
      entitlementSource: "stripe",
      businessPhoneAddon: {
        subscribed,
        subscriptionStatus: args.subscriptionStatus ?? null,
      },
    };

    if (settings) {
      await db
        .update(tenantPhoneSettings)
        .set({ metadata: nextMeta, updatedAt: new Date() })
        .where(eq(tenantPhoneSettings.tenantId, args.tenantId));
    } else {
      await db
        .insert(tenantPhoneSettings)
        .values({
          tenantId: args.tenantId,
          enabled: true,
          metadata: nextMeta,
        } as typeof tenantPhoneSettings.$inferInsert)
        .onConflictDoNothing({ target: tenantPhoneSettings.tenantId });
    }
  } catch (err) {
    console.error(
      "[stripe-webhook] business phone add-on sync failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

export async function POST(req: NextRequest) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Missing STRIPE_WEBHOOK_SECRET" }, { status: 500 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });

  const stripe = await getStripe();
  const raw = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    // Phase 3 — alert ops on signature failures. Throttled per
    // hour so a brute-force replay doesn't flood the inbox; we
    // only need to see ONE per window to know something's wrong.
    // Fire-and-forget; never blocks the 400 response.
    void adminNotify({
      kind: "stripe_webhook_error",
      severity: "warning",
      summary: "Stripe webhook signature verification failed",
      details: err instanceof Error ? err.message.slice(0, 500) : "unknown",
      metadata: {
        ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
        userAgent: req.headers.get("user-agent")?.slice(0, 80) ?? "unknown",
      },
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // ─── Webhook idempotency claim (Phase 4 hardening) ──────────────
  // Stripe retries failed deliveries for up to 3 days. The signature
  // stays valid across retries, so a duplicate event would re-execute
  // the tenants.update and emit a duplicate transition audit if we
  // don't dedupe. INSERT ... ON CONFLICT DO NOTHING is the atomic
  // primitive — concurrent workers cannot both report `fresh=true`.
  //
  // The billing_transactions ledger has its OWN dedup on
  // stripe_event_id (23505 swallow) — that's belt-and-braces for
  // financial events. This claim is the canonical webhook gate.
  const eventTenantId = extractTenantIdFromEvent(event);
  const claim = await tryClaimStripeEvent({
    eventId: event.id,
    eventType: event.type,
    tenantId: eventTenantId,
  });
  if (!claim.fresh) {
    // Duplicate replay — return 200 immediately, skip processing
    // entirely. Stripe stops retrying after seeing 2xx.
    console.log(`[stripe-webhook] duplicate event ${event.id} (${event.type}) — skipped`);
    return NextResponse.json({ received: true, duplicate: true });
  }

  // ─── Billing ledger (additive) ──────────────────────────────────────
  // Recording is invoked BEFORE the existing switch so retries land
  // even if a downstream handler errors. The helper NEVER throws —
  // it returns a structured result and logs internally. Existing
  // handler behavior below is preserved exactly.
  try {
    const result = await recordBillingEvent(event);
    if (!result.ok) {
      console.warn(`[billing] event ${event.id} not recorded:`, result.reason);
    }
  } catch (ledgerErr) {
    // Defense-in-depth — record helper already wraps everything but
    // we double-guard here. Webhook MUST not 500 due to ledger writes.
    console.error("[billing] ledger crashed (webhook unaffected):", ledgerErr);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        // ── Paid-booking branch (0030, additive). Discriminate on
        //    metadata.kind = 'booking_payment'. SUBSCRIPTION flow
        //    below stays byte-identical for kind !== 'booking_payment'.
        const kind = (session.metadata?.kind as string | undefined) ?? null;
        if (kind === "booking_payment") {
          const bookingId = (session.metadata?.booking_id as string | undefined) ?? null;
          const bookingTenantId = (session.metadata?.tenant_id as string | undefined) ?? null;
          if (bookingId && bookingTenantId) {
            const paymentIntentId =
              typeof session.payment_intent === "string" ? session.payment_intent : null;
            const amountCents = Number(session.amount_total ?? 0);
            const confirmResult = await confirmPendingPaymentBooking({
              bookingId,
              tenantId: bookingTenantId,
              stripeSessionId: session.id,
              stripePaymentIntentId: paymentIntentId,
              amountChargedCents: amountCents,
            });
            if (confirmResult.ok) {
              // Fire the post-confirmation hooks (calendar, email, etc.).
              await runPostConfirmationHooks({
                bookingId,
                tenantId: bookingTenantId,
              });
            } else if (confirmResult.reason === "slot_taken" && paymentIntentId) {
              // EXCLUDE race: a confirmed booking sneaked in during
              // the payment window. Auto-refund + the lifecycle
              // helper already marked our booking as payment_failed.
              await autoRefundCharge({
                paymentIntentId,
                reason: "slot_taken_during_payment",
              });
            }
            // Other failure reasons (wrong_state, not_found) are
            // logged inside the helper; webhook returns 200 either
            // way so Stripe doesn't retry.
          }
          break;
        }

        // ── SUBSCRIPTION branch (Phase 16B hardening) ──
        // Recognize ALL 4 paid tiers in metadata. If the value is
        // missing or unrecognized, we still record the customer +
        // subscription IDs and mark the subscription active, but
        // we LEAVE `currentPlan` untouched — the subsequent
        // `customer.subscription.updated` event (which we always
        // get for a fresh sub) will derive the plan from the actual
        // price ID via planFromStripePriceId(). This protects
        // against any direct-Stripe-API checkouts that don't carry
        // our metadata.
        const tenantId = (session.metadata?.tenantId as string | undefined) ?? null;
        const planFromMeta = (session.metadata?.plan as string | undefined) ?? null;
        const validPlans = ["solo", "pro", "team", "enterprise"] as const;
        const recognizedPlan: (typeof validPlans)[number] | null =
          planFromMeta && (validPlans as readonly string[]).includes(planFromMeta)
            ? (planFromMeta as (typeof validPlans)[number])
            : null;
        if (tenantId) {
          // Transition-observed mutation — emits billing.plan_transition
          // + billing.upgrade_applied audits when the plan actually
          // changes. Read-before/read-after happens inside the helper.
          await applyTenantBillingMutation({
            tenantId,
            ctx: { stripeEventId: event.id, stripeEventType: event.type },
            mutation: async (tx) => {
              await tx
                .update(tenants)
                .set({
                  stripeCustomerId: (session.customer as string) ?? null,
                  stripeSubscriptionId: (session.subscription as string) ?? null,
                  subscriptionStatus: "active",
                  // Only set currentPlan when we recognize the metadata
                  // value. Drizzle skips `undefined` columns in the SET
                  // clause — so unknown plans leave the column alone.
                  currentPlan: recognizedPlan ?? undefined,
                  updatedAt: new Date(),
                })
                .where(eq(tenants.id, tenantId));
            },
          });
        }
        break;
      }

      case "payment_intent.payment_failed": {
        // ── Paid-booking failure (0030, additive). Find the booking
        //    by stripe_payment_intent_id OR by metadata.booking_id
        //    that we set on session creation.
        const pi = event.data.object;
        const piId = pi.id;
        const bookingId = (pi.metadata?.booking_id as string | undefined) ?? null;
        const bookingTenantId = (pi.metadata?.tenant_id as string | undefined) ?? null;
        let resolvedBookingId: string | null = bookingId;
        let resolvedTenantId: string | null = bookingTenantId;
        if (!resolvedBookingId && piId) {
          // Fallback: look up by stripe_payment_intent_id.
          const row = await db.query.bookings.findFirst({
            where: eq(bookings.stripePaymentIntentId, piId),
          });
          if (row) {
            resolvedBookingId = row.id;
            resolvedTenantId = row.tenantId;
          }
        }
        if (resolvedBookingId && resolvedTenantId) {
          await markBookingPaymentFailed({
            bookingId: resolvedBookingId,
            tenantId: resolvedTenantId,
            reason: pi.last_payment_error?.message?.slice(0, 200) ?? "payment_failed",
          });
        }
        // Phase 3 — admin alert on payment failure. Dedupe key
        // includes the bookingId so duplicate webhook deliveries
        // don't double-alert. Severity = warning (recoverable —
        // customer can retry checkout) rather than critical.
        void adminNotify({
          kind: "payment_failed",
          severity: "warning",
          summary: "Stripe payment_intent.payment_failed",
          details: pi.last_payment_error?.message?.slice(0, 500) ?? undefined,
          tenantId: resolvedTenantId ?? undefined,
          dedupeKey: `payment_failed::${resolvedBookingId ?? piId}`,
          metadata: {
            bookingId: resolvedBookingId ?? undefined,
            paymentIntentId: piId,
            errorCode: pi.last_payment_error?.code ?? undefined,
            declineCode: pi.last_payment_error?.decline_code ?? undefined,
          },
        });
        break;
      }

      case "charge.refunded": {
        // ── Full or partial refund sync (0030, additive). Stripe
        //    charge.refunded fires on EVERY refund including partials.
        //    We discriminate by amount_refunded vs amount on the charge.
        const charge = event.data.object;
        const piId =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : charge.payment_intent?.id ?? null;
        if (piId) {
          const row = await db.query.bookings.findFirst({
            where: eq(bookings.stripePaymentIntentId, piId),
          });
          if (row) {
            const isFullRefund = (charge.amount_refunded ?? 0) >= (charge.amount ?? 0);
            await markBookingRefunded({
              bookingId: row.id,
              tenantId: row.tenantId,
              refundedAmountCents: charge.amount_refunded ?? 0,
              isFullRefund,
              // Most recent refund id when available.
              refundId: charge.refunds?.data?.[0]?.id ?? undefined,
            });
          }
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const sub = event.data.object;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        // Scan ALL line items — a subscription may carry the base plan AND the
        // Business Phone add-on, so we must not assume items[0] is the plan.
        const itemPriceIds = (sub.items?.data ?? []).map((it) => it?.price?.id ?? null);
        const priceId = itemPriceIds[0] ?? undefined; // primary item (admin-notify metadata only)
        const planLabel = planLabelFromItems(itemPriceIds);
        const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;

        // Resolve tenant by customer id BEFORE the mutation so the
        // transition helper can read the before-state correctly.
        // Defensive: if no tenant has this customer id yet (rare
        // out-of-order delivery where subscription.* arrives before
        // checkout.session.completed), skip the audit emission but
        // still attempt the update — it'll be a no-op WHERE-clause
        // miss and the next event will retry.
        const tenantRow = await db.query.tenants.findFirst({
          where: eq(tenants.stripeCustomerId, customerId),
          // currentPlan = the tenant's PRE-mutation plan (read before
          // applyTenantBillingMutation), needed to classify the change as
          // an upgrade vs downgrade below.
          columns: { id: true, currentPlan: true },
        });
        if (!tenantRow) {
          console.warn(`[stripe-webhook] ${event.type} for customer ${customerId} — no tenant match yet; deferring`);
          // Don't return — fall through to the bare update so we
          // don't accidentally swallow late-arriving events. The
          // WHERE clause will match zero rows and that's fine.
          await db
            .update(tenants)
            .set({
              stripeSubscriptionId: sub.id,
              subscriptionStatus: sub.status,
              currentPlan: planLabel ?? undefined,
              trialEnd,
              updatedAt: new Date(),
            })
            .where(eq(tenants.stripeCustomerId, customerId));
          break;
        }

        await applyTenantBillingMutation({
          tenantId: tenantRow.id,
          ctx: { stripeEventId: event.id, stripeEventType: event.type },
          mutation: async (tx) => {
            await tx
              .update(tenants)
              .set({
                stripeSubscriptionId: sub.id,
                subscriptionStatus: sub.status,
                currentPlan: planLabel ?? undefined,
                trialEnd,
                updatedAt: new Date(),
              })
              .where(eq(tenants.id, tenantRow.id));
          },
        });
        // Phase 1 — sync the billing-driven Business Phone add-on entitlement
        // (no-op while the add-on price is unset; never touches manual pilots).
        await syncBusinessPhoneAddon({
          tenantId: tenantRow.id,
          priceIds: itemPriceIds,
          subscriptionStatus: sub.status,
        });
        // Phase 3 — admin alert on new + updated subscriptions. We
        // discriminate "new" vs "updated" using the event.type. The
        // dedupeKey is keyed by stripe event id so the same event
        // arriving twice never double-alerts (idempotency clause
        // upstream already short-circuits, but defense in depth).
        if (event.type === "customer.subscription.created") {
          void adminNotify({
            kind: "new_subscription",
            severity: "info",
            summary: `New subscription: ${planLabel ?? "unknown plan"}`,
            tenantId: tenantRow.id,
            dedupeKey: `new_subscription::${event.id}`,
            metadata: {
              plan: planLabel ?? "unrecognized",
              subscriptionStatus: sub.status,
              trialEnd: trialEnd?.toISOString() ?? undefined,
              priceId,
            },
          });
          if (trialEnd && trialEnd.getTime() > Date.now()) {
            void adminNotify({
              kind: "trial_started",
              severity: "info",
              summary: `Trial started for ${planLabel ?? "plan"}`,
              tenantId: tenantRow.id,
              dedupeKey: `trial_started::${event.id}`,
              metadata: { plan: planLabel, trialEnd: trialEnd.toISOString() },
            });
          }
        } else if (event.type === "customer.subscription.updated") {
          // Owner upgrade/downgrade email. Compare the tenant's PRE-mutation
          // plan rank (tenantRow was read above, before
          // applyTenantBillingMutation) against the NEW plan's rank. Fire
          // ONLY when both plans resolve to a known tier AND the rank actually
          // changed — status-only updates (trialing→active, renewals, payment
          // method swaps, quantity changes) keep the same plan and must NOT
          // alert. dedupeKey is keyed by the stripe event id so a redelivered
          // event never double-emails (the upstream idempotency claim already
          // short-circuits; this is defense in depth).
          const rankOf = (p: string | null | undefined): number | null =>
            p && p in PLAN_RANK ? PLAN_RANK[p as PlanId] : null;
          const oldRank = rankOf(tenantRow.currentPlan);
          const newRank = rankOf(planLabel);
          if (oldRank !== null && newRank !== null && newRank !== oldRank) {
            const isUpgrade = newRank > oldRank;
            void adminNotify({
              kind: isUpgrade ? "plan_upgrade" : "plan_downgrade",
              severity: "info",
              summary: `Plan ${isUpgrade ? "upgrade" : "downgrade"}: ${tenantRow.currentPlan} → ${planLabel}`,
              tenantId: tenantRow.id,
              dedupeKey: `${isUpgrade ? "plan_upgrade" : "plan_downgrade"}::${event.id}`,
              metadata: {
                from: tenantRow.currentPlan,
                to: planLabel,
                subscriptionStatus: sub.status,
                priceId,
              },
            });
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        // .deleted is the canonical downgrade path — Pro/Team/etc → free.
        // Resolve tenant first so the helper emits billing.downgrade_applied
        // with the grandfathered inventory snapshot.
        const tenantRow = await db.query.tenants.findFirst({
          where: eq(tenants.stripeCustomerId, customerId),
          columns: { id: true },
        });
        if (!tenantRow) {
          // Defensive — same posture as the .updated branch above.
          await db
            .update(tenants)
            .set({
              stripeSubscriptionId: null,
              subscriptionStatus: "canceled",
              currentPlan: "free",
              updatedAt: new Date(),
            })
            .where(eq(tenants.stripeCustomerId, customerId));
          break;
        }
        await applyTenantBillingMutation({
          tenantId: tenantRow.id,
          ctx: { stripeEventId: event.id, stripeEventType: event.type },
          mutation: async (tx) => {
            await tx
              .update(tenants)
              .set({
                stripeSubscriptionId: null,
                subscriptionStatus: "canceled",
                currentPlan: "free",
                updatedAt: new Date(),
              })
              .where(eq(tenants.id, tenantRow.id));
          },
        });
        // Phase 1 — subscription gone ⇒ revoke the billing-driven add-on
        // entitlement (empty items + canceled ⇒ inactive). Manual pilots are
        // left untouched by the guard inside syncBusinessPhoneAddon.
        await syncBusinessPhoneAddon({
          tenantId: tenantRow.id,
          priceIds: [],
          subscriptionStatus: "canceled",
        });
        // Phase 3 — admin alert on cancellation. Warning severity:
        // not catastrophic (existing customer pause), but worth
        // surfacing so ops can reach out for retention if desired.
        void adminNotify({
          kind: "subscription_cancelled",
          severity: "warning",
          summary: "Subscription cancelled — tenant downgraded to free",
          tenantId: tenantRow.id,
          dedupeKey: `subscription_cancelled::${event.id}`,
          metadata: {
            stripeCustomerId: customerId,
            stripeSubscriptionId: sub.id,
          },
        });
        break;
      }

      default:
        // Ignore other events for MVP — Stripe is happy with a 200.
        break;
    }
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook handler error:", err);
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
}

/**
 * Best-effort tenant ID extraction for the dedup table's optional
 * scoping column. Used purely for audit-grep convenience ("show me
 * every Stripe event for tenant X"); when we can't resolve it we just
 * store null. NEVER blocks the dedup claim itself.
 *
 * Subscription / checkout events embed metadata.tenantId directly.
 * Charge / payment_intent events embed booking_id + tenant_id in
 * metadata. Other event types don't carry tenant identity until the
 * handler resolves them — we return null and the audit grep just
 * misses those rows, which is fine.
 */
function extractTenantIdFromEvent(event: { data: { object: unknown } }): string | null {
  const obj = event.data.object as { metadata?: Record<string, unknown> } | null | undefined;
  const meta = obj?.metadata;
  if (!meta) return null;
  const candidate =
    (typeof meta.tenantId === "string" && meta.tenantId) ||
    (typeof meta.tenant_id === "string" && meta.tenant_id) ||
    null;
  // Loose UUID shape check — defense against unrelated metadata keys.
  if (candidate && /^[0-9a-fA-F-]{36}$/.test(candidate)) return candidate;
  return null;
}
