// lib/identity.ts — Canonical public-profile resolver.
//
// Single source of truth for "what does this person look like to a
// customer on a booking page." Every customer-facing surface should
// derive identity through this module so the precedence rules
// (publicDisplayName ?? name, publicTitle omitted when null, etc.)
// stay consistent across booking pages, service pages, booking
// confirmations, and future multi-service / multi-host surfaces.
//
// Storage (migration 0007 + 0033):
//   users.name                  — operational name (login record)
//   users.public_display_name   — curated public-facing name
//   users.public_title          — professional title
//   users.avatar_url            — uploaded avatar URL (or null)
//   users.bio                   — public bio (shown on booking pages)
//   users.specialties           — comma-separated expertise tags
//
// Why a resolver instead of inlining the `??` everywhere:
//   • The fallback rules will evolve (e.g. multi-locale public_name,
//     publicVisibility gating, intro video URL once it lands).
//   • Booking pages, identity blocks, calendar invites, and the
//     future multi-service flow all need the same resolved shape.
//   • A typed `PublicProfile` keeps every consumer honest about
//     which fields are nullable.

export type PublicProfile = {
  /** User id. Always present. */
  id: string;
  /** Curated public name (publicDisplayName ?? name). Always present. */
  displayName: string;
  /** Professional title or null when unset — never an empty string. */
  title: string | null;
  /** Avatar URL or null when no image has been uploaded. */
  avatarUrl: string | null;
  /** Public bio or null when unset. */
  bio: string | null;
  /** Expertise chips (parsed from comma-separated `specialties`). */
  specialties: string[];
  /** Initials (2 letters max) derived from displayName — for fallback avatars. */
  initials: string;
};

type UserIdentityInput = {
  id: string;
  name: string;
  publicDisplayName?: string | null;
  publicTitle?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  specialties?: string | null;
};

/**
 * Resolve the canonical public profile for a user record.
 *
 * Pure function — no DB calls. Caller selects the required columns,
 * this normalizes them into the customer-facing shape.
 */
export function resolvePublicProfile(u: UserIdentityInput): PublicProfile {
  const displayName = (u.publicDisplayName?.trim() || u.name || "").trim();
  const title = u.publicTitle?.trim() || null;
  const bio = u.bio?.trim() || null;
  const specialties = (u.specialties ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    id: u.id,
    displayName,
    title,
    avatarUrl: u.avatarUrl ?? null,
    bio,
    specialties,
    initials: deriveInitials(displayName),
  };
}

/**
 * Two-letter initials from a display name. Used by the Avatar
 * primitive when no avatar image is set.
 *
 *   "Sean Syed"            → "SS"
 *   "Sean A. Syed"         → "SS"
 *   "Cassandra"            → "C"
 *   ""                     → "·" (calm placeholder, never empty)
 */
export function deriveInitials(name: string): string {
  const cleaned = (name ?? "").trim();
  if (!cleaned) return "·";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  const first = parts[0]!.charAt(0);
  const last = parts[parts.length - 1]!.charAt(0);
  return (first + last).toUpperCase();
}
