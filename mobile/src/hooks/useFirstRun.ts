/**
 * useFirstRun — first-launch onboarding gate.
 *
 * The auth gate in app/_layout.tsx routes authed users straight to
 * (tabs). For first-time users that lands them in an empty Appointments
 * tab with no context about the product. We insert a tiny gate before
 * the tabs that surfaces a 3-step onboarding flow once — and only
 * once — per install.
 *
 * Storage:
 *   • AsyncStorage key `zentromeet:firstRun:v1`.
 *   • Single string field — present = seen, absent = not seen.
 *   • The "v1" suffix means we can re-run onboarding for everyone in
 *     the future by bumping to v2 (useful when we ship a meaningful
 *     new flow).
 *
 * Why AsyncStorage instead of SecureStore:
 *   • Not sensitive — losing the flag at worst shows onboarding twice.
 *   • SecureStore throws on web in some browsers; AsyncStorage doesn't.
 *
 * API:
 *   const { hydrated, seen, markSeen } = useFirstRun();
 *   if (!hydrated) return null;          // still loading the flag
 *   if (!seen) return <OnboardingPager />;
 */

import * as React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { bootBreadcrumb } from "@/lib/safeInit";

const STORAGE_KEY = "zentromeet:firstRun:v1";

type State =
  | { hydrated: false; seen: false }
  | { hydrated: true; seen: boolean };

export function useFirstRun() {
  const [state, setState] = React.useState<State>({ hydrated: false, seen: false });

  React.useEffect(() => {
    bootBreadcrumb("firstRun");
    let cancelled = false;
    (async () => {
      try {
        const v = await AsyncStorage.getItem(STORAGE_KEY);
        if (!cancelled) setState({ hydrated: true, seen: Boolean(v) });
      } catch {
        // Storage unavailable — fail open and assume seen so we don't
        // trap the user behind onboarding they can't dismiss.
        if (!cancelled) setState({ hydrated: true, seen: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const markSeen = React.useCallback(async () => {
    setState({ hydrated: true, seen: true });
    try {
      await AsyncStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      // Already optimistically marked seen in state — the disk write
      // failure just means we'll show onboarding again on the next
      // cold start. Acceptable.
    }
  }, []);

  return {
    hydrated: state.hydrated,
    seen: state.seen,
    markSeen,
  };
}
