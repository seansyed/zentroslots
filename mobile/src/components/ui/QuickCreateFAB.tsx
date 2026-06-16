/**
 * QuickCreateFAB — the canonical "New booking" FAB used across tabs.
 *
 * Icon-only premium FAB (60dp circular, brand-tinted with ambient
 * halo). The label "New booking" lives in accessibilityLabel so
 * VoiceOver / TalkBack still announce the action — no visible label,
 * by design.
 *
 * Centralised so every tab gets identical positioning + behaviour.
 *
 * USAGE — must be passed as `floatingOverlay` on ScreenContainer, NOT
 * as a child:
 *
 *   <ScreenContainer scrollable floatingOverlay={<QuickCreateFAB />}>
 *     ...screen content...
 *   </ScreenContainer>
 *
 * Why: as a child, an absolute-positioned FAB inside a ScrollView
 * anchors to the scroll contentContainer (and scrolls away with the
 * content). As `floatingOverlay`, ScreenContainer renders it as a
 * viewport-anchored sibling so it stays pinned above the tab bar
 * regardless of scroll position. See ScreenContainer for details.
 */

import * as React from "react";
import { useRouter } from "expo-router";

import { FAB } from "@/components/ui/FAB";

export function QuickCreateFAB({ date }: { date?: string } = {}) {
  const router = useRouter();
  // When launched from a calendar day, pre-select that date in New Booking via
  // a ?date=YYYY-MM-DD param (quick-create clamps it to the bookable range).
  const href = date ? `/quick-create?date=${encodeURIComponent(date)}` : "/quick-create";
  return (
    <FAB
      icon="add"
      accessibilityLabel="New booking"
      onPress={() => router.push(href)}
    />
  );
}
