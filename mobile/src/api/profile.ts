/**
 * Profile + tenant snapshot.
 *
 * The backend exposes `/api/auth/me` (not `/api/tenant/profile`). Shape:
 *   {
 *     id, email, name, role, timezone, avatarUrl,
 *     googleConnected: boolean,
 *     tenant: { id, name, slug, plan, active } | null
 *   }
 *
 * We re-shape it to a stable Profile contract the UI consumes so the
 * server response shape can drift without screens needing to learn
 * about it.
 */

import { apiGet, apiPatch } from "./client";
import { env } from "@/lib/env";
import { absolutizeUrl } from "@/lib/url";

/**
 * Absolutize an image URL from the API against our origin so RN <Image>
 * can load it (the backend returns relative `/uploads/...` paths). See
 * src/lib/url.ts for the pure implementation (+ its tests).
 */
export function toAbsoluteImageUrl(url: string | null | undefined): string | null {
  return absolutizeUrl(url, env.apiBaseUrl);
}

export type Profile = {
  id: string;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  timezone: string;
  tenant: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    active: boolean;
    /** Canonical BUSINESS timezone (IANA). The tz an operator books in —
     *  used for /api/slots requests + booking interpretation, NOT the user's
     *  personal profile tz (which can be the UTC default). */
    timezone: string;
    /** Tenant-configured brand logo (absolutized). Null = use platform logo. */
    logoUrl: string | null;
    /** Tenant brand color (hex). Null = platform default. */
    primaryColor: string | null;
  } | null;
  /** Per-provider calendar connection state from /api/auth/me. Use
   *  `calendarConnected` (aggregate) for provider-neutral "Connect calendar" /
   *  hide-CTA decisions; the per-provider flags drive provider-specific copy.
   *  `googleConnected` kept for back-compat. */
  googleConnected: boolean;
  microsoftConnected: boolean;
  /** True when EITHER Google or Microsoft is connected. */
  calendarConnected: boolean;
};

type AuthMeResponse = {
  id: string;
  email: string;
  name: string;
  role: string;
  timezone: string;
  avatarUrl?: string | null;
  googleConnected?: boolean;
  microsoftConnected?: boolean;
  calendarConnected?: boolean;
  tenant?: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    active?: boolean;
    timezone?: string | null;
    logoUrl?: string | null;
    primaryColor?: string | null;
  } | null;
};

export type ProfileUpdate = {
  name?: string;
  timezone?: string;
};

function normalize(raw: AuthMeResponse): Profile {
  return {
    id: raw.id,
    email: raw.email,
    name: raw.name,
    role: raw.role,
    // Absolutize so RN <Image> can load it (backend returns a relative path).
    avatarUrl: toAbsoluteImageUrl(raw.avatarUrl),
    timezone: raw.timezone ?? "UTC",
    googleConnected: Boolean(raw.googleConnected),
    microsoftConnected: Boolean(raw.microsoftConnected),
    // Prefer the backend aggregate; fall back to OR of the per-provider flags
    // for older backends that don't return it yet.
    calendarConnected: Boolean(
      raw.calendarConnected ?? (raw.googleConnected || raw.microsoftConnected),
    ),
    tenant: raw.tenant
      ? {
          id: raw.tenant.id,
          name: raw.tenant.name,
          slug: raw.tenant.slug,
          plan: raw.tenant.plan,
          active: raw.tenant.active ?? true,
          timezone: raw.tenant.timezone || "UTC",
          logoUrl: toAbsoluteImageUrl(raw.tenant.logoUrl),
          primaryColor: raw.tenant.primaryColor ?? null,
        }
      : null,
  };
}

export const profileApi = {
  async me(): Promise<Profile> {
    const raw = await apiGet<AuthMeResponse>("/api/auth/me");
    return normalize(raw);
  },

  /**
   * Phase 2G — self-service profile update. Backed by the additive
   * `PATCH /api/auth/me` route. The server accepts a partial body and
   * returns the full re-normalised profile so the cache can swap
   * straight to it without a follow-up fetch.
   */
  async update(patch: ProfileUpdate): Promise<Profile> {
    const raw = await apiPatch<AuthMeResponse, ProfileUpdate>(
      "/api/auth/me",
      patch,
    );
    return normalize(raw);
  },
};
