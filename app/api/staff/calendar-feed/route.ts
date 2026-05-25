/**
 * Phase ICAL-2 — calendar-feed management API for the staff UI.
 *
 *   GET    /api/staff/calendar-feed       → current token state (no plaintext)
 *   POST   /api/staff/calendar-feed       → generate or rotate (returns plaintext ONCE)
 *   DELETE /api/staff/calendar-feed       → revoke
 *
 * Authorization model:
 *   • Default: a user can manage their OWN token (action operates
 *     on session.sub).
 *   • Override: admin or manager may pass ?userId=<other-staff>
 *     to act on that staff member's behalf (e.g. helping someone
 *     set up their iPhone). The user MUST belong to the same
 *     tenant as the caller.
 *
 * Plaintext exposure:
 *   • Returned ONLY in the POST response (the create/rotate
 *     boundary). GET never returns plaintext — only metadata
 *     (createdAt, lastAccessedAt, lastAccessedIp).
 *   • The full webcal:// URL is composed server-side using the
 *     publicBaseUrl helper so it works correctly through Caddy.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";
import { publicBaseUrl } from "@/lib/auth/oauth";
import {
  getActiveToken,
  revokeActiveToken,
  rotateToken,
} from "@/lib/calendar/feeds/feedTokens";

export const dynamic = "force-dynamic";

/** Resolve the target staff user from `?userId=...` if present, else
 *  fall back to the caller's own id. Enforces tenant scoping and
 *  permission. Returns null on access denial (caller treats as 403). */
async function resolveTargetUser(req: NextRequest) {
  const caller = await requireUser();
  const url = new URL(req.url);
  const explicit = url.searchParams.get("userId");

  if (!explicit || explicit === caller.id) {
    return { caller, targetId: caller.id, tenantId: caller.tenantId };
  }

  // Cross-user access requires admin or manager. We deliberately do
  // NOT allow "staff manages another staff's feed" even within the
  // same tenant — only privileged roles.
  if (caller.role !== "admin" && caller.role !== "manager") {
    return null;
  }

  // Confirm the target belongs to the same tenant before any
  // mutation. Cross-tenant data leak prevention.
  const [target] = await db
    .select({ id: users.id, tenantId: users.tenantId })
    .from(users)
    .where(and(eq(users.id, explicit), eq(users.tenantId, caller.tenantId)))
    .limit(1);

  if (!target) return null;

  return { caller, targetId: target.id, tenantId: caller.tenantId };
}

/** Compose the public webcal:// URL for a freshly-issued token. */
function buildSubscriptionUrls(req: NextRequest, rawToken: string) {
  const base = publicBaseUrl(req);
  // We expose three URL forms for client convenience:
  //   • httpsUrl — copy-pasteable; works in Google Calendar's
  //     "From URL" subscription dialog
  //   • webcalUrl — opens Apple Calendar's subscription wizard
  //     automatically on tap (iOS Safari / macOS Calendar)
  //   • httpUrl — defensive fallback for ancient clients
  const path = `/api/public/staff-feed/${encodeURIComponent(rawToken)}.ics`;
  const webcalBase = base.replace(/^https?:/, "webcal:");
  return {
    httpsUrl: `${base}${path}`,
    webcalUrl: `${webcalBase}${path}`,
  };
}

// ─── GET — current state ───────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const ctx = await resolveTargetUser(req);
    if (!ctx) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const token = await getActiveToken({
      tenantId: ctx.tenantId,
      userId: ctx.targetId,
    });

    if (!token) {
      return NextResponse.json({
        active: false,
        token: null,
      });
    }

    // NEVER include rawToken or tokenHash in this response. The
    // plaintext is unrecoverable after creation; tokenHash is a
    // secret in its own right (whoever has it can brute-force the
    // 256-bit preimage — infeasible, but defense in depth).
    return NextResponse.json({
      active: true,
      token: {
        id: token.id,
        createdAt: token.createdAt.toISOString(),
        lastAccessedAt: token.lastAccessedAt?.toISOString() ?? null,
        lastAccessedIp: token.lastAccessedIp,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── POST — generate or rotate ─────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const ctx = await resolveTargetUser(req);
    if (!ctx) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Whether or not an active token exists, rotateToken does the
    // right thing — soft-revokes any prior + inserts new. The
    // returned row carries the plaintext exactly once.
    const fresh = await rotateToken({
      tenantId: ctx.tenantId,
      userId: ctx.targetId,
      reason: "rotated",
    });

    if (!fresh.rawToken) {
      // Belt-and-suspenders — rotateToken always sets rawToken on
      // its return; treat absence as an internal error.
      return NextResponse.json({ error: "Failed to issue token" }, { status: 500 });
    }

    const urls = buildSubscriptionUrls(req, fresh.rawToken);

    return NextResponse.json({
      active: true,
      // Plaintext ONLY here — the UI must surface it to the user
      // immediately and never store it.
      rawToken: fresh.rawToken,
      ...urls,
      token: {
        id: fresh.id,
        createdAt: fresh.createdAt.toISOString(),
        lastAccessedAt: null,
        lastAccessedIp: null,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── DELETE — revoke ───────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  try {
    const ctx = await resolveTargetUser(req);
    if (!ctx) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const result = await revokeActiveToken({
      tenantId: ctx.tenantId,
      userId: ctx.targetId,
      // If the caller is acting on someone else's behalf, mark
      // admin_revoke; else user_revoke.
      reason:
        ctx.caller.id === ctx.targetId ? "user_revoke" : "admin_revoke",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return errorResponse(err);
  }
}
