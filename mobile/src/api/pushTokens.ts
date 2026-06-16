/**
 * Push token registration client.
 *
 * Talks to /api/mobile/push-tokens (Phase 1B foundation). The backend
 * currently stubs persistence — tokens are logged but not yet
 * delivered against. The mobile contract is finalized so the worker
 * in Phase 1C can plug in without further mobile changes.
 */

import { apiDelete, apiPost } from "./client";

export type RegisterPushTokenInput = {
  token: string;
  platform?: "ios" | "android" | "web";
  deviceLabel?: string;
};

export const pushTokensApi = {
  register(payload: RegisterPushTokenInput): Promise<{ ok: true; persisted: boolean }> {
    return apiPost("/api/mobile/push-tokens", payload);
  },
  /** Detach a push token. Pass THIS device's token to remove only this
   *  device (the server scopes the delete to the authenticated user). With
   *  no token the server clears ALL of the user's devices — only intended
   *  for a full account wipe, NOT a normal sign-out. */
  unregister(token?: string): Promise<{ ok: true }> {
    return apiDelete("/api/mobile/push-tokens", token ? { data: { token } } : undefined);
  },
};
