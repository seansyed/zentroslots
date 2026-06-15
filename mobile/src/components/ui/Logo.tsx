/**
 * Logo — the official ZentroMeet brand mark + wordmark.
 *
 * Vector transcription of the canonical brand assets
 * (public/zentromeet-mark.svg, public/zentromeet-wordmark.svg) so the
 * logo renders crisp at any size with no bundled raster asset. Brand
 * blue #359df3 + ink #0f172a, matching the web app exactly.
 *
 * Variants:
 *   • "mark"     — the circular badge alone (square). Use in compact
 *                  spots (boot screen, headers).
 *   • "wordmark" — badge + "ZentroMeet" lockup (+ optional tagline).
 *                  Use on the login / auth screen.
 *
 * Tenant branding: pass `tenantLogoUrl` to render a tenant's OWN uploaded
 * logo instead of the platform mark (for tenant-branded surfaces). It
 * falls back to the ZentroMeet mark if the image fails to load, so the UI
 * is never empty. Platform surfaces (login, boot) intentionally always
 * show the ZentroMeet identity and do NOT pass tenantLogoUrl.
 */

import * as React from "react";
import { Image, StyleSheet, Text, View, type ViewStyle } from "react-native";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";

const BRAND = "#359df3";
const INK = "#0f172a";

type LogoVariant = "mark" | "wordmark";

type Props = {
  variant?: LogoVariant;
  /** Height in px. For "mark" this is also the width (square). */
  size?: number;
  /** Tenant's own uploaded logo (absolute URL). Overrides the platform mark. */
  tenantLogoUrl?: string | null;
  /** Show the "Appointments. Automation. Growth." tagline (wordmark only). */
  showTagline?: boolean;
  style?: ViewStyle;
  accessibilityLabel?: string;
};

/** The circular "Z" badge — viewBox 0 0 160 160. */
function Mark({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 160 160">
      <Circle cx={80} cy={80} r={80} fill={BRAND} />
      <Rect x={40} y={40} width={80} height={15} fill={INK} />
      <Rect x={40} y={105} width={80} height={15} fill={INK} />
      <Line x1={118} y1={48} x2={42} y2={112} stroke={INK} strokeWidth={22} />
      <Path d="M 128 64 L 130 70 L 136 72 L 130 74 L 128 80 L 126 74 L 120 72 L 126 70 Z" fill={INK} />
      <Path d="M 139 79 L 140 83 L 144 84 L 140 85 L 139 89 L 138 85 L 134 84 L 138 83 Z" fill={INK} />
    </Svg>
  );
}

export function Logo({
  variant = "mark",
  size = 40,
  tenantLogoUrl,
  showTagline = false,
  style,
  accessibilityLabel = "ZentroMeet",
}: Props) {
  const [tenantFailed, setTenantFailed] = React.useState(false);
  const useTenant = Boolean(tenantLogoUrl) && !tenantFailed;

  // Tenant-branded surface: render the tenant's own logo (square, contained),
  // falling back to the platform mark if it can't load.
  if (useTenant) {
    return (
      <View
        accessibilityRole="image"
        accessibilityLabel={accessibilityLabel}
        style={[{ width: size, height: size }, style]}
      >
        <Image
          source={{ uri: tenantLogoUrl as string }}
          onError={() => setTenantFailed(true)}
          resizeMode="contain"
          style={{ width: size, height: size }}
        />
      </View>
    );
  }

  if (variant === "mark") {
    return (
      <View
        accessibilityRole="image"
        accessibilityLabel={accessibilityLabel}
        style={style}
      >
        <Mark size={size} />
      </View>
    );
  }

  // Wordmark: badge + "ZentroMeet" lockup. Font size scales with `size`.
  const fontSize = Math.round(size * 0.46);
  const taglineSize = Math.max(10, Math.round(size * 0.14));
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={[styles.wordmarkRow, style]}
    >
      <Mark size={size} />
      <View style={styles.wordmarkText}>
        <Text style={[styles.lockup, { fontSize }]} allowFontScaling={false}>
          <Text style={{ color: BRAND }}>Zentro</Text>
          <Text style={{ color: INK }}>Meet</Text>
        </Text>
        {showTagline ? (
          <Text style={[styles.tagline, { fontSize: taglineSize }]} numberOfLines={1}>
            Appointments. Automation. Growth.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wordmarkRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  wordmarkText: {
    marginLeft: 10,
    justifyContent: "center",
  },
  lockup: {
    fontWeight: "800",
    letterSpacing: -0.8,
  },
  tagline: {
    color: "#475569",
    fontWeight: "500",
    marginTop: 2,
  },
});
