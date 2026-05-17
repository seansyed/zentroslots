import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { serviceStaff, services, users } from "@/db/schema";
import { errorResponse, getTenantId, requireRole, HttpError } from "@/lib/auth";
import { serviceSchema } from "@/lib/validation";

// GET: by default tenant-scoped to the caller. If the caller is not
// signed in, returns an empty list — public service discovery happens
// via the per-tenant booking pages, not this endpoint.
export async function GET() {
  try {
    const tenantId = await getTenantId();
    if (!tenantId) return NextResponse.json([]);

    const rows = await db
      .select({
        id: services.id,
        tenantId: services.tenantId,
        name: services.name,
        description: services.description,
        durationMinutes: services.durationMinutes,
        price: services.price,
        bufferBefore: services.bufferBefore,
        bufferAfter: services.bufferAfter,
        isActive: services.isActive,
        videoProvider: services.videoProvider,
      })
      .from(services)
      .where(and(eq(services.tenantId, tenantId), eq(services.isActive, 1)));

    const serviceIds = rows.map((r) => r.id);
    const staff =
      serviceIds.length === 0
        ? []
        : await db
            .select({
              serviceId: serviceStaff.serviceId,
              userId: users.id,
              name: users.name,
              email: users.email,
              timezone: users.timezone,
            })
            .from(serviceStaff)
            .innerJoin(users, eq(users.id, serviceStaff.userId))
            .where(
              and(
                eq(serviceStaff.tenantId, tenantId),
                inArray(serviceStaff.serviceId, serviceIds)
              )
            );

    const byService = new Map<string, typeof staff>();
    for (const s of staff) {
      const list = byService.get(s.serviceId) ?? [];
      list.push(s);
      byService.set(s.serviceId, list);
    }

    return NextResponse.json(
      rows.map((s) => ({
        ...s,
        staff: (byService.get(s.id) ?? []).map(({ serviceId: _sid, ...rest }) => rest),
      }))
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const body = serviceSchema.parse(await req.json());

    // Verify all staff being assigned belong to this admin's tenant.
    if (body.staffUserIds.length > 0) {
      const assignable = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.tenantId, admin.tenantId),
            inArray(users.id, body.staffUserIds)
          )
        );
      if (assignable.length !== body.staffUserIds.length) {
        throw new HttpError(403, "One or more staff users are not in your workspace");
      }
    }

    const slug =
      body.slug ??
      body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

    const [row] = await db
      .insert(services)
      .values({
        tenantId: admin.tenantId,
        name: body.name,
        slug,
        description: body.description,
        durationMinutes: body.durationMinutes,
        price: body.price,
        bufferBefore: body.bufferBefore,
        bufferAfter: body.bufferAfter,
        videoProvider: body.videoProvider,
      })
      .returning();

    if (body.staffUserIds.length > 0) {
      await db.insert(serviceStaff).values(
        body.staffUserIds.map((userId) => ({
          serviceId: row.id,
          userId,
          tenantId: admin.tenantId,
        }))
      );
    }

    return NextResponse.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}
