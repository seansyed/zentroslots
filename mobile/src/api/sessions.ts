/**
 * Active sessions — read + revoke.
 *
 * Wraps three endpoints exposed by the scheduling-saas backend:
 *
 *   GET    /api/auth/sessions                   — list + last 50 events
 *   POST   /api/auth/sessions/:jti/revoke       — revoke one session
 *   POST   /api/auth/sessions/revoke-all        — revoke every session
 *                                                 except the calling one
 *
 * The backend stores audit events forever and synthesises an "active
 * sessions" view from the most recent login event per JTI. We pass
 * that shape through to the UI unchanged — there's no native concept
 * to translate, and the operator surface mirrors the web one.
 */

import { apiGet, apiPost } from "./client";

export type SessionRow = {
  jti: string;
  loggedInAt: string; // ISO timestamp from server
  ipAddress: string | null;
  userAgent: string | null;
  deviceLabel: string | null;
  isCurrent: boolean;
  revoked: boolean;
  revokedAt: string | null;
};

export type SessionAuditEvent = {
  id: string;
  tenantId: string;
  userId: string;
  eventType: string;
  sessionJti: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  deviceLabel: string | null;
  detail: unknown;
  createdAt: string;
};

export type SessionsResponse = {
  currentJti: string | null;
  sessions: SessionRow[];
  events: SessionAuditEvent[];
};

export const sessionsApi = {
  async list(): Promise<SessionsResponse> {
    return apiGet<SessionsResponse>("/api/auth/sessions");
  },

  async revoke(jti: string): Promise<{ ok: boolean }> {
    // Path-encoded JTI — the route uses it as a path parameter.
    return apiPost<{ ok: boolean }>(
      `/api/auth/sessions/${encodeURIComponent(jti)}/revoke`,
    );
  },

  async revokeAll(): Promise<{ ok: boolean }> {
    return apiPost<{ ok: boolean }>("/api/auth/sessions/revoke-all");
  },
};
