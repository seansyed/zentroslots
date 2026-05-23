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
  hoverScale = false,
  showOnlineDot = false,
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
  /** Adds a hover scale (1.03) + slight shadow lift. Use on cards where
   *  the avatar is part of an interactive surface; leave off for static
   *  inline displays to avoid hover artifacts on non-clickable elements. */
  hoverScale?: boolean;
  /** Renders a small emerald dot in the lower-right corner. Use to
   *  indicate "calendar connected" / "live" status. Caller decides
   *  semantics — this is just the visual primitive. */
  showOnlineDot?: boolean;
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

  // Shared hover treatment — applied to either branch so initials +
  // image avatars feel identical on interactive cards.
  const hoverClasses = hoverScale
    ? "transition-transform duration-200 ease-out hover:scale-[1.03] hover:shadow-[0_4px_14px_rgba(15,23,42,0.16)]"
    : "";

  if (useImage) {
    return (
      <span
        className={cn(
          "relative inline-block shrink-0 overflow-hidden rounded-full bg-surface-inset",
          ring && "ring-1 ring-border/60",
          hoverClasses,
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
          loading="lazy"
          decoding="async"
          className={cn(
            "h-full w-full object-cover transition-opacity duration-[280ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
            loaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
        {showOnlineDot && <OnlineDot size={size} />}
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
        hoverClasses,
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
      {showOnlineDot && <OnlineDot size={size} />}
    </span>
  );
}

// ─── Online dot — small emerald presence indicator ─────────────────
//
// Caller decides semantics ("calendar connected", "online now", etc.);
// this is purely the visual primitive. Sized to look balanced against
// each Avatar size and offset so it visually sits on the bottom-right
// edge of the circular avatar.
function OnlineDot({ size }: { size: AvatarSize }) {
  const dot: Record<AvatarSize, string> = {
    xs: "h-1.5 w-1.5 ring-[1.5px] -right-0 -bottom-0",
    sm: "h-2 w-2 ring-2 -right-0 -bottom-0",
    md: "h-2.5 w-2.5 ring-2 right-0 bottom-0",
    lg: "h-3 w-3 ring-2 right-0 bottom-0",
    xl: "h-3.5 w-3.5 ring-[3px] right-0.5 bottom-0.5",
  };
  return (
    <span
      aria-label="online"
      className={cn(
        "absolute block rounded-full bg-emerald-500 ring-white",
        dot[size],
      )}
    />
  );
}

export default Avatar;
