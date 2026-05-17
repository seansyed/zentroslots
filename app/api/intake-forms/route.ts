import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { intakeForms } from "@/db/schema";
import { errorResponse, requireRole, requireUser } from "@/lib/auth";
import { intakeFormSchema } from "@/lib/intake";

export async function GET() {
  try {
    const caller = await requireUser();
    const rows = await db
      .select()
      .from(intakeForms)
      .where(eq(intakeForms.tenantId, caller.tenantId))
      .orderBy(asc(intakeForms.name));
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const body = intakeFormSchema.parse(await req.json());

    const [row] = await db
      .insert(intakeForms)
      .values({
        tenantId: admin.tenantId,
        name: body.name,
        fields: body.fields,
        isActive: body.isActive,
      })
      .returning();
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
