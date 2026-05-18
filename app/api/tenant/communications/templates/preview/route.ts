import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, requireRole } from "@/lib/auth";
import { renderVariables, type TemplateContext } from "@/lib/communications/variables";

// POST /api/tenant/communications/templates/preview
//   Pure renderer — no DB write, no email send. Used by the editor's
//   live preview. Caller passes the draft + a context blob; we return
//   the substituted strings.

const bodySchema = z.object({
  subject: z.string().max(500),
  htmlContent: z.string().max(50_000),
  textContent: z.string().max(20_000),
  context: z.record(z.string(), z.string().nullable()).default({}),
});

export async function POST(req: NextRequest) {
  try {
    // Admin or manager — same as the edit endpoint (no point letting
    // someone preview who can't save).
    await requireRole(["admin", "manager"]);

    const body = bodySchema.parse(await req.json());
    const ctx = body.context as TemplateContext;
    return NextResponse.json({
      subject: renderVariables(body.subject, ctx),
      htmlContent: renderVariables(body.htmlContent, ctx),
      textContent: renderVariables(body.textContent, ctx),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
