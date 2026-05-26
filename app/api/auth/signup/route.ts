import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import {
  createToken,
  errorResponse,
  hashPassword,
  HttpError,
  setSessionCookie,
} from "@/lib/auth";
import { signupSchema } from "@/lib/validation";
import { generateUniqueSlug, getTenantBySlug } from "@/lib/tenant";
import { assertCanAddStaff } from "@/lib/quotas";
import { rateLimit } from "@/lib/rate-limit";
import { ipFromHeaders } from "@/lib/audit";
import { adminNotify } from "@/lib/admin-notify";

export async function POST(req: NextRequest) {
  try {
    const ip = ipFromHeaders(req.headers) ?? "anon";
    const rl = rateLimit({ key: `signup:${ip}`, capacity: 5, refillTokens: 5, windowMs: 60_000 });
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many signups from this IP — slow down." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }
    const body = signupSchema.parse(await req.json());

    // Resolve tenant: admin creates one, staff/client must join one.
    let tenantId: string;

    if (body.role === "admin") {
      const workspaceName =
        body.workspaceName?.trim() ||
        // fallback so the form still works if the UI forgets to send it
        `${body.name}'s workspace`;
      const slug = await generateUniqueSlug(workspaceName);

      const [tenant] = await db
        .insert(tenants)
        .values({ name: workspaceName, slug, plan: "free", active: true })
        .returning();
      tenantId = tenant.id;

      // Phase 3 — admin alert on new tenant signup. Info severity:
      // a healthy product signal, not an incident. Dedupe key uses
      // tenant.id so duplicate POSTs (network retries) collapse.
      // Fire-and-forget; the signup response is unaffected.
      void adminNotify({
        kind: "new_tenant_signup",
        severity: "info",
        summary: `New workspace: ${workspaceName}`,
        tenantId: tenant.id,
        tenantLabel: workspaceName,
        dedupeKey: `new_tenant_signup::${tenant.id}`,
        metadata: {
          slug,
          adminEmail: body.email,
          adminName: body.name,
          timezone: body.timezone,
        },
      });
    } else {
      if (!body.tenantSlug) {
        throw new HttpError(400, "tenantSlug is required for staff/client signup");
      }
      const tenant = await getTenantBySlug(body.tenantSlug);
      if (!tenant || !tenant.active) {
        throw new HttpError(404, "Workspace not found");
      }
      tenantId = tenant.id;

      // Plan quota: refuse new staff seats over the limit.
      if (body.role === "staff") {
        await assertCanAddStaff(tenantId);
      }
    }

    // Email is unique per tenant (not globally).
    const existing = await db.query.users.findFirst({
      where: and(eq(users.tenantId, tenantId), eq(users.email, body.email)),
    });
    if (existing) {
      throw new HttpError(409, "Email already registered in this workspace");
    }

    const [row] = await db
      .insert(users)
      .values({
        tenantId,
        email: body.email,
        passwordHash: await hashPassword(body.password),
        name: body.name,
        role: body.role,
        timezone: body.timezone,
      })
      .returning();

    const token = await createToken({
      sub: row.id,
      role: row.role,
      email: row.email,
      tenantId: row.tenantId,
    });
    await setSessionCookie(token);

    return NextResponse.json({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      timezone: row.timezone,
      tenantId: row.tenantId,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
