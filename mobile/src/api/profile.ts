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
  } | null;
  /** Surfaced from /api/auth/me so the Settings screen can show a
   *  "Connect Google Calendar" CTA without an extra round-trip. */
  googleConnected: boolean;
};

type AuthMeResponse = {
  id: string;
  email: string;
  name: string;
  role: string;
  timezone: string;
  avatarUrl?: string | null;
  googleConnected?: boolean;
  tenant?: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    active?: boolean;
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
    avatarUrl: raw.avatarUrl ?? null,
    timezone: raw.timezone ?? "UTC",
    googleConnected: Boolean(raw.googleConnected),
    tenant: raw.tenant
      ? {
          id: raw.tenant.id,
          name: raw.tenant.name,
          slug: raw.tenant.slug,
          plan: raw.tenant.plan,
          active: raw.tenant.active ?? true,
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
