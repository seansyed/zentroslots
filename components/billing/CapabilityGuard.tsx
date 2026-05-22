"use client";

/**
 * Render `children` only when the named capability is unlocked.
 *
 * Use this when there is no good locked-state replacement — e.g.,
 * hiding a button entirely rather than showing a disabled version.
 *
 * For surfaces that benefit from a visible upgrade prompt, prefer
 * `UpgradeGate` or `LockedFeatureCard` instead.
 *
 * Fail-closed: when no provider is mounted (or the named capability
 * resolves to `allowed=false`), the fallback is rendered. The default
 * fallback is `null` — render nothing.
 */
import * as React from "react";

import { useCapability, type Capability } from "./CapabilityProvider";

export function CapabilityGuard({
  cap,
  children,
  fallback = null,
}: {
  cap: Capability;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const check = useCapability(cap);
  if (!check.allowed) return <>{fallback}</>;
  return <>{children}</>;
}
