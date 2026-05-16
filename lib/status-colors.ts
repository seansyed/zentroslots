/**
 * Centralized booking status palette. Used by calendar blocks, table
 * badges, and the detail drawer so every surface tells the same story.
 *
 * Each tone returns Tailwind classes — we don't return raw hex so dark
 * mode + tenant accent overrides keep working.
 */

export type Status = "pending" | "confirmed" | "cancelled" | "completed" | "no_show";

export const STATUS_LABEL: Record<Status, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  completed: "Completed",
  no_show: "No-show",
};

// Used by status badges + table rows.
export const STATUS_BADGE: Record<Status, string> = {
  pending:   "bg-amber-50 text-amber-800 border-amber-200",
  confirmed: "bg-blue-50 text-blue-700 border-blue-200",
  cancelled: "bg-slate-100 text-slate-500 border-slate-200 line-through decoration-slate-400",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  no_show:   "bg-red-50 text-red-700 border-red-200",
};

// Used by calendar event blocks — solid left border + soft fill.
export const STATUS_EVENT: Record<Status, string> = {
  pending:   "bg-amber-50 border-l-amber-400 text-amber-900",
  confirmed: "bg-blue-50 border-l-blue-500 text-blue-900",
  cancelled: "bg-slate-50 border-l-slate-300 text-slate-500 line-through",
  completed: "bg-emerald-50 border-l-emerald-500 text-emerald-900",
  no_show:   "bg-red-50 border-l-red-500 text-red-900",
};

// Soft dot for compact contexts (mini-calendar, agenda rail).
export const STATUS_DOT: Record<Status, string> = {
  pending:   "bg-amber-400",
  confirmed: "bg-blue-500",
  cancelled: "bg-slate-300",
  completed: "bg-emerald-500",
  no_show:   "bg-red-500",
};

/**
 * Deterministic service color from a UUID — keeps unrelated services
 * visually distinct without requiring an opt-in color per service.
 * If `services.color` is set, that always wins.
 */
const SERVICE_PALETTE = [
  "#2563eb", // blue
  "#7c3aed", // violet
  "#0d9488", // teal
  "#ea580c", // orange
  "#db2777", // pink
  "#65a30d", // lime
  "#0891b2", // cyan
  "#c026d3", // fuchsia
];

export function serviceColor(serviceId: string, explicit: string | null | undefined): string {
  if (explicit) return explicit;
  let hash = 0;
  for (let i = 0; i < serviceId.length; i++) hash = (hash * 31 + serviceId.charCodeAt(i)) >>> 0;
  return SERVICE_PALETTE[hash % SERVICE_PALETTE.length];
}
