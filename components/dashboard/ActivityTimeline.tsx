"use client";

import * as React from "react";
import { Skeleton } from "@/components/ui/primitives";

type AuditEntry = {
  id: string;
  action: string;
  actorLabel: string | null;
  entityType: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

const ACTION_LABEL: Record<string, string> = {
  "booking.create":     "Booking created",
  "booking.cancel":     "Booking cancelled",
  "booking.reschedule": "Booking rescheduled",
  "auth.login":         "Signed in",
  "location.create":    "Location added",
  "department.create":  "Department added",
};

const ACTION_DOT: Record<string, string> = {
  "booking.create":     "bg-blue-500",
  "booking.cancel":     "bg-slate-400",
  "booking.reschedule": "bg-amber-500",
  "auth.login":         "bg-emerald-500",
};

export default function ActivityTimeline({
  entityId,
  entityType,
  limit = 30,
}: {
  entityId?: string;
  entityType?: string;
  limit?: number;
}) {
  const [items, setItems] = React.useState<AuditEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const url = new URL("/api/audit", window.location.origin);
    if (entityId) url.searchParams.set("entityId", entityId);
    if (entityType) url.searchParams.set("entityType", entityType);
    url.searchParams.set("limit", String(limit));

    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setItems(data);
        else setError(data?.error ?? "Failed to load");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, [entityId, entityType, limit]);

  if (error) {
    return <div className="text-xs text-red-600">{error}</div>;
  }

  if (items === null) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="mt-1 h-2 w-2 rounded-full" />
            <div className="flex-1 space-y-1">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-2 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-ink-subtle">No activity yet.</div>;
  }

  return (
    <ol className="relative space-y-3 border-l border-border pl-4">
      {items.map((it) => (
        <li key={it.id} className="relative">
          <span
            className={"absolute -left-[7px] top-1.5 h-2 w-2 rounded-full ring-2 ring-surface " + (ACTION_DOT[it.action] ?? "bg-ink-subtle")}
            aria-hidden
          />
          <div className="text-sm text-ink">{ACTION_LABEL[it.action] ?? it.action}</div>
          <div className="mt-0.5 text-xs text-ink-subtle">
            {it.actorLabel ?? "System"} · {new Date(it.createdAt).toLocaleString()}
          </div>
        </li>
      ))}
    </ol>
  );
}
