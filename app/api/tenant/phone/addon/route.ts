import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { audit, ipFromHeaders } from "@/lib/audit";
import { getStripe, isStripeConfigured, businessPhoneAddonPriceId } from "@/lib/stripe";
import { planAddonAction, isBusinessPhoneAddonPrice } from "@/lib/business-phone-addon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tenant/phone/addon — add or remove the Business Phone add-on
 * ($29/mo, 1,000 US/CA minutes) on the tenant's EXISTING Stripe subscription.
 *
 * The add-on is a second LINE ITEM on the base subscription (not a separate
 * subscription). This route performs ONLY the Stripe mutation; ENTITLEMENT IS
 * SYNCED BY THE WEBHOOK (customer.subscription.updated → Phase 1), which writes
 * tenant_phone_settings.metadata. We never write entitlement here — Stripe stays
 * the single source of truth. Buying the add-on does NOT provision a phone
 * number: a tenant with the add-on but no assigned number is "setup pending"
 * until an operator provisions one (Phase 3). This is NOT a softphone (Phase 2
 * coming soon); current calling is inbound forwarding + click-to-call bridge.
 *
 * TENANT ADMIN ONLY (mirrors the checkout/billing routes). Fully fail-closed:
 *   - 503 when Stripe or the add-on price (STRIPE_PRICE_BUSINESS_PHONE_MONTH) is
 *     unconfigured — NO Stripe call is made (feature stays dark).
 *   - 409 on "add" when the tenant has no modifiable base subscription
 *     ("Subscribe to a base plan first.").
 *   - idempotent — adding an existing add-on / removing an absent one is a no-op
 *     success.
 *   - "remove" deletes ONLY the add-on line item, never the base plan; never
 *     touches phone numbers, call logs, or Telnyx.
 */

const bodySchema = z.object({ action: z.enum(["add", "remove"]) });

export async function POST(req: NextRequest) {
  try {
    const user = await requireRole(["admin"]);
    const { action } = bodySchema.parse(await req.json());

    // Dark / unconfigured → fail BEFORE any Stripe API call.
    const addonPriceId = businessPhoneAddonPriceId();
    if (!isStripeConfigured() || !addonPriceId) {
      throw new HttpError(503, "The Business Phone add-on isn't available yet.");
    }

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, user.tenantId),
      columns: { id: true, stripeSubscriptionId: true, subscriptionStatus: true },
    });
    if (!tenant) throw new HttpError(404, "Tenant not found.");

    // Fetch live subscription items ONLY when a subscription exists. With no
    // subscription we never hit the Stripe API: add → 409, remove → no-op success.
    const stripe = await getStripe();
    let subscriptionId = tenant.stripeSubscriptionId ?? null;
    let liveStatus: string | null | undefined = tenant.subscriptionStatus;
    let items: Array<{ id: string; priceId: string | null | undefined }> = [];
    if (subscriptionId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      subscriptionId = sub.id;
      liveStatus = sub.status;
      items = (sub.items?.data ?? []).map((it) => ({ id: it.id, priceId: it.price?.id ?? null }));
    }

    const plan = planAddonAction({
      action,
      addonPriceId,
      subscriptionId,
      subscriptionStatus: liveStatus,
      items,
      isAddonPrice: isBusinessPhoneAddonPrice,
    });

    let result: "added" | "removed" | "already_present" | "already_absent";
    switch (plan.kind) {
      case "disabled":
        // Defensive — already guarded above; never reached with a configured price.
        throw new HttpError(503, "The Business Phone add-on isn't available yet.");
      case "no_subscription":
        throw new HttpError(409, "Subscribe to a base plan first.");
      case "already_present":
        result = "already_present";
        break;
      case "already_absent":
        result = "already_absent";
        break;
      case "add":
        // Add the add-on as a NEW item; the base plan item is untouched. No
        // surprise mid-cycle charge — billing starts next cycle.
        await stripe.subscriptionItems.create({
          subscription: plan.subscriptionId,
          price: plan.priceId,
          quantity: 1,
          proration_behavior: "none",
        });
        result = "added";
        break;
      case "remove":
        // Delete ONLY the add-on line item (the base plan item is left intact).
        await stripe.subscriptionItems.del(plan.subscriptionItemId, {
          proration_behavior: "none",
        });
        result = "removed";
        break;
    }

    audit({
      tenantId: tenant.id,
      action: action === "add" ? "business_phone.addon_added" : "business_phone.addon_removed",
      actorUserId: user.id,
      actorLabel: user.email,
      entityType: "business_phone_addon",
      entityId: tenant.id,
      metadata: { action, result },
      ipAddress: ipFromHeaders(req.headers),
    });

    // NOTE: entitlement is intentionally NOT written here — the resulting
    // customer.subscription.updated webhook syncs tenant_phone_settings.metadata.
    return NextResponse.json({ ok: true, action, addon: result });
  } catch (err) {
    return errorResponse(err);
  }
}
