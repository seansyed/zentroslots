/**
 * networkStore — single source of truth for connectivity status.
 *
 * Mobile-first detection without pulling NetInfo into the dep tree:
 *   • Web:    `navigator.onLine` + `online`/`offline` window events.
 *   • Native: best-effort optimistic "online" — Expo SDK 52 with no
 *             NetInfo plugin can't reliably detect connectivity, and
 *             react-query's retry semantics + AppState refetch already
 *             smooth over flaky links well. If a request fails three
 *             times in 15 s the failure heuristic flips the banner so
 *             the operator still sees a clear "we're offline" cue.
 *
 * Surfaces consumed:
 *   - OfflineBanner   — listens for isOnline=false.
 *   - StalenessHint   — pairs with lastOnlineAt to render "cached" pill.
 *   - queryPersistence— rehydrates the query cache from AsyncStorage on
 *                       boot so the first paint after cold-start shows
 *                       last-known appointment data even without network.
 */

import * as React from "react";
import { Platform } from "react-native";
import { create } from "zustand";

const IS_WEB = Platform.OS === "web";

type NetworkState = {
  /** True when we believe the device has a network connection. */
  isOnline: boolean;
  /** ms timestamp of the last time we observed an online state. */
  lastOnlineAt: number | null;
  /** Internal subscriber count so multiple mounts share one listener. */
  _refCount: number;
  /** Internal teardown function for the web listeners. */
  _unsub: (() => void) | null;

  /** Idempotently start listening for connectivity events. */
  attach(): void;
  /** Decrement subscriber count + detach the listener when at 0. */
  detach(): void;
  /**
   * Manually tag a request failure as a connectivity signal. Three
   * consecutive failures inside a 15 s window flip the banner — useful
   * on native where we don't have NetInfo.
   */
  reportRequestFailure(): void;
  /** Manually clear the offline state when a request finally succeeds. */
  reportRequestSuccess(): void;
};

let failureBucket = 0;
let failureWindowResetAt = 0;

export const useNetworkStore = create<NetworkState>((set, get) => ({
  isOnline: true,
  lastOnlineAt: Date.now(),
  _refCount: 0,
  _unsub: null,

  attach() {
    const next = get()._refCount + 1;
    set({ _refCount: next });
    if (get()._unsub) return; // already listening

    if (!IS_WEB) return; // no native listener (see file header)

    const handleOnline = () => {
      set({ isOnline: true, lastOnlineAt: Date.now() });
      failureBucket = 0;
    };
    const handleOffline = () => {
      set({ isOnline: false });
    };

    // Capture the initial state in case we mounted while already offline.
    if (typeof navigator !== "undefined" && "onLine" in navigator) {
      set({
        isOnline: navigator.onLine,
        lastOnlineAt: navigator.onLine ? Date.now() : get().lastOnlineAt,
      });
    }

    if (typeof window !== "undefined") {
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
      set({
        _unsub: () => {
          window.removeEventListener("online", handleOnline);
          window.removeEventListener("offline", handleOffline);
        },
      });
    }
  },

  detach() {
    const next = Math.max(0, get()._refCount - 1);
    set({ _refCount: next });
    if (next === 0) {
      get()._unsub?.();
      set({ _unsub: null });
    }
  },

  reportRequestFailure() {
    const now = Date.now();
    if (now > failureWindowResetAt) {
      failureBucket = 0;
      failureWindowResetAt = now + 15_000; // 15-second window
    }
    failureBucket += 1;
    if (failureBucket >= 3 && get().isOnline) {
      set({ isOnline: false });
    }
  },

  reportRequestSuccess() {
    failureBucket = 0;
    if (!get().isOnline) {
      set({ isOnline: true, lastOnlineAt: Date.now() });
    } else {
      // Keep the timestamp moving so "last synced" feels live.
      set({ lastOnlineAt: Date.now() });
    }
  },
}));

/** Hook helper — attaches on mount, detaches on unmount. */
export function useNetworkAttach(): void {
  const attach = useNetworkStore((s) => s.attach);
  const detach = useNetworkStore((s) => s.detach);
  React.useEffect(() => {
    attach();
    return () => detach();
  }, [attach, detach]);
}
