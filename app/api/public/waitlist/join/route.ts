import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, HttpError } from "@/lib/auth";
import { enqueueWaitlist } from "@/lib/waitlists/enqueue";
import { WAITLIST_TIME_RANGES, type WaitlistTimeRange } from "@/lib/waitlists/types";
import { ipFromHeaders } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";

const schema = z.object({
  serviceId: z.string().uuid(),
  customerEmail: z.string().email(),
  customerName: z.string().min(1).max(120),
  customerPhone: z.string().max(40).optional(),
  preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  preferredTimeRange: z
    .enum(WAITLIST_TIME_RANGES as unknown as [WaitlistTimeRange, ...WaitlistTimeRange[]])
    .optional(),
});

// POST /api/public/waitlist/join
//
// Public — anyone can join a waitlist. We derive tenantId from the
// serviceId server-side (the enqueue helper validates the service
// belongs to its tenant). Rate-limited by IP to deter abuse.
//
// The response is intentionally vague about queue size (rule:
// "DO NOT expose internal queue metrics") — only the position
// estimate for THIS customer is returned.
export async function POST(req: NextRequest) {
  try {
    const ip = ipFromHeaders(req.headers) ?? "anon";
    const rl = rateLimit({ key: `waitlist:${ip}`, capacity: 10, refillTokens: 10, windowMs: 60_000 });
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many requests — please slow down." },
        { status: 429 }
      );
    }

    const body = schema.parse(await req.json());

    // Resolve tenant from service. The enqueue helper re-checks but we
    // need the tenantId before that — load the service first.
    const { db } = await import("@/db/client");
    const { services } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const service = await db.query.services.findFirst({
      where: eq(services.id, body.serviceId),
    });
    if (!service || service.isActive !== 1) {
      throw new HttpError(404, "Service not found");
    }

    const result = await enqueueWaitlist({
      tenantId: service.tenantId,
      serviceId: body.serviceId,
      customerEmail: body.customerEmail,
      customerName: body.customerName,
      customerPhone: body.customerPhone ?? null,
      preferredDate: body.preferredDate ?? null,
      preferredTimeRange: body.preferredTimeRange ?? "any",
    });

    if (!result.ok) {
      throw new HttpError(400, result.reason === "service_not_found" ? "Service not found" : "Could not join waitlist");
    }

    return NextResponse.json({
      ok: true,
      queuePosition: result.queuePosition,
      alreadyOnWaitlist: result.alreadyOnWaitlist,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
