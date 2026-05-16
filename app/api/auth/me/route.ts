import { NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/auth";
import { getTenantById } from "@/lib/tenant";

export async function GET() {
  try {
    const user = await requireUser();
    const tenant = await getTenantById(user.tenantId);

    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      timezone: user.timezone,
      googleConnected: Boolean(user.googleRefreshToken),
      tenant: tenant
        ? {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            plan: tenant.plan,
            active: tenant.active,
          }
        : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
