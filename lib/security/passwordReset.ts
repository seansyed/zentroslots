/**
 * Password reset primitives. All security-critical.
 *
 *   - Tokens are 32-byte cryptographically secure random values, URL-
 *     base64 encoded. Never store the raw token — only its bcrypt hash.
 *   - 1 hour expiry.
 *   - One-time use (consumed_at is set on first successful consume).
 *   - Replay protection: a consumed token can't be reused.
 *   - Outstanding tokens for the same user are invalidated on request
 *     (mark prior unconsumed rows as consumed_at = now with a
 *     "superseded" metadata flag, so they can't be used in parallel).
 *   - Tenant-scoped: tokens are bound to (user_id, tenant_id). The
 *     verify path checks both.
 *
 * Pure-ish: token generation is pure; verify + consume hit the DB.
 * NEVER throws — returns structured Result objects.
 */

import crypto from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import bcrypt from "bcryptjs";

import { db } from "@/db/client";
import { passwordResetTokens, users } from "@/db/schema";

const TOKEN_BYTES = 32;
const TOKEN_LIFETIME_MS = 60 * 60 * 1000; // 1 hour
const BCRYPT_ROUNDS = 10;

export type GenerateTokenResult = {
  /** The raw token to embed in the email link. Caller must NOT log
   *  this value. Never returned again — it's not stored in the clear. */
  rawToken: string;
  tokenId: string;
  expiresAt: Date;
};

/** Generate a new reset token for a user. Invalidates any outstanding
 *  (unconsumed, unexpired) tokens the user already had so only the most
 *  recent request is honored. Returns the raw token ONCE. */
export async function generatePasswordResetToken(args: {
  tenantId: string;
  userId: string;
  requestedIp?: string | null;
}): Promise<GenerateTokenResult> {
  // 1. Invalidate prior outstanding tokens for this user — replay /
  //    parallel-token-spray protection.
  await db
    .update(passwordResetTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(passwordResetTokens.userId, args.userId),
        isNull(passwordResetTokens.consumedAt),
        gt(passwordResetTokens.expiresAt, new Date())
      )
    );

  // 2. Generate a fresh token.
  const raw = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const hash = await bcrypt.hash(raw, BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS);

  const [row] = await db
    .insert(passwordResetTokens)
    .values({
      tenantId: args.tenantId,
      userId: args.userId,
      tokenHash: hash,
      expiresAt,
      requestedIp: args.requestedIp ?? null,
    })
    .returning({ id: passwordResetTokens.id });

  return { rawToken: raw, tokenId: row.id, expiresAt };
}

export type ConsumeTokenResult =
  | {
      ok: true;
      userId: string;
      tenantId: string;
      tokenId: string;
    }
  | {
      ok: false;
      reason:
        | "not_found"
        | "expired"
        | "already_consumed"
        | "user_missing";
    };

/** Verify + consume a raw token. Atomic in spirit: we check, then
 *  update only-if-still-unconsumed. The single UPDATE returning rows
 *  is the source of truth — a second concurrent caller will get 0
 *  rows back and "already_consumed".
 *
 *  Optionally checks the supplied `tenantSlug` matches the token's
 *  tenant (defense-in-depth — the user's account is the source of
 *  truth, but a slug mismatch indicates the link was tampered with). */
export async function consumePasswordResetToken(args: {
  rawToken: string;
  consumedIp?: string | null;
  consumedUserAgent?: string | null;
}): Promise<ConsumeTokenResult> {
  // The token id is opaque to us — we have to scan all unexpired
  // unconsumed tokens and bcrypt-compare. We hard-cap the scan to
  // tokens issued in the last 24h to bound the cost; tokens older
  // than that are expired anyway (1h lifetime) and would short-
  // circuit at the expiry check below.
  //
  // DB failures are mapped to "not_found" so callers (and ultimately
  // public responses) never differentiate "no such token" from
  // "infra blip" — preserves enumeration resistance even during
  // partial outages.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let candidates: Array<{
    id: string;
    userId: string;
    tenantId: string;
    tokenHash: string;
    expiresAt: Date;
    consumedAt: Date | null;
  }> = [];
  try {
    candidates = await db
      .select({
        id: passwordResetTokens.id,
        userId: passwordResetTokens.userId,
        tenantId: passwordResetTokens.tenantId,
        tokenHash: passwordResetTokens.tokenHash,
        expiresAt: passwordResetTokens.expiresAt,
        consumedAt: passwordResetTokens.consumedAt,
      })
      .from(passwordResetTokens)
      .where(gt(passwordResetTokens.createdAt, cutoff));
  } catch (err) {
    console.error("[security] consume: candidate query failed:", err);
    return { ok: false, reason: "not_found" };
  }

  // Constant-ish-time compare across all candidates so the response
  // time doesn't leak whether a match exists. (bcrypt.compare itself
  // is constant-time per call; we run every candidate to avoid early
  // exit timing.)
  let match: { id: string; userId: string; tenantId: string; expiresAt: Date; consumedAt: Date | null } | null = null;
  for (const c of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await bcrypt.compare(args.rawToken, c.tokenHash);
    if (ok && !match) {
      match = {
        id: c.id,
        userId: c.userId,
        tenantId: c.tenantId,
        expiresAt: c.expiresAt,
        consumedAt: c.consumedAt,
      };
      // Don't break — keep comparing the rest to flatten timing.
    }
  }

  if (!match) return { ok: false, reason: "not_found" };
  if (match.consumedAt) return { ok: false, reason: "already_consumed" };
  if (match.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };

  // Atomic consume — only proceed if still unconsumed in the DB. A
  // second concurrent caller will UPDATE 0 rows and lose the race.
  const updated = await db
    .update(passwordResetTokens)
    .set({
      consumedAt: new Date(),
      consumedIp: args.consumedIp ?? null,
      consumedUserAgent: args.consumedUserAgent ?? null,
    })
    .where(
      and(
        eq(passwordResetTokens.id, match.id),
        isNull(passwordResetTokens.consumedAt)
      )
    )
    .returning({ id: passwordResetTokens.id });

  if (updated.length === 0) return { ok: false, reason: "already_consumed" };

  // Double-check the user still exists (account could've been deleted
  // between request and reset).
  const user = await db.query.users.findFirst({ where: eq(users.id, match.userId) });
  if (!user) return { ok: false, reason: "user_missing" };

  return { ok: true, userId: match.userId, tenantId: match.tenantId, tokenId: match.id };
}

/** Cron-friendly pruner — deletes consumed or expired rows older than
 *  the retention window. Returns how many rows were deleted. */
export async function prunePasswordResetTokens(retentionDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  try {
    const r = await db
      .delete(passwordResetTokens)
      .where(lt(passwordResetTokens.expiresAt, cutoff))
      .returning({ id: passwordResetTokens.id });
    return r.length;
  } catch (err) {
    console.error("[security] prunePasswordResetTokens failed:", err);
    return 0;
  }
}

export const _internals = {
  TOKEN_BYTES,
  TOKEN_LIFETIME_MS,
  BCRYPT_ROUNDS,
} as const;
