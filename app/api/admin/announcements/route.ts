import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { announcements } from "@/db/schema";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

const annInput = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  severity: z.enum(["info", "warning", "critical"]).default("info"),
  audience: z.string().min(1).max(40).default("all"),
  linkUrl: z.string().url().nullish(),
  linkLabel: z.string().max(80).nullish(),
  expiresAt: z.string().datetime().nullish(),
  active: z.boolean().default(true),
});

export async function GET() {
  try {
    await requireSuperAdmin();
    const rows = await db
      .select()
      .from(announcements)
      .orderBy(desc(announcements.publishedAt));
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireSuperAdmin();
    const body = annInput.parse(await req.json());
    const [row] = await db
      .insert(announcements)
      .values({
        ...body,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      })
      .returning();
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
