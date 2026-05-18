import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { customers, tenants } from "@/db/schema";
import {
  signClientSession,
  setClientSessionCookie,
  verifyClientMagicLink,
} from "@/lib/client-auth";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/auth";

// GET /api/client/[slug]/auth/verify?token=...
//
// Consumes a magic-link token. On success: sets the client session
// cookie and redirects to /client/[slug]. On failure: redirects to the
// login page with ?invalid=1 so the form can show a banner.
//
// This is a Route Handler (not a page) because Next.js 15 only allows
// cookie writes from Server Actions or Route Handlers.

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    const token = (req.nextUrl.searchParams.get("token") ?? "").trim();

    const failLoginUrl = new URL(`/client/${encodeURIComponent(slug)}/login`, req.nextUrl.origin);
    failLoginUrl.searchParams.set("invalid", "1");

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
    if (!tenant || !tenant.active) {
      return NextResponse.redirect(failLoginUrl);
    }
    if (!token) {
      return NextResponse.redirect(failLoginUrl);
    }

    const payload = await verifyClientMagicLink(token);
    if (!payload || payload.tenantId !== tenant.id) {
      return NextResponse.redirect(failLoginUrl);
    }

    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.tenantId, tenant.id),
        sql`lower(${customers.email}) = ${payload.email.toLowerCase()}`
      ),
    });
    if (!customer) {
      return NextResponse.redirect(failLoginUrl);
    }

    const sessionToken = await signClientSession({
      email: customer.email,
      tenantId: tenant.id,
      customerId: customer.id,
    });
    await setClientSessionCookie(sessionToken);

    audit({
      tenantId: tenant.id,
      action: "client.session.start",
      entityType: "customer",
      entityId: customer.id,
      metadata: { email: customer.email },
    });

    const dest = new URL(`/client/${encodeURIComponent(slug)}`, req.nextUrl.origin);
    return NextResponse.redirect(dest);
  } catch (err) {
    return errorResponse(err);
  }
}
