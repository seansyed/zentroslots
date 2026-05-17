import { NextRequest, NextResponse } from "next/server";

import { errorResponse } from "@/lib/auth";
import { exitImpersonation, getImpersonationState } from "@/lib/impersonate";
import { audit, ipFromHeaders } from "@/lib/audit";
import { getSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    // Capture context BEFORE swapping — we want the audit log to know
    // which tenant + user the super-admin was operating as when they
    // exited.
    const beforeSession = await getSession();
    const beforeState = await getImpersonationState();
    if (!beforeState.active) {
      return NextResponse.json({ ok: true, wasActive: false, redirectTo: "/admin" });
    }

    const ended = await exitImpersonation();

    if (beforeSession && ended) {
      audit({
        tenantId: beforeSession.tenantId,
        action: "admin.impersonate.end",
        actorLabel: ended.originalEmail,
        entityType: "user",
        entityId: beforeSession.sub,
        metadata: {
          impersonatedEmail: beforeSession.email,
          byEmail: ended.originalEmail,
        },
        ipAddress: ipFromHeaders(req.headers),
      });
    }

    return NextResponse.json({ ok: true, wasActive: true, redirectTo: "/admin" });
  } catch (err) {
    return errorResponse(err);
  }
}
