"use client";

import * as React from "react";
import { Check, ChevronDown, Clock, Search } from "lucide-react";

import { cn } from "@/lib/cn";

// TimezonePicker — premium searchable IANA timezone selector.
//
// Source list:
//   • Modern Node/browser: Intl.supportedValuesOf("timeZone") returns
//     the canonical IANA list (~600 zones).
//   • Fallback: a curated list of ~120 most-common zones so the
//     control stays useful even when the runtime lacks the API.
//
// UX:
//   • Click to open a calm dropdown with a search input.
//   • Search filters on substring + a friendly transformation
//     ("america/los_angeles" → "america los angeles los_angeles").
//   • Keyboard nav: ↑/↓ to move, Enter to pick, Esc to close.
//   • Selected zone is highlighted; the current local UTC offset is
//     surfaced next to each label to help users disambiguate (e.g.
//     "America/Los_Angeles · GMT-7").

const FALLBACK_TIMEZONES = [
  "UTC",
  "Africa/Cairo", "Africa/Casablanca", "Africa/Johannesburg", "Africa/Lagos", "Africa/Nairobi",
  "America/Anchorage", "America/Argentina/Buenos_Aires", "America/Bogota", "America/Caracas",
  "America/Chicago", "America/Denver", "America/Detroit", "America/Edmonton",
  "America/Halifax", "America/Indiana/Indianapolis", "America/Los_Angeles", "America/Mexico_City",
  "America/Montreal", "America/New_York", "America/Phoenix", "America/Regina",
  "America/Santiago", "America/Sao_Paulo", "America/St_Johns", "America/Toronto",
  "America/Vancouver", "America/Winnipeg",
  "Asia/Bangkok", "Asia/Dubai", "Asia/Ho_Chi_Minh", "Asia/Hong_Kong", "Asia/Istanbul",
  "Asia/Jakarta", "Asia/Karachi", "Asia/Kolkata", "Asia/Kuala_Lumpur", "Asia/Manila",
  "Asia/Riyadh", "Asia/Seoul", "Asia/Shanghai", "Asia/Singapore", "Asia/Taipei",
  "Asia/Tehran", "Asia/Tokyo",
  "Atlantic/Azores", "Atlantic/Bermuda", "Atlantic/Cape_Verde", "Atlantic/Reykjavik",
  "Australia/Adelaide", "Australia/Brisbane", "Australia/Melbourne", "Australia/Perth", "Australia/Sydney",
  "Europe/Amsterdam", "Europe/Athens", "Europe/Berlin", "Europe/Brussels", "Europe/Bucharest",
  "Europe/Budapest", "Europe/Copenhagen", "Europe/Dublin", "Europe/Helsinki", "Europe/Istanbul",
  "Europe/Lisbon", "Europe/London", "Europe/Madrid", "Europe/Moscow", "Europe/Oslo",
  "Europe/Paris", "Europe/Prague", "Europe/Riga", "Europe/Rome", "Europe/Sofia",
  "Europe/Stockholm", "Europe/Vienna", "Europe/Warsaw", "Europe/Zurich",
  "Pacific/Auckland", "Pacific/Fiji", "Pacific/Honolulu", "Pacific/Tahiti",
];

function getZoneList(): string[] {
  try {
    type IntlAny = typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    };
    const fn = (Intl as IntlAny).supportedValuesOf;
    if (typeof fn === "function") {
      const list = fn("timeZone");
      if (Array.isArray(list) && list.length > 0) return list;
    }
  } catch {
    // ignore — fall through to curated list
  }
  return FALLBACK_TIMEZONES;
}

function formatOffset(timeZone: string): string | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
    });
    const parts = dtf.formatToParts(new Date());
    const offset = parts.find((p) => p.type === "timeZoneName")?.value;
    return offset ?? null;
  } catch {
    return null;
  }
}

