/**
 * POST /api/auth/oauth/apple/native — Sign in with Apple for the iOS app
 * (App Store Guideline 4.8).
 *
 * The native app runs AppleAuthentication.signInAsync() on-device and sends
 * us the resulting identity token (a JWT signed by Apple). We:
 *   1. Verify the JWT against Apple's published JWKS — signature, issuer
 *      (https://appleid.apple.com), audience (our iOS bundle id), expiry.
 *   2. Read the `email` claim. Apple private-relay addresses
 *      (@privaterelay.appleid.com) are ordinary verified emails and flow
 *      through unchanged — we never attempt to unmask them.
 *   3. Find-or-create the user via the SAME shared helper the Google and
 *      Microsoft callbacks use (account linking by email), then mint the
 *      same mobile bearer token shape.
 *
 * Privacy: the identity token is used ONLY to authenticate this sign-in.
 * We store the email + optional display name on the user record — nothing
 * else — and never use Apple login data for tracking or share it.
 *
 * Unlike Google/Microsoft there is no web start/callback pair: Apple's
 * native flow has no redirect leg, so no CSRF state cookie is involved —
 * the identity token itself is the proof (signed, audience-bound, short-
 * lived). Rate limiting matches the password login route's posture: the
 * expensive part (Apple JWKS fetch) is cached by jose between calls.
 */

import { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

import { errorResponse, HttpError } from "@/lib/auth";
import { findOrCreateUserForOAuth, mintMobileOAuthToken } from "@/lib/auth/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APPLE_ISSUER = "https://appleid.apple.com";
/** Native Sign in with Apple sets the token audience to the app's bundle id. */
const APPLE_AUDIENCE = "com.zentromeet.app";

// Module-level so jose caches Apple's keys between requests (it refetches
// automatically on unknown-kid / cache expiry).
const appleJwks = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

const bodySchema = z.object({
  identityToken: z.string().min(20).max(8192),
  /** Apple only supplies the name on the FIRST authorization; the app
   *  forwards it so the account isn't created with a bare email local-part. */
  fullName: z.string().trim().max(200).nullish(),
});

type AppleIdTokenClaims = {
  email?: unknown;
  email_verified?: unknown;
  sub?: unknown;
};

export async function POST(req: NextRequest) {
  try {
    const body = bodySchema.parse(await req.json());

    let claims: AppleIdTokenClaims;
    try {
      const verified = await jwtVerify(body.identityToken, appleJwks, {
        issuer: APPLE_ISSUER,
        audience: APPLE_AUDIENCE,
      });
      claims = verified.payload as AppleIdTokenClaims;
    } catch {
      // Signature/issuer/audience/expiry failure — one generic message, no
      // detail leak about which check failed.
      throw new HttpError(401, "Apple sign-in could not be verified. Please try again.");
    }

    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (!email) {
      throw new HttpError(400, "Apple didn't share an email for this account. Please try again.");
    }
    // Apple sends email_verified as boolean OR the string "true"/"false".
    // Private-relay addresses are always verified; treat an explicit false as
    // a rejection, absence as verified (Apple omits it on some token shapes).
    if (claims.email_verified === false || claims.email_verified === "false") {
      throw new HttpError(403, "That Apple ID's email isn't verified.");
    }

    const result = await findOrCreateUserForOAuth({
      email,
      name: body.fullName && body.fullName.trim() !== "" ? body.fullName.trim() : null,
      provider: "apple",
    });

    const minted = await mintMobileOAuthToken({
      userId: result.userId,
      provider: "apple",
      req,
    });

    return NextResponse.json({
      ok: true,
      token: minted.token,
      user: { id: minted.user.id, email: minted.user.email, name: minted.user.name },
      isNewUser: result.isNewUser,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
