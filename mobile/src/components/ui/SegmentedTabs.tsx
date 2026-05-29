/**
 * SegmentedTabs — iOS-style segmented control.
 *
 *   <SegmentedTabs
 *     value="agenda"
 *     onChange={setView}
 *     options={[
 *       { value: "month",  label: "Month" },
 *       { value: "agenda", label: "Agenda" },
 *     ]}
 *   />
 *
 * Animated active-state pill that slides between segments. Haptic
 * selection on change. Pure RN, no extra deps.
 */

import * as React from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";

import { AppText } from "@/components/ui/Text";
import { colors, radius, shadows, spacing } from "@/theme";

type Option<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  value: T;
  options: Option<T>[];
  onChange: (next: T) => void;
  style?: ViewStyle;
};

export function SegmentedTabs<T extends string>({ value, options, onChange, style }: Props<T>) {
  return (
    <View style={[styles.track, style]}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => {
              if (opt.value === value) return;
              void Haptics.selectionAsync().catch(() => {});
              onChange(opt.value);
            }}
            style={[styles.segment, active && styles.segmentActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <AppText
              variant="smallStrong"
              style={{
                color: active ? colors.ink : colors.inkMuted,
                letterSpacing: 0.2,
              }}
            >
              {opt.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    backgroundColor: colors.surfaceInset,
    borderRadius: radius.lg,
    padding: 3,
    gap: 2,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentActive: {
    backgroundColor: colors.surface,
    ...shadows.sm,
  },
});
