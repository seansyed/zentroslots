import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { departments } from "@/db/schema";
import { errorResponse, requireRole, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected hex like #2563eb").nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
});

export async function GET() {
  try {
    const caller = await requireUser();
    const rows = await db
      .select()
      .from(departments)
      .where(eq(departments.tenantId, caller.tenantId))
      .orderBy(asc(departments.name));
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
      .insert(departments)
      .values({
        tenantId: admin.tenantId,
        name: body.name,
        color: body.color ?? null,
        description: body.description ?? null,
      })
      .returning();

    audit({
      tenantId: admin.tenantId,
      action: "department.create",
      entityType: "department",
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
