/**
 * Backend health — wraps the public `/api/health` route exposed by the
 * scheduling-saas backend. Returns a structured map of checks the
 * diagnostics screen can render.
 *
 * The endpoint is public (no auth required), force-dynamic, and very
 * fast on the EC2 box (~100-300ms). Safe to call on every diagnostics
 * mount + every pull-to-refresh.
 */

import { apiGet } from "./client";

export type HealthCheck = {
  ok: boolean;
  ms: number;
  detail?: string;
};

export type HealthResponse = {
  ok: boolean;
  version: string;
  env: string;
  time: string;
  checks: Record<string, HealthCheck>;
};

export const healthApi = {
  async get(): Promise<HealthResponse> {
    return apiGet<HealthResponse>("/api/health");
  },
};
