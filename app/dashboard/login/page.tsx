"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"admin" | "staff" | "client">("admin");
  const [workspaceName, setWorkspaceName] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
  const [tz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit() {
    setLoading(true);
    setError(null);
    try {
      const url = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
      const body =
        mode === "login"
          ? { email, password }
          : {
              email,
              password,
              name,
              role,
              timezone: tz,
              ...(role === "admin"
                ? { workspaceName }
                : { tenantSlug }),
            };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      router.push("/dashboard");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold">
        {mode === "login" ? "Sign in" : "Create an account"}
      </h1>

      <div className="mt-6 space-y-3 rounded-lg border bg-white p-6 shadow-sm">
        {mode === "signup" && (
          <>
            <input
              placeholder="Full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm"
            />

            <select
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
              className="w-full rounded-md border px-3 py-2 text-sm"
            >
              <option value="admin">Admin (create new workspace)</option>
              <option value="staff">Staff (join existing workspace)</option>
              <option value="client">Client (join existing workspace)</option>
            </select>

            {role === "admin" ? (
              <input
                placeholder="Workspace name (e.g. Acme Tax Co.)"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            ) : (
              <input
                placeholder="Workspace slug (e.g. acme-tax)"
                value={tenantSlug}
                onChange={(e) => setTenantSlug(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            )}
          </>
        )}

        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border px-3 py-2 text-sm"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border px-3 py-2 text-sm"
        />

        {error && <div className="text-sm text-red-600">{error}</div>}

        <button
          onClick={submit}
          disabled={loading}
          className="w-full rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
        </button>

        <button
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
          className="w-full text-center text-xs text-slate-500 hover:text-slate-700"
        >
          {mode === "login" ? "No account? Sign up" : "Have an account? Sign in"}
        </button>

        {mode === "login" && (
          <a
            href="/forgot-password"
            className="block w-full text-center text-xs text-slate-500 hover:text-slate-700"
          >
            Forgot your password?
          </a>
        )}
      </div>
    </div>
  );
}
