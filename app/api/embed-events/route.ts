import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { embedEvents, services, tenants } from "@/db/schema";
import { rateLimit } from "@/lib/rate-limit";
import { ipFromHeaders } from "@/lib/audit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  slug: z.string().min(1).max(80),
  serviceSlug: z.string().min(1).max(80).optional(),
  kind: z.enum(["embed.load", "embed.book_start", "embed.book_success"]),
});

// Public, anonymous event endpoint. Rate-limited per IP to prevent flooding.
export async function POST(req: NextRequest) {
  try {
    const ip = ipFromHeaders(req.headers) ?? "anon";
    const rl = rateLimit({ key: `embed:${ip}`, capacity: 200, refillTokens: 200, windowMs: 60_000 });
    if (!rl.ok) return NextResponse.json({ ok: false }, { status: 429 });

    const body = bodySchema.parse(await req.json());
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, body.slug) });
    if (!tenant) return NextResponse.json({ ok: true }); // swallow unknown tenants

    let serviceId: string | null = null;
    if (body.serviceSlug) {
      const svc = await db.query.services.findFirst({
        where: and(eq(services.tenantId, tenant.id), eq(services.slug, body.serviceSlug)),
      });
      serviceId = svc?.id ?? null;
    }

    await db.insert(embedEvents).values({
      tenantId: tenant.id,
      serviceId,
      kind: body.kind,
      referer: req.headers.get("referer"),
      ip,
      userAgent: req.headers.get("user-agent"),
    });

    return NextResponse.json({ ok: true });
  } catch {
    // Tracking failures must never break embeds.
    return NextResponse.json({ ok: false });
  }
}
