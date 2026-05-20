// lib/location-visual.ts — Shared workforce-location visual system.
//
// Single source of truth for the per-location color palette + the
// type-icon mapping + the hashing function that gives each location
// a stable color across pages. Extracted from StaffClient (Phase
// 16B) so the new Workforce Availability page can paint with the
// exact same swatches and the operator sees a consistent
// color->location bridge everywhere.
//
// Why this lives in lib (not components):
//   • The values are pure data, no React
//   • Server components can import the type icons safely
//   • Re-uses across StaffClient + WorkspaceHoursClient + any
//     future workforce surface (booking page hover, dashboard
//     hero, etc.) without copy-paste drift
//
// NOTE: Tailwind needs to see every class name at build time. The
// `haloHover` field is pre-prefixed with `hover:` so the JIT
// extractor picks it up. Never do `"hover:" + swatch.halo` at
// runtime — that string never reaches the extractor.

import { Building2, Globe, Video, type LucideIcon } from "lucide-react";

export type LocationType = "physical" | "virtual" | "hybrid";

export type LocationSwatch = {
  /** Soft tinted surface for backgrounds */
  surface: string;
  /** Ring tint for outlines */
  ring: string;
  /** Solid dot for chips */
  dot: string;
  /** Text accent matching the swatch */
  text: string;
  /** Hover-prefixed shadow halo applied on element hover. Pre-baked
   *  so Tailwind's JIT extractor sees the literal class. */
  haloHover: string;
};

export const LOCATION_PALETTE: readonly LocationSwatch[] = [
  { surface: "bg-sky-50/80",     ring: "ring-sky-300/40",     dot: "bg-sky-500",     text: "text-sky-700",     haloHover: "hover:shadow-[0_0_22px_rgba(14,165,233,0.22)]" },
  { surface: "bg-emerald-50/80", ring: "ring-emerald-300/40", dot: "bg-emerald-500", text: "text-emerald-700", haloHover: "hover:shadow-[0_0_22px_rgba(16,185,129,0.22)]" },
  { surface: "bg-amber-50/80",   ring: "ring-amber-300/40",   dot: "bg-amber-500",   text: "text-amber-700",   haloHover: "hover:shadow-[0_0_22px_rgba(245,158,11,0.22)]" },
  { surface: "bg-rose-50/80",    ring: "ring-rose-300/40",    dot: "bg-rose-500",    text: "text-rose-700",    haloHover: "hover:shadow-[0_0_22px_rgba(244,63,94,0.22)]" },
  { surface: "bg-indigo-50/80",  ring: "ring-indigo-300/40",  dot: "bg-indigo-500",  text: "text-indigo-700",  haloHover: "hover:shadow-[0_0_22px_rgba(99,102,241,0.22)]" },
  { surface: "bg-teal-50/80",    ring: "ring-teal-300/40",    dot: "bg-teal-500",    text: "text-teal-700",    haloHover: "hover:shadow-[0_0_22px_rgba(20,184,166,0.22)]" },
  { surface: "bg-orange-50/80",  ring: "ring-orange-300/40",  dot: "bg-orange-500",  text: "text-orange-700",  haloHover: "hover:shadow-[0_0_22px_rgba(249,115,22,0.22)]" },
  { surface: "bg-fuchsia-50/80", ring: "ring-fuchsia-300/40", dot: "bg-fuchsia-500", text: "text-fuchsia-700", haloHover: "hover:shadow-[0_0_22px_rgba(217,70,239,0.22)]" },
];

export const VIRTUAL_SWATCH: LocationSwatch = {
  surface: "bg-violet-50/80",
  ring: "ring-violet-300/40",
  dot: "bg-violet-500",
  text: "text-violet-700",
  haloHover: "hover:shadow-[0_0_28px_rgba(139,92,246,0.32)]",
};

/** Stable hash → palette index. Same locationId always picks the
 *  same swatch across reloads + pages. */
export function stableLocationIndex(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % LOCATION_PALETTE.length;
}

/** Resolve a location's swatch. Virtual always wins the violet
 *  "digital" treatment so the online surface is unmistakable. */
export function locationSwatch(locationId: string, locationType: LocationType): LocationSwatch {
  if (locationType === "virtual") return VIRTUAL_SWATCH;
  return LOCATION_PALETTE[stableLocationIndex(locationId)];
}

export function locationTypeIcon(t: LocationType): LucideIcon {
  if (t === "virtual") return Video;
  if (t === "hybrid") return Globe;
  return Building2;
}

/** Soft chip tone — independent of the per-location palette. Used
 *  when surfacing the type itself (e.g. an "online" chip on a
 *  location card) rather than identifying the specific location. */
export function locationTypeChipTone(t: LocationType): string {
  if (t === "virtual") return "bg-violet-50 text-violet-700 ring-violet-200/60";
  if (t === "hybrid") return "bg-sky-50 text-sky-700 ring-sky-200/60";
  return "bg-emerald-50 text-emerald-700 ring-emerald-200/60";
}

/** Short label for the type — "online" / "hybrid" / "physical". */
export function locationTypeLabel(t: LocationType): string {
  if (t === "virtual") return "online";
  if (t === "hybrid") return "hybrid";
  return "physical";
}
