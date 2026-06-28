/**
 * Business Phone API (P1.3, mobile). Thin wrappers over the entitlement-gated
 * server routes. No Telnyx here — the server places the bridge leg only when the
 * feature flag + config are present, and returns 402/403/503 otherwise.
 */

import { apiGet, apiPatch, apiPost } from "./client";
import type { MobilePhoneStatus } from "../lib/businessPhone";

export type { MobilePhoneStatus };

export type PhoneMe = {
  hasBusinessPhone: boolean;
  lineEnabled: boolean;
  canPlaceCalls: boolean;
  businessNumber: string | null;
  bridgePhoneNumberConfigured: boolean;
  bridgePhoneNumberMasked: string | null;
  usage: { period: string; minutesUsed: number; cap: number } | null;
};

export type PhoneCallRow = {
  id: string;
  direction: string;
  fromNumber: string | null;
  toNumber: string | null;
  status: string;
  startedAt: string | null;
  durationSeconds: number | null;
  missed: boolean;
};

export type PlaceCallBody = {
  toNumber?: string;
  customerId?: string;
  callPurpose?: "new_call" | "callback_missed" | "customer_call";
};

export type PlaceCallResult = {
  ok: boolean;
  callId: string | null;
  status: string;
  callerId: string | null;
};

export const phoneApi = {
  /** Mobile-ready Business Phone status (drives the Phone screen state). */
  status(): Promise<MobilePhoneStatus> {
    return apiGet<MobilePhoneStatus>("/api/tenant/phone/status");
  },
  me(): Promise<PhoneMe> {
    return apiGet<PhoneMe>("/api/tenant/phone/me");
  },
  updateMe(body: { bridgePhoneNumber?: string | null; enabled?: boolean }): Promise<PhoneMe> {
    return apiPatch<PhoneMe, typeof body>("/api/tenant/phone/me", body);
  },
  placeCall(body: PlaceCallBody): Promise<PlaceCallResult> {
    return apiPost<PlaceCallResult, PlaceCallBody>("/api/tenant/phone/calls", body);
  },
  calls(params?: { status?: string; limit?: number }): Promise<{ calls: PhoneCallRow[]; hasMore: boolean }> {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    q.set("limit", String(params?.limit ?? 25));
    return apiGet<{ calls: PhoneCallRow[]; hasMore: boolean }>(`/api/tenant/business-line/calls?${q.toString()}`);
  },
};
