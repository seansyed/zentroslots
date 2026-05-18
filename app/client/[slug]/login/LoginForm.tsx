"use client";

import * as React from "react";

export default function LoginForm({
  slug,
  accentColor,
}: {
  slug: string;
  accentColor: string;
}) {
  const [email, setEmail] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/client/${encodeURIComponent(slug)}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      // Deliberate: success regardless of whether the email exists.
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the link.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full" style={{ backgroundColor: "#dcfce7" }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-6 w-6 text-green-600">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="mt-4 text-base font-semibold tracking-tight text-slate-900">Check your inbox</h2>
        <p className="mt-1 text-sm text-slate-600">
          If <span className="font-medium text-slate-900">{email}</span> matches a booking with us, we&rsquo;ve sent a sign-in link. It expires in 15 minutes.
        </p>
        <button
          onClick={() => {
            setSent(false);
            setEmail("");
          }}
          className="mt-6 text-xs text-slate-500 hover:text-slate-900"
        >
          ← Try a different email
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold tracking-tight text-slate-900">Sign in</h2>
      <p className="mt-1 text-sm text-slate-600">
        Enter the email you used to book. We&rsquo;ll send you a one-tap sign-in link — no password needed.
      </p>

      <div className="mt-5">
        <label htmlFor="cli-email" className="block text-xs font-medium uppercase tracking-wider text-slate-500">
          Email
        </label>
        <input
          id="cli-email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
        />
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={busy || !email.trim()}
        className="mt-5 inline-flex w-full items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        style={{ backgroundColor: accentColor }}
      >
        {busy ? "Sending…" : "Email me a sign-in link"}
      </button>
      <p className="mt-3 text-center text-[11px] text-slate-500">
        We won&rsquo;t share your email. The link works for 15 minutes only.
      </p>
    </form>
  );
}
