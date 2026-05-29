/**
 * Avatar — circular initials fallback, image when available.
 */

import * as React from "react";
import { Image, StyleSheet, View } from "react-native";

import { initialsFromName } from "@/lib/format";
import { colors, radius } from "@/theme";

import { AppText } from "./Text";

type Props = {
  name?: string | null;
  uri?: string | null;
  size?: number;
  tone?: "brand" | "violet" | "emerald" | "amber" | "slate";
};

const TONE_BG: Record<NonNullable<Props["tone"]>, { bg: string; fg: string }> = {
  brand: { bg: colors.brandSubtle, fg: colors.brand },
  violet: { bg: colors.violetSubtle, fg: colors.violet },
  emerald: { bg: colors.emeraldSubtle, fg: colors.emerald },
  amber: { bg: colors.amberSubtle, fg: colors.amber },
  slate: { bg: colors.slateSubtle, fg: colors.slate },
};

export function Avatar({ name, uri, size = 40, tone = "brand" }: Props) {
  const t = TONE_BG[tone];
  if (uri) {
    return <Image source={{ uri }} style={[styles.base, { width: size, height: size, borderRadius: size / 2 }]} />;
  }
  return (
    <View
      style={[
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: t.bg,
        },
      ]}
    >
      <AppText
        style={{
          color: t.fg,
          fontSize: Math.round(size * 0.4),
          fontFamily: undefined, // inherits semibold from variant
        }}
        variant="bodyStrong"
      >
        {initialsFromName(name)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});
