/**
 * ActivityRow — timeline-style activity feed entry.
 *
 *   <ActivityRow
 *     icon="calendar"
 *     tone="success"
 *     title="New booking from Olivia Wilson"
 *     subtitle="Tax Planning Session · in 3h"
 *     timestamp="2m ago"
 *   />
 *
 * Visual: small tinted dot/icon bubble on the left, title + subtitle
 * stacked, right-aligned timestamp. Optional connector line above
 * (lineAbove) for stacked rows that read as a vertical timeline.
 */

import * as React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { AppText } from "@/components/ui/Text";
import { colors, radius, spacing } from "@/theme";

type Tone = "brand" | "success" | "warning" | "danger" | "neutral" | "violet";

const TONE_MAP: Record<Tone, { bg: string; fg: string }> = {
  brand: { bg: colors.brandSubtle, fg: colors.brand },
  success: { bg: colors.successSubtle, fg: colors.successInk },
  warning: { bg: colors.warningSubtle, fg: colors.warningInk },
  danger: { bg: colors.dangerSubtle, fg: colors.dangerInk },
  neutral: { bg: colors.surfaceInset, fg: colors.inkMuted },
  violet: { bg: colors.violetSubtle, fg: colors.violet },
};

type Props = {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  tone?: Tone;
  title: string;
  subtitle?: string;
  timestamp?: string;
  lineAbove?: boolean;
  lineBelow?: boolean;
  style?: ViewStyle;
};

export function ActivityRow({
  icon,
  tone = "brand",
  title,
  subtitle,
  timestamp,
  lineAbove,
  lineBelow,
  style,
}: Props) {
  const t = TONE_MAP[tone];
  return (
    <View style={[styles.row, style]}>
      {/* Left rail: connector line + dot/icon */}
      <View style={styles.rail}>
        <View style={[styles.connector, !lineAbove && { opacity: 0 }]} />
        <View style={[styles.bubble, { backgroundColor: t.bg }]}>
          <Ionicons name={icon} size={14} color={t.fg} />
        </View>
        <View style={[styles.connector, !lineBelow && { opacity: 0 }]} />
      </View>

      {/* Body */}
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <AppText variant="bodyStrong" numberOfLines={2} style={{ flex: 1 }}>
            {title}
          </AppText>
          {timestamp ? (
            <AppText variant="micro" color="subtle" style={styles.timestamp}>
              {timestamp}
            </AppText>
          ) : null}
        </View>
        {subtitle ? (
          <AppText variant="small" color="muted" numberOfLines={1} style={{ marginTop: 2 }}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: spacing.md,
    minHeight: 56,
  },
  rail: {
    width: 28,
    alignItems: "center",
  },
  connector: {
    flex: 1,
    width: 2,
    backgroundColor: colors.borderSubtle,
    borderRadius: 1,
  },
  bubble: {
    width: 28,
    height: 28,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 4,
  },
  body: {
    flex: 1,
    paddingTop: 6,
    paddingBottom: spacing.sm,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  timestamp: {
    letterSpacing: 0.2,
    marginTop: 2,
  },
});
