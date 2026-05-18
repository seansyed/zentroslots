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

    // We use relative Location headers so the redirect target follows
    // the browser's current host. `NextResponse.redirect()` would force
    // us to construct an absolute URL, which behind a reverse proxy
    // resolves to the upstream localhost. Per RFC 7231 the Location
    // header can be a relative reference.
    const failLogin = `/client/${encodeURIComponent(slug)}/login?invalid=1`;
    const home = `/client/${encodeURIComponent(slug)}`;
    const redirectTo = (path: string) =>
      new NextResponse(null, { status: 307, headers: { Location: path } });

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
    if (!tenant || !tenant.active) {
      return redirectTo(failLogin);
    }
    if (!token) {
      return redirectTo(failLogin);
    }

    const payload = await verifyClientMagicLink(token);
    if (!payload || payload.tenantId !== tenant.id) {
      return redirectTo(failLogin);
    }

    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.tenantId, tenant.id),
        sql`lower(${customers.email}) = ${payload.email.toLowerCase()}`
      ),
    });
    if (!customer) {
      return redirectTo(failLogin);
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

    return redirectTo(home);
  } catch (err) {
    return errorResponse(err);
  }
}
