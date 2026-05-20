"use client";

import * as React from "react";

import { cn } from "@/lib/cn";
import { deriveInitials } from "@/lib/identity";

// Avatar — reusable, premium avatar primitive.
//
// Renders either:
//   • <img> with a soft mask + subtle ring + premium fade-in when an
//     avatarUrl is provided, OR
//   • a gradient initials disc derived from the display name when no
//     image is set.
//
// Use this everywhere a workforce identity surfaces — booking pages,
// workforce directory, service cards, appointment cards, drawer
// previews — so initials, sizing, ring treatment, and load states
// stay visually consistent.

type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const SIZE: Record<AvatarSize, { box: string; text: string; ring: string }> = {
  xs: { box: "h-6 w-6",   text: "text-[9.5px]", ring: "ring-[1.5px]" },
  sm: { box: "h-8 w-8",   text: "text-[11px]",  ring: "ring-[1.5px]" },
  md: { box: "h-10 w-10", text: "text-[13px]",  ring: "ring-2" },
  lg: { box: "h-14 w-14", text: "text-[16px]",  ring: "ring-2" },
  xl: { box: "h-20 w-20", text: "text-[22px]",  ring: "ring-2" },
};

// Deterministic gradient per name so the same person always shows
// the same disc color. Picks from a curated brand-friendly palette.
const GRADIENTS: { from: string; to: string }[] = [
  { from: "#359df3", to: "#7c3aed" },
  { from: "#7c3aed", to: "#db2777" },
  { from: "#0d9488", to: "#0891b2" },
  { from: "#0891b2", to: "#359df3" },
  { from: "#ea580c", to: "#db2777" },
  { from: "#65a30d", to: "#0d9488" },
  { from: "#c026d3", to: "#7c3aed" },
  { from: "#db2777", to: "#ea580c" },
];

function hashTo(name: string, modulo: number): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % modulo;
}

export function Avatar({
  src,
  name,
  size = "md",
  ring = true,
  className,
}: {
  /** Image URL or null/undefined to render initials fallback. */
  src?: string | null;
  /** Display name — drives initials + gradient when no image. */
  name: string;
  /** Visual size. Default md (40px). */
  size?: AvatarSize;
  /** Subtle ring/border treatment (default true). */
  ring?: boolean;
  /** Extra classes to merge onto the root. */
  className?: string;
}) {
  const cfg = SIZE[size];
  const [loaded, setLoaded] = React.useState(false);
  const [errored, setErrored] = React.useState(false);
  const imgRef = React.useRef<HTMLImageElement | null>(null);
  const useImage = Boolean(src) && !errored;

  // Reset state when src changes (e.g. after avatar upload).
  React.useEffect(() => {
    setLoaded(false);
    setErrored(false);
  }, [src]);

  // Browser cache race fix: if the image is already complete by the
  // time React mounts (because the browser served it from cache),
  // the <img onLoad> handler never fires — so we'd stay stuck at
  // opacity-0 forever. Check img.complete after mount and on every
  // src change, and resolve `loaded` synchronously if it is.
  React.useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    if (img.complete && img.naturalWidth > 0) {
      setLoaded(true);
    } else if (img.complete && img.naturalWidth === 0 && src) {
      // Completed but with zero dimensions = load failed.
      setErrored(true);
    }
  }, [src]);

  if (useImage) {
    return (
      <span
        className={cn(
          "relative inline-block shrink-0 overflow-hidden rounded-full bg-surface-inset",
          ring && "ring-1 ring-border/60",
          cfg.box,
          className,
        )}
        aria-label={name}
      >
        {/* Soft shimmer while the image decodes — premium loading */}
        {!loaded && (
          <span
            aria-hidden
            className="absolute inset-0 animate-pulse bg-gradient-to-br from-surface-inset via-white/40 to-surface-inset"
          />
        )}
        <img
          ref={imgRef}
          src={src!}
          alt={name}
          className={cn(
            "h-full w-full object-cover transition-opacity duration-[280ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
            loaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
      </span>
    );
  }

  // Initials fallback — deterministic gradient per name.
  const initials = deriveInitials(name);
  const grad = GRADIENTS[hashTo(name || "·", GRADIENTS.length)]!;

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight text-white shadow-[0_2px_8px_rgba(15,23,42,0.10)]",
        ring && "ring-1 ring-white/40",
        cfg.box,
        cfg.text,
        className,
      )}
      style={{
        backgroundImage: `linear-gradient(135deg, ${grad.from}, ${grad.to})`,
      }}
      aria-label={name}
    >
      {/* Subtle highlight stroke at the top — adds depth */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-1/2 rounded-t-full bg-gradient-to-b from-white/22 to-transparent"
      />
      <span className="relative">{initials}</span>
    </span>
  );
}

export default Avatar;
