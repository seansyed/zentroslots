"use client";

import { useState } from "react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          ...(tenantSlug ? { tenantSlug } : {}),
        }),
      });
    } catch {
      // Intentional: same generic success message regardless of
      // network outcome — no enumeration vector.
    } finally {
      setSubmitted(true);
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold">Forgot your password?</h1>
      <p className="mt-2 text-sm text-slate-600">
        Enter the email associated with your account. If we find a match,
        you&rsquo;ll receive a reset link within a minute.
      </p>

      {submitted ? (
        <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-800">
          If <span className="font-medium">{email || "that email"}</span> matches
          an account on this platform, a reset link is on its way. The link
          expires in 1 hour. Check your spam folder if it doesn&rsquo;t arrive.
          <div className="mt-4">
            <a
              href="/dashboard/login"
              className="text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
            >
              Back to sign in
            </a>
          </div>
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="mt-6 space-y-3 rounded-lg border bg-white p-6 shadow-sm"
        >
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
          <input
            type="text"
            placeholder="Workspace slug (optional)"
            value={tenantSlug}
            onChange={(e) => setTenantSlug(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Sending…" : "Send reset link"}
          </button>
          <a
            href="/dashboard/login"
            className="block w-full text-center text-xs text-slate-500 hover:text-slate-700"
          >
            Back to sign in
          </a>
        </form>
      )}
    </div>
  );
}
