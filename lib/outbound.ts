/**
 * Outbound notification webhooks. Slack-compatible payload (the simplest
 * Slack incoming-webhook accepts `{ text }`). Fire-and-forget — failures
 * are logged but never propagate to the caller. Booking flows must keep
 * working even if the webhook URL is wrong.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { loadTenantFeatures } from "@/lib/features";

const TIMEOUT_MS = 5000;

export async function postTenantWebhook(args: {
  tenantId: string;
  text: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    // Phase 16: tenant-level `webhookDelivery` gate. When OFF, the
    // outbound POST is skipped entirely — the configured URL is left
    // intact so re-enabling the toggle resumes delivery immediately.
    // Failure mode is identical to "no URL configured": silent return.
    const features = await loadTenantFeatures(args.tenantId);
    if (!features.webhookDelivery) return;

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, args.tenantId) });
    const url = tenant?.notificationWebhookUrl;
    if (!url) return;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: args.text, ...args.metadata }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  } catch (err) {
    console.error("[outbound:webhook] failed:", err);
  }
}
