/**
 * Staff API client.
 *
 *   GET /api/staff       — list all staff in the caller's tenant
 *                          with public identity + workforce metadata
 *
 * Used by Quick Create (staff picker) and Home (today's-team panel).
 */

import { apiGet } from "./client";

export type Staff = {
  id: string;
  name: string;
  email: string;
  role?: string;
  timezone?: string;
  avatarUrl?: string | null;
  bio?: string | null;
  specialties?: string[] | null;
  /** Public-facing identity (added by Phase 11). */
  publicDisplayName?: string | null;
  publicTitle?: string | null;
  publicAvatarUrl?: string | null;
};

export const staffApi = {
  async list(): Promise<Staff[]> {
    const raw = await apiGet<Staff[] | { rows: Staff[] }>("/api/staff");
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray((raw as { rows?: Staff[] }).rows)) {
      return (raw as { rows: Staff[] }).rows;
    }
    return [];
  },
};
