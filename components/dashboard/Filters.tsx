"use client";

import * as React from "react";
import { Badge } from "@/components/ui/primitives";

export type FilterOption = { value: string; label: string };

export type FilterDef = {
  key: string;
  label: string;
  options: FilterOption[];
  multi?: boolean;
};

export type FilterState = Record<string, string[]>;

/**
 * Multi-select filter bar with pills + Clear all.
 * Stateless — caller owns the state so the same component
 * works on both the calendar (URL params) and appointments
 * page (in-memory).
 */
export default function Filters({
  defs,
  value,
  onChange,
}: {
  defs: FilterDef[];
  value: FilterState;
  onChange: (next: FilterState) => void;
}) {
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const totalSelected = Object.values(value).reduce((acc, v) => acc + v.length, 0);

  function toggle(defKey: string, optionValue: string) {
    const current = value[defKey] ?? [];
    const def = defs.find((d) => d.key === defKey);
    const multi = def?.multi ?? true;
    let next: string[];
    if (current.includes(optionValue)) {
      next = current.filter((v) => v !== optionValue);
    } else if (multi) {
      next = [...current, optionValue];
    } else {
      next = [optionValue];
    }
    const newState = { ...value, [defKey]: next };
    if (next.length === 0) delete newState[defKey];
    onChange(newState);
  }

  function clearAll() {
    onChange({});
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {defs.map((def) => {
        const selected = value[def.key] ?? [];
        const isOpen = openKey === def.key;
        return (
          <div key={def.key} className="relative">
            <button
              type="button"
              onClick={() => setOpenKey(isOpen ? null : def.key)}
              className={
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition " +
                (selected.length > 0
                  ? "border-brand-accent bg-brand-subtle text-brand-accent"
                  : "border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong")
              }
              aria-haspopup="listbox"
              aria-expanded={isOpen}
            >
              <span>{def.label}</span>
              {selected.length > 0 && (
                <Badge tone="blue" className="!py-0">{selected.length}</Badge>
              )}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden>
                <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {isOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setOpenKey(null)} aria-hidden />
                <div
                  role="listbox"
                  className="absolute left-0 z-20 mt-1 max-h-72 w-56 overflow-auto rounded-lg border border-border bg-surface p-1 shadow-md"
                >
                  {def.options.map((opt) => {
                    const checked = selected.includes(opt.value);
                    return (
                      <button
                        key={opt.value}
                        role="option"
                        aria-selected={checked}
                        onClick={() => toggle(def.key, opt.value)}
                        className={
                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition " +
                          (checked ? "bg-brand-subtle text-brand-accent" : "text-ink hover:bg-surface-inset")
                        }
                      >
                        <span
                          className={
                            "flex h-3.5 w-3.5 items-center justify-center rounded border " +
                            (checked ? "border-brand-accent bg-brand-accent text-white" : "border-border-strong")
                          }
                          aria-hidden
                        >
                          {checked && (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-2.5 w-2.5">
                              <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </span>
                        <span className="flex-1 truncate">{opt.label}</span>
                      </button>
                    );
                  })}
                  {def.options.length === 0 && (
                    <div className="px-2 py-3 text-center text-xs text-ink-subtle">No options</div>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}

      {totalSelected > 0 && (
        <button
          onClick={clearAll}
          className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

/**
 * Inline filter pills — render below the filter bar so users can
 * see + remove individual selections.
 */
export function FilterPills({
  defs,
  value,
  onChange,
}: {
  defs: FilterDef[];
  value: FilterState;
  onChange: (next: FilterState) => void;
}) {
  const pills = Object.entries(value).flatMap(([key, vs]) => {
    const def = defs.find((d) => d.key === key);
    return vs.map((v) => ({
      key,
      value: v,
      label: def?.options.find((o) => o.value === v)?.label ?? v,
      defLabel: def?.label ?? key,
    }));
  });

  if (pills.length === 0) return null;

  function remove(key: string, v: string) {
    const next = { ...value };
    const arr = (next[key] ?? []).filter((x) => x !== v);
    if (arr.length === 0) delete next[key];
    else next[key] = arr;
    onChange(next);
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {pills.map((p) => (
        <span
          key={`${p.key}:${p.value}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-ink"
        >
          <span className="text-ink-subtle">{p.defLabel}:</span>
          <span className="font-medium">{p.label}</span>
          <button
            onClick={() => remove(p.key, p.value)}
            aria-label={`Remove ${p.defLabel} ${p.label}`}
            className="text-ink-subtle hover:text-ink"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
