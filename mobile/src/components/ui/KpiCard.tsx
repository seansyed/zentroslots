/**
 * KpiCard — premium stat tile for the Home dashboard.
 *
 *   <KpiCard
 *     label="Today"
 *     value="6"
 *     unit="bookings"
 *     icon="calendar"
 *     delta={+2}     // optional. positive = green ↑, negative = red ↓
 *     sparkline={[2,3,1,4,3,5,6]}  // optional 7-pt micro-trend
 *     tone="brand"   // brand | success | warning | neutral
 *   />
 *
 * Pure presentational — no data fetching, no haptics. Press feedback
 * comes from the wrapping <PressableCard> when callers wrap it.
 */

import * as React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { AppText } from "@/components/ui/Text";
import { Card } from "@/components/ui/Card";
import { colors, radius, shadows, spacing, typography } from "@/theme";

type Tone = "brand" | "success" | "warning" | "neutral" | "violet";

type Props = {
  label: string;
  value: string | number;
  unit?: string;
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  /** Numeric delta vs previous period (rendered with ▲/▼). */
  delta?: number;
  /** Override the delta label (e.g., "vs last week"). */
  deltaLabel?: string;
  /** Tiny inline trend — up to ~12 points, rendered as a sparkline bar row. */
  sparkline?: number[];
  tone?: Tone;
  style?: ViewStyle;
};

const TONE_MAP: Record<Tone, { iconBg: string; iconFg: string; sparkline: string }> = {
  brand: { iconBg: colors.brandSubtle, iconFg: colors.brand, sparkline: colors.brand },
  success: { iconBg: colors.successSubtle, iconFg: colors.successInk, sparkline: colors.success },
  warning: { iconBg: colors.warningSubtle, iconFg: colors.warningInk, sparkline: colors.warning },
  neutral: { iconBg: colors.surfaceInset, iconFg: colors.inkMuted, sparkline: colors.inkSubtle },
  violet: { iconBg: colors.violetSubtle, iconFg: colors.violet, sparkline: colors.violet },
};

export function KpiCard({
  label,
  value,
  unit,
  icon,
  delta,
  deltaLabel,
  sparkline,
  tone = "brand",
  style,
}: Props) {
  const t = TONE_MAP[tone];
  return (
    <Card variant="plain" padding={spacing.lg} style={[styles.card, style]}>
      <View style={styles.headerRow}>
        <AppText variant="micro" color="subtle" style={styles.label}>
          {label.toUpperCase()}
        </AppText>
        {icon ? (
          <View style={[styles.iconBubble, { backgroundColor: t.iconBg }]}>
            <Ionicons name={icon} size={14} color={t.iconFg} />
          </View>
        ) : null}
      </View>

      <View style={styles.valueRow}>
        <AppText
          style={{
            ...typography.displayMd,
            color: colors.ink,
            fontVariant: ["tabular-nums"],
          }}
        >
          {value}
        </AppText>
        {unit ? (
          <AppText
            variant="small"
            color="muted"
            style={{ marginLeft: 4, marginBottom: 4 }}
          >
            {unit}
          </AppText>
        ) : null}
      </View>

      {/* Delta + sparkline row */}
      {(delta !== undefined || sparkline) ? (
        <View style={styles.footRow}>
          {delta !== undefined ? <DeltaChip value={delta} label={deltaLabel} /> : <View />}
          {sparkline && sparkline.length > 1 ? (
            <Sparkline values={sparkline} color={t.sparkline} />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function DeltaChip({ value, label }: { value: number; label?: string }) {
  if (value === 0) {
    return (
      <View style={[styles.deltaChip, { backgroundColor: colors.surfaceInset }]}>
        <AppText variant="micro" style={{ color: colors.inkMuted }}>
          ◦ flat{label ? ` ${label}` : ""}
        </AppText>
      </View>
    );
  }
  const positive = value > 0;
  const bg = positive ? colors.successSubtle : colors.dangerSubtle;
  const fg = positive ? colors.successInk : colors.dangerInk;
  return (
    <View style={[styles.deltaChip, { backgroundColor: bg }]}>
      <AppText variant="micro" style={{ color: fg, fontVariant: ["tabular-nums"] }}>
        {positive ? "▲" : "▼"} {Math.abs(value)}{label ? ` ${label}` : ""}
      </AppText>
    </View>
  );
}

/** Tiny bar-sparkline — purely styled views, no SVG dep needed. */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values, 1);
  return (
    <View style={styles.spark}>
      {values.map((v, i) => (
        <View
          key={i}
          style={{
            width: 3,
            height: 4 + Math.round((v / max) * 18),
            borderRadius: 1.5,
            backgroundColor: color,
            opacity: 0.4 + (i / values.length) * 0.6,
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    overflow: "hidden",
    ...shadows.sm,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  label: {
    letterSpacing: 0.6,
    color: colors.inkSubtle,
  },
  iconBubble: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  valueRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    marginTop: spacing.sm,
  },
  footRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.md,
  },
  deltaChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
  },
  spark: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    height: 22,
  },
});
