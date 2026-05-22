// lib/integrations.ts — Typed reader/writer for workspace-level
// integration enablement (migration 0035).
//
// Architecture ownership (do not violate):
//   Workspace ─ enables providers (this module)
//      ↓
//   Staff ──── owns connected calendars (calendarConnections)
//      ↓
//   Engine ── checks assigned-staff busy events (getExternalBusyForUser)
//
// This module is the GATING LAYER. It never touches OAuth tokens,
// never reads/writes sync state, and never branches the booking
// engine. All it does is answer "is this provider enabled for this
// workspace?" — and that answer gates new connect attempts.
//
// REFINEMENT #7: when a provider is disabled at the workspace
// level, existing per-staff connections in calendarConnections
// remain visible and the booking engine continues to honor their
// busy events. Reconnect/Connect is blocked until re-enabled.
// Disabling never deletes tokens or hides historical state — it
// blocks only the create-new path.

import { z } from "zod";

// ─── Provider registry ────────────────────────────────────────────
// `ProviderId` is the runtime union of supported tenant-toggleable
// integrations. Add new entries here (and to the validator below)
// when a new provider lands. The order is the canonical render
// order for UIs that enumerate providers.

export const PROVIDER_IDS = [
  "google_calendar",
  "outlook",
  "zoom",
  "teams",
  "slack",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderState = {
  enabled: boolean;
  enabledAt?: string;
};

export type EnabledIntegrations = Partial<Record<ProviderId, ProviderState>>;

const providerStateSchema = z.object({
  enabled: z.boolean(),
  enabledAt: z.string().optional(),
});

const providerIdSchema = z.enum(PROVIDER_IDS);

// PUT payload — single provider toggle.
export const integrationToggleSchema = z.object({
  provider: providerIdSchema,
  enabled: z.boolean(),
});

// ─── Safe accessor ────────────────────────────────────────────────
// Normalizes any-typed jsonb input into the strict shape and
// silently drops anything that doesn't validate. Used by the
// gate-check below + UI hydration so a malformed cell never blocks
// OAuth or crashes the integrations page.

export function readEnabledIntegrations(raw: unknown): EnabledIntegrations {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: EnabledIntegrations = {};
  for (const id of PROVIDER_IDS) {
    const v = obj[id];
    const parsed = providerStateSchema.safeParse(v);
    if (parsed.success) out[id] = parsed.data;
  }
  return out;
}

// ─── Gating logic ─────────────────────────────────────────────────
// REFINEMENT #2: missing provider key = IMPLICITLY ENABLED.
// This preserves current behavior for every tenant alive today —
// nothing breaks at rollout; an admin must explicitly DISABLE to
// gate a provider off.

export function isProviderEnabled(
  hours: EnabledIntegrations,
  provider: ProviderId,
): boolean {
  const v = hours[provider];
  if (!v) return true; // missing = implicitly enabled
  return v.enabled !== false;
}

// ─── UI-facing provider catalog ───────────────────────────────────
// Display metadata. Kept here (not in the UI module) so server
// components and client components share the same canonical name +
// "wired" flag without duplication. `wired` = "the OAuth + sync
// path actually exists today"; `false` providers are UI scaffolds
// that surface but do nothing.

export type ProviderCatalogEntry = {
  id: ProviderId;
  name: string;
  description: string;
  /** True = real OAuth + per-staff sync exists. False = scaffold. */
  wired: boolean;
  /** Category for grouping in the workspace integrations UI. */
  category: "calendar" | "video" | "chat";
};

export const PROVIDER_CATALOG: Record<ProviderId, ProviderCatalogEntry> = {
  google_calendar: {
    id: "google_calendar",
    name: "Google Calendar",
    description: "Per-staff busy-event sync + auto-create Google Meet links on confirmed bookings.",
    wired: true,
    category: "calendar",
  },
  outlook: {
    id: "outlook",
    name: "Microsoft Outlook",
    description: "Per-staff Outlook calendar sync via Microsoft Graph. Includes Teams meeting auto-creation.",
    wired: true, // Wave C — Graph adapter shipped
    category: "calendar",
  },
  zoom: {
    id: "zoom",
    name: "Zoom",
    description: "Auto-generate Zoom links on confirmed bookings. Coming soon.",
    wired: false,
    category: "video",
  },
  teams: {
    id: "teams",
    name: "Microsoft Teams",
    description: "Auto-generated when a service uses the Teams video provider; piggybacks on the Outlook connection. No separate setup.",
    wired: true, // Wave C — Teams meetings ride on the Microsoft connection
    category: "video",
  },
  slack: {
    id: "slack",
    name: "Slack",
    description: "Outbound operational alerts via webhook URL. Configure under workspace notifications.",
    wired: false,
    category: "chat",
  },
};
