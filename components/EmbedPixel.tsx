"use client";

import * as React from "react";

/**
 * Fire-and-forget embed-load tracking pixel. Designed for use only on
 * /embed/* pages so we can show conversion analytics in the dashboard.
 * Failures are silently swallowed — embeds must never break because of
 * analytics.
 */
export default function EmbedPixel({
  slug,
  serviceSlug,
}: {
  slug: string;
  serviceSlug?: string;
}) {
  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/embed-events", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, serviceSlug, kind: "embed.load" }),
    }).catch(() => { /* swallow */ });
    return () => { cancelled = true; void cancelled; };
  }, [slug, serviceSlug]);

  return null;
}