// Lowercase + replace separators so substring search matches the
// hierarchical IANA syntax in either direction.
function searchKey(zone: string): string {
  return zone.toLowerCase().replace(/[_/]/g, " ");
}

export function TimezonePicker({
  value,
  onChange,
  disabled,
  placeholder = "Select timezone…",
  className,
}: {
  value: string | null;
  onChange: (zone: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [highlighted, setHighlighted] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  const allZones = React.useMemo(() => getZoneList(), []);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase().replace(/[_/]/g, " ");
    if (!q) return allZones;
    return allZones.filter((z) => searchKey(z).includes(q));
  }, [allZones, query]);

  // Close on outside click / Esc.
  React.useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus search input when opening.
  React.useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
      setHighlighted(0);
    }
  }, [open]);

  // Keep highlighted in bounds when filtered list shrinks.
  React.useEffect(() => {
    if (highlighted >= filtered.length) setHighlighted(Math.max(0, filtered.length - 1));
  }, [filtered.length, highlighted]);

  function pick(zone: string) {
    onChange(zone);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[highlighted];
      if (target) pick(target);
    }
  }

  // Scroll highlighted into view.
  React.useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlighted}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  const offset = value ? formatOffset(value) : null;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-left text-[13px] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
          "hover:border-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/40",
          disabled && "cursor-not-allowed bg-surface-inset opacity-60",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Clock className="h-3.5 w-3.5 shrink-0 text-ink-subtle" strokeWidth={1.75} />
          <span className={cn("truncate", value ? "text-ink" : "text-ink-subtle")}>
            {value ?? placeholder}
          </span>
          {offset && (
            <span className="shrink-0 rounded-full bg-surface-inset px-1.5 py-0.5 text-[10px] font-mono text-ink-muted">
              {offset}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-ink-subtle transition-transform duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
            open && "rotate-180",
          )}
          strokeWidth={2}
        />
      </button>

      {open && (
        <div
          className={cn(
            "absolute left-0 right-0 z-30 mt-1 overflow-hidden rounded-xl border border-border bg-surface shadow-[0_10px_30px_rgba(15,23,42,0.10)]",
            "animate-[zm-row-in_0.18s_cubic-bezier(0.16,1,0.3,1)_both]",
          )}
        >
          <div className="border-b border-border bg-surface px-2.5 py-2">
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface-inset/50 px-2">
              <Search className="h-3.5 w-3.5 text-ink-subtle" strokeWidth={2} />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search timezones…"
                className="w-full border-0 bg-transparent py-1.5 text-[12.5px] outline-none placeholder:text-ink-subtle"
              />
            </div>
          </div>

          <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-[12px] text-ink-subtle">
                No matches
              </div>
            ) : (
              filtered.map((zone, idx) => {
                const selected = zone === value;
                const highlight = idx === highlighted;
                const off = formatOffset(zone);
                return (
                  <button
                    key={zone}
                    type="button"
                    data-idx={idx}
                    onMouseEnter={() => setHighlighted(idx)}
                    onClick={() => pick(zone)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors",
                      highlight ? "bg-brand-subtle/60 text-ink" : "text-ink-muted hover:bg-surface-inset/60",
                      selected && "font-semibold text-ink",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Check
                        className={cn(
                          "h-3 w-3 shrink-0 text-brand-accent transition-opacity",
                          selected ? "opacity-100" : "opacity-0",
                        )}
                        strokeWidth={2.5}
                      />
                      <span className="truncate">{zone}</span>
                    </span>
                    {off && (
                      <span className="shrink-0 text-[10px] font-mono text-ink-subtle">{off}</span>
                    )}
                  </button>
                );
              })
            )}
          </div>

          <div className="border-t border-border bg-surface-inset/40 px-3 py-1.5 text-[10.5px] text-ink-subtle">
            {filtered.length} of {allZones.length} timezones
          </div>
        </div>
      )}
    </div>
  );
}

export default TimezonePicker;
