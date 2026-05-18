/**
 * Waitlist enqueue (idempotent).
 *
 * If the customer already has an active queue entry (waiting OR
 * notified) for this (tenant, service), the existing row is returned
 * unchanged — re-joining doesn't bump anyone's queue position. The
 * partial unique index `waitlists_active_customer_unique` enforces
 * this at the DB level; we handle the 23505 race gracefully.
 *
 * Position estimate: count waiting entries with same/higher priority
 * created before this one. NOT a guarantee — just a UX hint. Skipped
 * customers and time-range mismatches mean actual notification order
 * may differ.
 */
import { and, asc, count, eq, lte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { services, waitlists } from "@/db/schema";

import type { WaitlistTimeRange } from "./types";

export type EnqueueInput = {
  tenantId: string;
  serviceId: string;
  locationId?: string | null;
  customerEmail: string;
  customerName: string;
  customerPhone?: string | null;
  preferredDate?: string | null; // "YYYY-MM-DD"
  preferredTimeRange?: WaitlistTimeRange;
};

export type EnqueueResult =
  | { ok: true; waitlistId: string; queuePosition: number; alreadyOnWaitlist: boolean }
  | { ok: false; reason: string };

export async function enqueueWaitlist(input: EnqueueInput): Promise<EnqueueResult> {
  try {
    // Service belongs to this tenant — guards against cross-tenant
    // serviceId injection via the public API.
    const svc = await db.query.services.findFirst({
      where: and(eq(services.id, input.serviceId), eq(services.tenantId, input.tenantId)),
    });
    if (!svc || svc.isActive !== 1) return { ok: false, reason: "service_not_found" };

    // If an active entry exists for this (tenant, service, email), return it.
    const existing = await db.query.waitlists.findFirst({
      where: and(
        eq(waitlists.tenantId, input.tenantId),
        eq(waitlists.serviceId, input.serviceId),
        sql`lower(${waitlists.customerEmail}) = lower(${input.customerEmail})`,
        sql`${waitlists.status} IN ('waiting','notified')`
      ),
    });

    if (existing) {
      const position = await estimatePosition(existing.id, input.tenantId, input.serviceId);
      return {
        ok: true,
        waitlistId: existing.id,
        queuePosition: position,
        alreadyOnWaitlist: true,
      };
    }

    // Fresh entry.
    let row: typeof waitlists.$inferSelect;
    try {
      [row] = await db
        .insert(waitlists)
        .values({
          tenantId: input.tenantId,
          serviceId: input.serviceId,
          locationId: input.locationId ?? null,
          customerEmail: input.customerEmail,
          customerName: input.customerName,
          customerPhone: input.customerPhone ?? null,
          preferredDate: input.preferredDate ?? null,
          preferredTimeRange: input.preferredTimeRange ?? "any",
          status: "waiting",
        })
        .returning();
    } catch (e: unknown) {
      // 23505 = partial unique index hit. Race: another join landed
      // first. Re-read and return.
      if ((e as { code?: string })?.code === "23505") {
        const raced = await db.query.waitlists.findFirst({
          where: and(
            eq(waitlists.tenantId, input.tenantId),
            eq(waitlists.serviceId, input.serviceId),
            sql`lower(${waitlists.customerEmail}) = lower(${input.customerEmail})`,
            sql`${waitlists.status} IN ('waiting','notified')`
          ),
        });
        if (raced) {
          const position = await estimatePosition(raced.id, input.tenantId, input.serviceId);
          return {
            ok: true,
            waitlistId: raced.id,
            queuePosition: position,
            alreadyOnWaitlist: true,
          };
        }
      }
      console.error("[waitlists] enqueue failed:", e);
      return { ok: false, reason: "insert_failed" };
    }

    const position = await estimatePosition(row.id, input.tenantId, input.serviceId);
    return { ok: true, waitlistId: row.id, queuePosition: position, alreadyOnWaitlist: false };
  } catch (e) {
    console.error("[waitlists] enqueue orchestrator error:", e);
    return { ok: false, reason: "orchestrator_error" };
  }
}

async function estimatePosition(
  waitlistId: string,
  tenantId: string,
  serviceId: string
): Promise<number> {
  // Position = 1 + count of WAITING entries with strictly-better
  // priority OR equal priority + earlier createdAt.
  // We resolve the row's own (priority, createdAt) first.
  const self = await db.query.waitlists.findFirst({
    where: eq(waitlists.id, waitlistId),
  });
  if (!self) return 1;

  const ahead = await db
    .select({ value: count() })
    .from(waitlists)
    .where(
      and(
        eq(waitlists.tenantId, tenantId),
        eq(waitlists.serviceId, serviceId),
        eq(waitlists.status, "waiting"),
        sql`(${waitlists.priority} > ${self.priority}
             OR (${waitlists.priority} = ${self.priority} AND ${waitlists.createdAt} < ${self.createdAt}))`
      )
    );
  return (ahead[0]?.value ?? 0) + 1;
}

// `asc` / `lte` reserved for future ordered-fetch helpers.
void asc;
void lte;
