/**
 * StalenessHint — micro pill that explains where the data on screen came from.
 *
 * Three modes auto-selected from props:
 *   • Refreshing (isFetching=true)     →  "Refreshing…"
 *   • Online + recent (default)        →  no render (nothing to say)
 *   • Online + stale (>2m)             →  "Updated Xm ago"
 *   • Offline                          →  "Cached · Xm ago"
 *
 * Pairs with OfflineBanner — banner says "we're offline", this pill
 * says "what you're looking at was last fetched at X." Together they
 * give the operator full confidence in what's real vs cached.
 *
 * Calm, hairline-bordered surface — never competes with primary data.
 */

import * as React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { AppText } from "@/components/ui/Text";
import { useNetworkStore } from "@/store/networkStore";
import { colors, radius, spacing } from "@/theme";

type Props = {
  /** Epoch ms of the last successful fetch (react-query's dataUpdatedAt). */
  dataUpdatedAt: number | null | undefined;
  /** True while a refetch is in flight. */
  isFetching?: boolean;
  /** Threshold (ms) beyond which "fresh" data is considered stale. Defaults to 2 min. */
  staleAfterMs?: number;
  style?: ViewStyle;
};

function relativeShort(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export function StalenessHint({
  dataUpdatedAt,
  isFetching,
  staleAfterMs = 2 * 60 * 1000,
  style,
}: Props) {
  const isOnline = useNetworkStore((s) => s.isOnline);

  // Re-render the pill every 30s so "X ago" keeps drifting forward without
  // a global tick infrastructure.
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const id = setInterval(() => force(), 30_000);
    return () => clearInterval(id);
  }, []);

  if (isFetching) {
    return (
      <View style={[styles.pill, style]}>
        <View style={styles.spinnerDot} />
        <AppText variant="micro" style={styles.label}>
          Refreshing…
        </AppText>
      </View>
    );
  }

  if (!dataUpdatedAt) return null;
  const age = Date.now() - dataUpdatedAt;

  // Hide when fresh + online — silence is the right answer.
  if (isOnline && age < staleAfterMs) return null;

  return (
    <View style={[styles.pill, !isOnline && styles.pillOffline, style]}>
      <Ionicons
        name={isOnline ? "time-outline" : "archive-outline"}
        size={11}
        color={isOnline ? colors.inkSubtle : colors.warningInk}
      />
      <AppText
        variant="micro"
        style={[
          styles.label,
          { color: isOnline ? colors.inkSubtle : colors.warningInk, marginLeft: 4 },
        ]}
      >
        {isOnline ? `Updated ${relativeShort(age)}` : `Cached · ${relativeShort(age)}`}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: "rgba(255,255,255,0.8)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    alignSelf: "flex-start",
  },
  pillOffline: {
    backgroundColor: colors.warningSubtle,
    borderColor: colors.warningInk,
  },
  spinnerDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: colors.brand,
    marginRight: 5,
  },
  label: {
    letterSpacing: 0.3,
    color: colors.inkSubtle,
  },
});
