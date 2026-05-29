/**
 * DetailRow — labeled icon + value row used inside a detail card.
 *
 *   <DetailRow icon="time-outline" label="When" value="Today, 2:00 PM" />
 */

import * as React from "react";
import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { colors, radius, spacing } from "@/theme";

import { AppText } from "./Text";

type Props = {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  value: string | React.ReactNode;
  accent?: "brand" | "muted";
};

export function DetailRow({ icon, label, value, accent = "brand" }: Props) {
  return (
    <View style={styles.row}>
      <View
        style={[
          styles.iconWrap,
          accent === "brand"
            ? { backgroundColor: colors.brandSubtle }
            : { backgroundColor: colors.surfaceInset },
        ]}
      >
        <Ionicons
          name={icon}
          size={16}
          color={accent === "brand" ? colors.brand : colors.inkMuted}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="micro" color="subtle">
          {label.toUpperCase()}
        </AppText>
        {typeof value === "string" ? (
          <AppText variant="bodyStrong" style={{ marginTop: 2 }} numberOfLines={2}>
            {value}
          </AppText>
        ) : (
          <View style={{ marginTop: 2 }}>{value}</View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
});
