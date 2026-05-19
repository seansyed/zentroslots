"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";

type Params = { token: string };

export default function ResetPasswordPage({ params }: { params: Promise<Params> }) {
  const router = useRouter();
  const { token } = use(params);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) {
      setError("Password must be at least 10 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "Could not reset password.");
        return;
      }
      setDone(true);
      // Don't auto-redirect — let the user click in. Forces them
      // through the login flow so the new password is exercised.
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-800">
          <h1 className="text-lg font-semibold">Password updated</h1>
          <p className="mt-2">
            Your password has been changed and any existing sessions have been
            signed out. Please sign in with your new password.
          </p>
          <button
            onClick={() => router.push("/dashboard/login")}
            className="mt-4 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Go to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold">Set a new password</h1>
      <p className="mt-2 text-sm text-slate-600">
        Choose a strong password. Minimum 10 characters. After saving, all
        existing sessions for this account will be signed out.
      </p>

      <form onSubmit={submit} className="mt-6 space-y-3 rounded-lg border bg-white p-6 shadow-sm">
        <input
          type="password"
          required
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border px-3 py-2 text-sm"
          autoComplete="new-password"
        />
        <input
          type="password"
          required
          placeholder="Confirm new password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full rounded-md border px-3 py-2 text-sm"
          autoComplete="new-password"
        />
        {error && <div className="text-sm text-red-600">{humanize(error)}</div>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Saving…" : "Reset password"}
        </button>
      </form>
    </div>
  );
}

function humanize(s: string): string {
  if (s === "invalid_or_expired") return "This reset link is invalid or has expired. Request a new one.";
  if (s === "rate_limited") return "Too many attempts. Please wait an hour and try again.";
  if (s === "invalid_request") return "Could not process the request.";
  return s;
}
