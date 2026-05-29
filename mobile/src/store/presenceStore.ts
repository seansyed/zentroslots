/**
 * presenceStore — mobile-only ephemeral presence state.
 *
 * Tracks whether the user is "Available", "Busy", or "Paused" for new
 * bookings. Persisted to SecureStore so the toggle survives app
 * restarts. Backend support is NOT yet wired — this is a local UI
 * surface today, ready to sync to a future PATCH /api/me/presence
 * endpoint when it ships.
 *
 * Why local-only:
 *   • The strict rule for Phase 2B says "no backend refactors".
 *   • Surfacing the toggle now gives the operator a tangible "vibe"
 *     control and previews the UX. When backend support lands, the
 *     setter swaps in a fetch() call before persisting — single edit.
 */

import { create } from "zustand";

import { STORAGE_KEYS, storage } from "@/lib/storage";

export type Presence = "available" | "busy" | "paused";

type Override = {
  /** "Today only" override — auto-clears at midnight tomorrow. */
  state: Presence;
  expiresAtMs: number;
};

type PresenceState = {
  /** Persisted default presence. */
  base: Presence;
  /** Optional override that auto-clears at expiresAtMs. */
  override: Override | null;
  /** Hydrated from SecureStore on cold start. */
  hydrated: boolean;

  /** Effective presence right now (override → base). */
  current(): Presence;

  hydrate(): Promise<void>;
  setBase(p: Presence): Promise<void>;
  setTodayOnly(p: Presence): Promise<void>;
  clearOverride(): Promise<void>;
};

const KEY = (STORAGE_KEYS as Record<string, string>).presence ?? "zm_presence";

async function persist(state: { base: Presence; override: Override | null }) {
  try {
    await storage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore — presence is best-effort */
  }
}

function nowMs() {
  return Date.now();
}

function startOfTomorrowMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  base: "available",
  override: null,
  hydrated: false,

  current() {
    const { base, override } = get();
    if (override && override.expiresAtMs > nowMs()) return override.state;
    return base;
  },

  async hydrate() {
    try {
      const raw = await storage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { base?: Presence; override?: Override | null };
        const base = parsed.base ?? "available";
        const override = parsed.override && parsed.override.expiresAtMs > nowMs()
          ? parsed.override
          : null;
        set({ base, override, hydrated: true });
        return;
      }
    } catch {
      /* fall through to default */
    }
    set({ hydrated: true });
  },

  async setBase(p: Presence) {
    const state = { base: p, override: null };
    set({ ...state, hydrated: true });
    await persist(state);
  },

  async setTodayOnly(p: Presence) {
    const override: Override = { state: p, expiresAtMs: startOfTomorrowMs() };
    const state = { base: get().base, override };
    set({ ...state, hydrated: true });
    await persist(state);
  },

  async clearOverride() {
    const state = { base: get().base, override: null };
    set({ ...state, hydrated: true });
    await persist(state);
  },
}));
