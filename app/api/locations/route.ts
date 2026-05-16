import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { locations } from "@/db/schema";
import { errorResponse, requireRole, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  address: z.string().max(500).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().email().nullable().optional(),
});

export async function GET() {
  try {
    const caller = await requireUser();
    const rows = await db
      .select()
      .from(locations)
      .where(eq(locations.tenantId, caller.tenantId))
      .orderBy(asc(locations.name));
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireRole(["admin"]);
    const body = createSchema.parse(await req.json());

    const [row] = await db
      .insert(locations)
      .values({
        tenantId: admin.tenantId,
        name: body.name,
        address: body.address ?? null,
        timezone: body.timezone ?? null,
        phone: body.phone ?? null,
        email: body.email ?? null,
      })
      .returning();

    audit({
      tenantId: admin.tenantId,
      action: "location.create",
      entityType: "location",
      entityId: row.id,
      actorUserId: admin.id,
      actorLabel: admin.name,
      metadata: { name: row.name },
    });

    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
