"use client";

import * as React from "react";

type Severity = "info" | "warning" | "critical";

type Announcement = {
  id: string;
  title: string;
  body: string;
  severity: string;
  linkUrl: string | null;
  linkLabel: string | null;
};

const PALETTE: Record<Severity, string> = {
  info: "border-blue-200 bg-blue-50 text-blue-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  critical: "border-red-200 bg-red-50 text-red-900",
};

const STORAGE_KEY = "dismissed_announcements_v1";

// Dismissed announcements are tracked client-side in localStorage. We
// don't persist dismissal server-side because the tenant admin and staff
// are different humans — a per-user table would be the next step if
// users start sharing logins. For now this is good enough.
function readDismissed(): Set<string> {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.map(String));
  } catch {
    /* swallow */
  }
  return new Set();
}

function writeDismissed(ids: Set<string>) {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
    }
  } catch {
    /* swallow */
  }
}

export default function TenantAnnouncementBanner({
  announcement,
}: {
  announcement: Announcement | null;
}) {
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => {
    if (!announcement) return;
    const set = readDismissed();
    if (set.has(announcement.id)) setDismissed(true);
  }, [announcement]);

  if (!announcement || dismissed) return null;

  const severity = (["info", "warning", "critical"] as const).includes(announcement.severity as Severity)
    ? (announcement.severity as Severity)
    : "info";

  function dismiss() {
    if (!announcement) return;
    const set = readDismissed();
    set.add(announcement.id);
    writeDismissed(set);
    setDismissed(true);
  }

  return (
    <div className={`mb-4 flex items-start gap-3 rounded-lg border p-4 text-sm ${PALETTE[severity]}`}>
      <div className="flex-1 min-w-0">
        <div className="font-medium">{announcement.title}</div>
        <div className="mt-0.5 whitespace-pre-wrap text-xs opacity-90">{announcement.body}</div>
        {announcement.linkUrl && (
          <a
            href={announcement.linkUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1.5 inline-block text-xs font-medium underline"
          >
            {announcement.linkLabel ?? "Learn more"}
          </a>
        )}
      </div>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-1 text-current opacity-60 hover:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}
