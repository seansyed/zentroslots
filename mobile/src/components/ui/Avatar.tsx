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
  // Show the image only when a uri exists AND it hasn't failed to load. Reset
  // the failure flag whenever the uri changes so switching customers (or a new
  // photo at a new URL) re-attempts the image instead of showing a stale/blank
  // avatar. Initials show when there's no uri or the image genuinely fails.
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setFailed(false);
  }, [uri]);

  if (uri && !failed) {
    return (
      <Image
        source={{ uri }}
        onError={() => setFailed(true)}
        style={[styles.base, { width: size, height: size, borderRadius: size / 2 }]}
      />
    );
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
