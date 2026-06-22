import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { errorResponse, requireUser } from "@/lib/auth";
import { getTenantById } from "@/lib/tenant";
import { isGoogleConnected, isMicrosoftConnected } from "@/lib/calendar/connections";
import { db } from "@/db/client";
import { users } from "@/db/schema";

export async function GET() {
  try {
    const user = await requireUser();
    const tenant = await getTenantById(user.tenantId);

    // Wave A — source of truth migration. Previously this read the
    // plaintext `users.google_refresh_token` column, which we are
    // phasing out (migration 0044). The encrypted `calendar_connections`
    // table is now canonical; `isGoogleConnected` checks for an active
    // row there. We INTENTIONALLY don't merge the old flag — once
    // migration 0044 has run, every active user has a connection row,
    // and falling back would just re-introduce the plaintext dependency
    // we're removing.
    // Provider-aware calendar state. `googleConnected` is kept for
    // back-compat; `microsoftConnected` + the aggregate `calendarConnected`
    // are additive so the mobile app can show provider-neutral copy
    // ("Connect calendar" / hide the CTA when ANY provider is connected)
    // instead of a Google-only assumption.
    const [googleConnected, microsoftConnected] = await Promise.all([
      isGoogleConnected(user.id),
      isMicrosoftConnected(user.id),
    ]);
    const calendarConnected = googleConnected || microsoftConnected;

    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      timezone: user.timezone,
      // Phase 17I-5 — surface the staff's uploaded avatar URL so the
      // Topbar profile chip + Sidebar footer can display the real
      // profile picture instead of always falling back to initials.
      // Null when no avatar has been uploaded (initials path).
      avatarUrl: user.avatarUrl ?? null,
      googleConnected,
      microsoftConnected,
      calendarConnected,
      tenant: tenant
        ? {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            plan: tenant.plan,
            active: tenant.active,
            // Canonical BUSINESS timezone — mobile uses this (NOT the user's
            // personal profile tz) to request slots + interpret booking times,
            // so an operator books in the business's zone regardless of their
            // own profile/device tz. See lib/tenant-timezone.ts.
            timezone: tenant.timezone,
            // Additive (mobile branding): tenant-configured logo + brand
            // color. Relative logoUrl is absolutized client-side. Web
            // ignores unknown fields, so this is backward-compatible.
            logoUrl: tenant.logoUrl ?? null,
            primaryColor: tenant.primaryColor ?? null,
          }
        : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Phase 2G — self-service profile patch.
 *
 * Lets any authenticated user edit their OWN name + timezone from the
 * mobile app (and the web app, when we get to inline editing there).
 * Deliberately narrow scope:
 *
 *   • Only the calling user's row (`eq(users.id, user.id)`). No way to
 *     update someone else even by accident — there is no `id` field in
 *     the request schema. Admin/manager edits still go through the
 *     existing PATCH /api/staff/[id] route which has tenant + role gating.
 *
 *   • Only two fields. Role, tenant, email, password — all the
 *     security-sensitive surfaces — are intentionally excluded.
 *     Adding more here is a deliberate decision (and probably wants
 *     a separate endpoint with stricter checks, like fresh-session
 *     verification).
 *
 *   • Returns the same shape as GET so the client can swap the cache
 *     entry without a refetch.
 */

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .refine((v) => v.name !== undefined || v.timezone !== undefined, {
    message: "At least one field is required",
  });

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = await req.json().catch(() => ({}));
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const patch: { name?: string; timezone?: string } = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.timezone !== undefined) patch.timezone = parsed.data.timezone;

    const [updated] = await db
      .update(users)
      .set(patch)
      .where(eq(users.id, user.id))
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        timezone: users.timezone,
        avatarUrl: users.avatarUrl,
      });

    if (!updated) {
      // Row vanished between requireUser() and the update — implausible
      // outside of a concurrent deletion, but cleaner to surface than
      // a silent 200 with no body.
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const tenant = await getTenantById(user.tenantId);
    const [googleConnected, microsoftConnected] = await Promise.all([
      isGoogleConnected(user.id),
      isMicrosoftConnected(user.id),
    ]);
    const calendarConnected = googleConnected || microsoftConnected;

    return NextResponse.json({
      id: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
      timezone: updated.timezone,
      avatarUrl: updated.avatarUrl ?? null,
      googleConnected,
      microsoftConnected,
      calendarConnected,
      tenant: tenant
        ? {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            plan: tenant.plan,
            active: tenant.active,
            // Canonical BUSINESS timezone — mobile uses this (NOT the user's
            // personal profile tz) to request slots + interpret booking times,
            // so an operator books in the business's zone regardless of their
            // own profile/device tz. See lib/tenant-timezone.ts.
            timezone: tenant.timezone,
            // Additive (mobile branding): tenant-configured logo + brand
            // color. Relative logoUrl is absolutized client-side. Web
            // ignores unknown fields, so this is backward-compatible.
            logoUrl: tenant.logoUrl ?? null,
            primaryColor: tenant.primaryColor ?? null,
          }
        : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
