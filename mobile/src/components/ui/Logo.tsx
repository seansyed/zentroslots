/**
 * Logo — the official ZentroMeet brand mark + wordmark.
 *
 * Uses a BUNDLED RASTER mark (assets/logo-mark.png, rasterized from the
 * official public/zentromeet-mark.svg) instead of inline react-native-svg.
 * Rationale: the previous SVG-based logo did not render on the physical
 * release (Hermes) build. A bundled PNG via require() is bulletproof in
 * release — it has no runtime SVG engine dependency and no remote URL — so
 * the platform logo always shows. The wordmark text is plain <Text> (always
 * renders). Explicit non-zero dimensions; aspect ratio preserved.
 *
 * Tenant branding: pass `tenantLogoUrl` to render a tenant's OWN uploaded
 * logo (tenant-branded surfaces only). On load failure it falls back to the
 * bundled ZentroMeet mark, so the UI is never empty. Platform surfaces
 * (login, boot) intentionally show the ZentroMeet identity and do NOT pass
 * tenantLogoUrl — and never depend on a remote URL.
 */

import * as React from "react";
import { Image, StyleSheet, Text, View, type ViewStyle } from "react-native";

const BRAND = "#359df3";
const INK = "#0f172a";

// Bundled official mark — rasterized from public/zentromeet-mark.svg (512px,
// transparent). require() is resolved + bundled at build time by Metro.
const MARK = require("../../../assets/logo-mark.png");

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

/** The bundled circular "Z" badge image at the given square size. */
function Mark({ size }: { size: number }) {
  return (
    <Image
      source={MARK}
      resizeMode="contain"
      // Explicit non-zero dimensions so the layout can never collapse it.
      style={{ width: size, height: size }}
      fadeDuration={0}
    />
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
  // falling back to the bundled platform mark if it can't load.
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
  const fontSize = Math.round(size * 0.5);
  const taglineSize = Math.max(10, Math.round(size * 0.16));
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
