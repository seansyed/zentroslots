"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

type Announcement = {
  id: string;
  title: string;
  body: string;
  severity: string;
  audience: string;
  linkUrl: string | null;
  linkLabel: string | null;
  publishedAt: string;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
};

const SEVERITY_BG: Record<string, string> = {
  info: "bg-blue-50 border-blue-200 text-blue-900",
  warning: "bg-amber-50 border-amber-200 text-amber-900",
  critical: "bg-red-50 border-red-200 text-red-900",
};

export default function AnnouncementsClient({ initial }: { initial: Announcement[] }) {
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);

  return (
    <>
      <div className="mt-4 flex justify-end">
        <button
          onClick={() => setCreating((v) => !v)}
          className="rounded-md bg-brand-accent px-3 py-1.5 text-sm font-medium text-white"
        >
          {creating ? "Cancel" : "+ New announcement"}
        </button>
      </div>
      {creating && <NewForm onCreated={() => { setCreating(false); router.refresh(); }} />}

      <div className="mt-4 space-y-3">
        {initial.length === 0 && (
          <div className="rounded-lg border bg-white p-8 text-center text-sm text-slate-500">
            No announcements yet — create one to broadcast to your tenants.
          </div>
        )}
        {initial.map((a) => (
          <AnnouncementCard key={a.id} a={a} onChanged={() => router.refresh()} />
        ))}
      </div>
    </>
  );
}

function AnnouncementCard({ a, onChanged }: { a: Announcement; onChanged: () => void }) {
  const [busy, setBusy] = React.useState(false);
  async function remove() {
    if (!confirm(`Delete "${a.title}"? This is permanent.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/admin/announcements/${a.id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  const expired = a.expiresAt && new Date(a.expiresAt) < new Date();
  return (
    <div className={`rounded-lg border p-4 ${SEVERITY_BG[a.severity] ?? SEVERITY_BG.info} ${(!a.active || expired) ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full bg-white/70 px-2 py-0.5 font-medium">{a.severity}</span>
            <span className="rounded-full bg-white/70 px-2 py-0.5">audience: {a.audience}</span>
            <span className="text-ink-subtle">published {a.publishedAt.slice(0, 10)}</span>
            {a.expiresAt && <span className="text-ink-subtle">expires {a.expiresAt.slice(0, 10)}</span>}
            {!a.active && <span className="rounded-full bg-slate-200 px-2 py-0.5">inactive</span>}
            {expired && <span className="rounded-full bg-slate-200 px-2 py-0.5">expired</span>}
          </div>
          <h3 className="mt-2 text-base font-semibold">{a.title}</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm">{a.body}</p>
          {a.linkUrl && (
            <a href={a.linkUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm font-medium underline">
              {a.linkLabel ?? a.linkUrl}
            </a>
          )}
        </div>
        <button disabled={busy} onClick={remove} className="shrink-0 text-xs text-red-700 hover:underline disabled:opacity-50">Delete</button>
      </div>
    </div>
  );
}

function NewForm({ onCreated }: { onCreated: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState({
    title: "",
    body: "",
    severity: "info",
    audience: "all",
    linkUrl: "",
    linkLabel: "",
    expiresAt: "",
  });

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: draft.title,
          body: draft.body,
          severity: draft.severity,
          audience: draft.audience,
          linkUrl: draft.linkUrl || null,
          linkLabel: draft.linkLabel || null,
          expiresAt: draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border bg-white p-5 shadow-sm ring-2 ring-brand-accent">
      <h3 className="text-base font-medium">New announcement</h3>
      <div className="mt-3 grid gap-3 text-sm md:grid-cols-2">
        <L label="Title"><input className={INPUT} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Scheduled maintenance Saturday" /></L>
        <L label="Severity">
          <select className={INPUT} value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value })}>
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="critical">critical</option>
          </select>
        </L>
        <L label="Audience">
          <select className={INPUT} value={draft.audience} onChange={(e) => setDraft({ ...draft, audience: e.target.value })}>
            <option value="all">All tenants</option>
            <option value="free">Free tier only</option>
            <option value="pro">Pro only</option>
            <option value="enterprise">Enterprise only</option>
          </select>
        </L>
        <L label="Expires at (optional)"><input type="datetime-local" className={INPUT} value={draft.expiresAt} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })} /></L>
        <L label="Link URL (optional)"><input className={INPUT} value={draft.linkUrl} onChange={(e) => setDraft({ ...draft, linkUrl: e.target.value })} placeholder="https://status.example.com" /></L>
        <L label="Link label (optional)"><input className={INPUT} value={draft.linkLabel} onChange={(e) => setDraft({ ...draft, linkLabel: e.target.value })} placeholder="Status page" /></L>
      </div>
      <L label="Body (plain text, line breaks preserved)">
        <textarea rows={4} className={INPUT} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
      </L>
      {err && <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err}</div>}
      <div className="mt-4 flex gap-2 text-sm">
        <button disabled={busy || !draft.title || !draft.body} onClick={submit} className="rounded-md bg-brand-accent px-3 py-1.5 font-medium text-white disabled:opacity-50">Publish</button>
      </div>
    </div>
  );
}

const INPUT = "w-full rounded-md border border-border bg-white px-3 py-1.5";

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase text-ink-subtle">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
