/**
 * Phase ICAL-2 — feed token lifecycle helpers.
 *
 * Token model:
 *   • 32 random bytes (256 bits of entropy) → base64url encode →
 *     43 URL-safe chars. This is the "raw" token shown to the user
 *     ONCE on create/rotate.
 *   • SHA-256 hex (64 chars) is what's persisted in the DB. The
 *     hash is what we compare against on every feed poll.
 *   • One ACTIVE token per (tenantId, userId). Rotation soft-revokes
 *     the prior row (sets revoked_at, marks reason='rotated') and
 *     inserts a fresh row. Both operations happen in a single
 *     transaction so a crash can't leave a user with zero active
 *     tokens.
 *
 * Why SHA-256 vs bcrypt:
 *   • Public endpoint has only the token in the URL — no user
 *     context for a slow-compare. We need a DETERMINISTIC hash to
 *     look up the row by hash content.
 *   • 256-bit random preimage + 256-bit hash output means brute
 *     force is computationally infeasible (2^256 ops). Bcrypt's
 *     slow-hash benefit assumes a guessable-password threat model
 *     that doesn't apply to a random secret.
 *   • Industry-standard pattern: GitHub PATs, Stripe webhooks,
 *     Sentry DSNs all hash random secrets with SHA-256.
 *
 * Tenant + user scoping:
 *   • lookupTokenByHash returns the row INCLUDING tenant_id +
 *     user_id. The caller (the public feed endpoint) MUST use both
 *     when querying bookings — never trust the URL path alone.
 */

import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import { staffCalendarFeedTokens } from "@/db/schema";
import type { RevokeReason, StaffFeedToken } from "./types";

const TOKEN_BYTES = 32; // 256 bits of entropy

// ─── Hashing ──────────────────────────────────────────────────────────

/** SHA-256 hex of the raw token. Deterministic. Hot path — runs on
 *  every feed poll. */
export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Generate a fresh random token. Caller is responsible for storing
 *  the hash; the raw value should be shown to the user ONCE and then
 *  discarded by the server. */
export function generateRawToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

// ─── CRUD ─────────────────────────────────────────────────────────────

/** Return the user's currently-active token row (no plaintext —
 *  hash + metadata only). Null if no active token exists. */
export async function getActiveToken(args: {
  tenantId: string;
  userId: string;
}): Promise<StaffFeedToken | null> {
  const [row] = await db
    .select()
    .from(staffCalendarFeedTokens)
    .where(
      and(
        eq(staffCalendarFeedTokens.tenantId, args.tenantId),
        eq(staffCalendarFeedTokens.userId, args.userId),
        isNull(staffCalendarFeedTokens.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    lastAccessedAt: row.lastAccessedAt,
    lastAccessedIp: row.lastAccessedIp,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
  };
}

/** Create OR rotate the user's token. If an active row exists it's
 *  soft-revoked with reason='rotated' before the new row is inserted.
 *  Returns the freshly-generated raw token — caller MUST surface it
 *  to the user in this one response; it can never be recovered later.
 *
 *  The two writes happen in a single transaction to guarantee the
 *  user is never temporarily without an active token AND never has
 *  two active tokens. */
export async function rotateToken(args: {
  tenantId: string;
  userId: string;
  reason?: RevokeReason;
}): Promise<StaffFeedToken> {
  const raw = generateRawToken();
  const hash = hashToken(raw);
  const reason: RevokeReason = args.reason ?? "rotated";

  const result = await db.transaction(async (tx) => {
    // Soft-revoke any active token for this user. The unique index
    // is on token_hash, not (tenant_id, user_id), so multiple revoked
    // rows for the same user are allowed (this is the audit trail).
    await tx
      .update(staffCalendarFeedTokens)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(staffCalendarFeedTokens.tenantId, args.tenantId),
          eq(staffCalendarFeedTokens.userId, args.userId),
          isNull(staffCalendarFeedTokens.revokedAt),
        ),
      );

    const [inserted] = await tx
      .insert(staffCalendarFeedTokens)
      .values({
        tenantId: args.tenantId,
        userId: args.userId,
        tokenHash: hash,
      })
      .returning();

    return inserted;
  });

  return {
    id: result.id,
    tenantId: result.tenantId,
    userId: result.userId,
    rawToken: raw, // ← ONLY time the plaintext escapes server memory
    tokenHash: result.tokenHash,
    createdAt: result.createdAt,
    lastAccessedAt: result.lastAccessedAt,
    lastAccessedIp: result.lastAccessedIp,
    revokedAt: result.revokedAt,
    revokedReason: result.revokedReason,
  };
}

/** Soft-revoke the user's active token. No-op if none exists. The
 *  row stays in the table for audit; verifyFeedToken refuses to
 *  match revoked rows. */
export async function revokeActiveToken(args: {
  tenantId: string;
  userId: string;
  reason: RevokeReason;
}): Promise<{ revoked: boolean }> {
  const result = await db
    .update(staffCalendarFeedTokens)
    .set({ revokedAt: new Date(), revokedReason: args.reason })
    .where(
      and(
        eq(staffCalendarFeedTokens.tenantId, args.tenantId),
        eq(staffCalendarFeedTokens.userId, args.userId),
        isNull(staffCalendarFeedTokens.revokedAt),
      ),
    )
    .returning({ id: staffCalendarFeedTokens.id });
  return { revoked: result.length > 0 };
}

/** Look up a token by its plaintext value. Hashes the input, queries
 *  by hash, returns the row only if it's not revoked. Used by the
 *  public feed endpoint to authenticate a poll.
 *
 *  Constant-time hash compare is unnecessary here — we look up by
 *  hash content, not by string-comparing user input. The lookup is
 *  index-bound by the unique index on token_hash. */
export async function verifyFeedToken(rawToken: string): Promise<StaffFeedToken | null> {
  // Reject obviously malformed input before hitting the DB. base64url
  // chars are [A-Za-z0-9_-]; minimum length for our 32-byte token is
  // 43 chars. We bound at a generous 200 to defend against pathological
  // path values that might bloat the hash function input.
  if (!rawToken || rawToken.length < 32 || rawToken.length > 200) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(rawToken)) return null;

  const hash = hashToken(rawToken);

  const [row] = await db
    .select()
    .from(staffCalendarFeedTokens)
    .where(eq(staffCalendarFeedTokens.tokenHash, hash))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt) return null;

  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    lastAccessedAt: row.lastAccessedAt,
    lastAccessedIp: row.lastAccessedIp,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
  };
}

/** Update last_accessed_at + last_accessed_ip on a successful poll.
 *  Best-effort: if the write fails (DB hiccup) the feed still serves
 *  — we don't want a transient write error to break the user's
 *  Calendar sync. Caller should not await this with critical timing. */
export async function recordTokenAccess(args: {
  tokenId: string;
  ip: string | null;
}): Promise<void> {
  try {
    await db
      .update(staffCalendarFeedTokens)
      .set({
        lastAccessedAt: new Date(),
        lastAccessedIp: args.ip ?? null,
      })
      .where(eq(staffCalendarFeedTokens.id, args.tokenId));
  } catch {
    // Swallow — audit trail nice-to-have, never a hard failure.
  }
}
