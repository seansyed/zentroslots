/**
 * PageHeader — compact enterprise top bar for non-Home tabs.
 *
 * The Home tab keeps its luxury GradientHeroCard. Every OTHER tab uses
 * this header instead — it's the Linear / Slack / Notion idiom of:
 *
 *     ┌────────────────────────────────────────────────┐
 *     │  Title           [chip]   [bell]   [avatar]   │
 *     │  optional subtitle line in muted ink           │
 *     └────────────────────────────────────────────────┘
 *
 * Goal: preserve density (no half-screen hero on every screen), keep
 * the premium feel (proper avatar + live bell + optional presence
 * chip), and stay consistent across tabs so muscle memory works.
 *
 *   <PageHeader title="Schedule" subtitle="May 2026" trailing={<...>} />
 *
 * Notes:
 *   • Bell + avatar are always present when the user is signed in.
 *   • `subtitle` is optional; collapses cleanly when omitted.
 *   • `trailing` slots in NEXT to the bell + avatar — use it for the
 *     month-flip arrows on the calendar tab, the filter chip on
 *     customers, etc. Anything contextual to the screen.
 *   • `showPresence` adds a small availability chip (Online / Away /
 *     DND) tappable to /settings. Off by default; pages that want it
 *     opt in explicitly.
 */

import * as React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import { Avatar } from "@/components/ui/Avatar";
import { NotificationBellButton } from "@/components/ui/NotificationBellButton";
import { PresencePill } from "@/components/ui/PresencePill";
import { AppText } from "@/components/ui/Text";
import { useProfile } from "@/hooks/useProfile";
import { usePresenceStore } from "@/store/presenceStore";
import { colors, layout, spacing } from "@/theme";

type Props = {
  /** Required — the primary page title. Truncates on long strings. */
  title: string;
  /** Optional — small line beneath the title. Use for "May 2026" /
   *  "12 customers · 4 VIPs" / etc. Hidden when empty. */
  subtitle?: string;
  /** Optional — element rendered to the LEFT of bell+avatar. Use for
   *  per-page contextual controls (e.g. month nav arrows on Calendar). */
  trailing?: React.ReactNode;
  /** Show the availability presence pill between title + trailing.
   *  Default off — pages opt in. */
  showPresence?: boolean;
};

export function PageHeader({
  title,
  subtitle,
  trailing,
  showPresence = false,
}: Props) {
  const router = useRouter();
  const { data: profile } = useProfile();
  const presence = usePresenceStore((s) => s.current());

  function onAvatarPress() {
    void Haptics.selectionAsync().catch(() => {});
    router.push("/(tabs)/settings");
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.titleCol}>
        <AppText
          variant="h2"
          numberOfLines={1}
          style={styles.title}
        >
          {title}
        </AppText>
        {subtitle ? (
          <AppText
            variant="small"
            color="muted"
            numberOfLines={1}
            style={styles.subtitle}
          >
            {subtitle}
          </AppText>
        ) : null}
      </View>

      <View style={styles.actions}>
        {showPresence ? (
          <PresencePill
            state={presence}
            size="sm"
            onPress={onAvatarPress}
          />
        ) : null}
        {trailing}
        <NotificationBellButton />
        <Pressable
          onPress={onAvatarPress}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={
            profile?.name ? `Settings — signed in as ${profile.name}` : "Settings"
          }
        >
          <Avatar
            name={profile?.name ?? "?"}
            uri={profile?.avatarUrl ?? undefined}
            size={36}
          />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.md,
    // Hairline separator below the header so it reads as its own band
    // when content scrolls beneath. Uses border subtle so it doesn't
    // shout — same restraint as the bottom tab bar's top hairline.
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surface,
  },
  titleCol: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: colors.ink,
    letterSpacing: -0.2,
  },
  subtitle: {
    marginTop: 2,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
});
