/**
 * Logo / ZentroMeetLogo — the OFFICIAL ZentroMeet brand badge.
 *
 * Renders the exact official badge image bundled at assets/zentromeet-logo.png
 * (the circular "ZENTROMEET · APPOINTMENTS. AUTOMATION. GROWTH." mark with the
 * stylized Z). It is the real brand asset — NOT a redrawn SVG, NOT a generated
 * text wordmark. The badge already contains the wordmark + tagline, so there is
 * no separate text lockup. Bundled via require() so it always renders in release
 * (Hermes) with no remote URL and no SVG-engine dependency, and never collapses
 * to zero size (explicit width/height).
 *
 * Tenant branding is a SEPARATE concept: pass `tenantLogoUrl` to render a
 * tenant's OWN uploaded logo on tenant-branded surfaces; on load failure it
 * falls back to the bundled ZentroMeet badge so the UI is never empty. Platform
 * surfaces (login, boot, Home header, Settings) intentionally show the
 * ZentroMeet identity and do NOT pass tenantLogoUrl.
 */

import * as React from "react";
import { Image, View, type ViewStyle } from "react-native";

// Bundled official badge — exact attached asset (1417×1417, transparent).
// require() is resolved + bundled at build time by Metro.
const MARK = require("../../../assets/zentromeet-logo.png");

type Props = {
  /** Rendered square size in px (width = height). */
  size?: number;
  /** Tenant's own uploaded logo (absolute URL). Overrides the platform badge. */
  tenantLogoUrl?: string | null;
  style?: ViewStyle;
  accessibilityLabel?: string;
};

export function Logo({
  size = 40,
  tenantLogoUrl,
  style,
  accessibilityLabel = "ZentroMeet",
}: Props) {
  const [tenantFailed, setTenantFailed] = React.useState(false);
  const useTenant = Boolean(tenantLogoUrl) && !tenantFailed;

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={[{ width: size, height: size }, style]}
    >
      <Image
        source={useTenant ? { uri: tenantLogoUrl as string } : MARK}
        onError={useTenant ? () => setTenantFailed(true) : undefined}
        resizeMode="contain"
        // Explicit non-zero dimensions so the layout can never collapse it.
        style={{ width: size, height: size }}
        fadeDuration={0}
      />
    </View>
  );
}

/** Explicit, self-describing alias for the official platform badge. */
export const ZentroMeetLogo = Logo;
