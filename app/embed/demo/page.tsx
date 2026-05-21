import Link from "next/link";

/**
 * Embed demo / sandbox page — Phase 16C
 *
 * Public, lightweight host page that loads the production /embed/v1.js
 * runtime and mounts the widget in the chosen mode. Used by the Widget
 * Studio's "Test popup" / "Test floating button" / "Open live sandbox"
 * actions so operators can verify the real embed before pasting the
 * snippet anywhere.
 *
 * Query params:
 *   tenant   (required)  — workspace slug
 *   service  (optional)  — service slug to preselect
 *   mode     (optional)  — inline | popup | floating  (default: inline)
 *   color    (optional)  — sanitized #rrggbb at the runtime layer
 *   label    (optional)  — button text for popup/floating
 *   radius   (optional)  — outer iframe radius
 *
 * Honest discipline:
 *   - No fake mode; the v1.js runtime decides what to mount based on
 *     real data-* attributes
 *   - Page reads params on the server, escapes everything that touches
 *     the DOM, and renders static markup the script then hydrates
 *   - Refuses to render if no tenant slug is provided
 */
export const dynamic = "force-dynamic";

const ALLOWED_MODES = new Set(["inline", "popup", "floating"]);

function sanitizeText(s: unknown, max = 64): string {
  if (typeof s !== "string") return "";
  return s.replace(/[<>"']/g, "").slice(0, max);
}
function sanitizeColor(s: unknown): string {
  if (typeof s !== "string") return "";
  return /^#?[0-9a-fA-F]{6}$/.test(s) ? (s.startsWith("#") ? s : `#${s}`) : "";
}
function sanitizeSlug(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(/[^a-z0-9-]/gi, "").slice(0, 80);
}
function sanitizeMode(s: unknown): "inline" | "popup" | "floating" {
  return typeof s === "string" && ALLOWED_MODES.has(s) ? (s as "inline" | "popup" | "floating") : "inline";
}
function sanitizeRadius(s: unknown): string {
  if (typeof s !== "string" || !/^\d{1,3}$/.test(s)) return "12";
  return String(Math.min(36, Math.max(0, parseInt(s, 10))));
}

export default async function EmbedDemoPage(props: {
  searchParams: Promise<{
    tenant?: string;
    service?: string;
    mode?: string;
    color?: string;
    label?: string;
    radius?: string;
  }>;
}) {
  const sp = await props.searchParams;
  const tenant = sanitizeSlug(sp.tenant);
  const service = sanitizeSlug(sp.service);
  const mode = sanitizeMode(sp.mode);
  const color = sanitizeColor(sp.color) || "#359df3";
  const label = sanitizeText(sp.label) || "Book a meeting";
  const radius = sanitizeRadius(sp.radius);

  if (!tenant) {
    return (
      <main className="mx-auto max-w-md p-10 text-center font-sans">
        <h1 className="text-lg font-semibold text-slate-900">Embed sandbox</h1>
        <p className="mt-2 text-sm text-slate-600">
          Provide a workspace slug to mount a real embed. e.g.{" "}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">/embed/demo?tenant=acme&amp;service=intro</code>
        </p>
      </main>
    );
  }

  const dataAttrs =
    mode === "inline"
      ? `data-zentromeet-inline data-zentromeet-tenant="${tenant}"${service ? ` data-zentromeet-service="${service}"` : ""} data-zentromeet-color="${color}" data-zentromeet-radius="${radius}"`
      : mode === "popup"
        ? `data-zentromeet-popup data-zentromeet-tenant="${tenant}"${service ? ` data-zentromeet-service="${service}"` : ""} data-zentromeet-color="${color}" data-zentromeet-label="${label}"`
        : `data-zentromeet-floating data-zentromeet-tenant="${tenant}"${service ? ` data-zentromeet-service="${service}"` : ""} data-zentromeet-color="${color}" data-zentromeet-label="${label}" data-zentromeet-position="bottom-right"`;

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white font-sans text-slate-900">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-blue-700 ring-1 ring-blue-200/55">
              Sandbox · {mode}
            </div>
            <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-slate-900">
              Embed preview · {tenant}
            </h1>
            <p className="mt-1 text-[12.5px] leading-relaxed text-slate-600">
              This page loads the production <code className="rounded bg-slate-100 px-1 py-px font-mono text-[11px]">/embed/v1.js</code> runtime and mounts the widget exactly the way it would on a customer&rsquo;s site.
            </p>
          </div>
          <Link
            href="/dashboard/settings/embed"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-[12px] font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
          >
            ← Back to Studio
          </Link>
        </div>

        {/* Demo host area — looks like a regular customer page */}
        <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_18px_40px_-18px_rgba(15,23,42,0.18)]">
          <div className="mb-6 border-b border-slate-100 pb-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Your site · sample content</div>
            <h2 className="mt-1 text-[18px] font-semibold tracking-tight text-slate-900">Welcome to our consulting practice</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-slate-600">
              This is a demo page representing your customer-facing website. The booking widget mounts below ({mode === "floating" ? "and as a launcher in the corner" : "naturally inside the page flow"}).
            </p>
          </div>

          {/* Mount target — runtime handles the rest */}
          {mode === "inline" && (
            <div
              style={{ maxWidth: "560px", margin: "0 auto", minHeight: "560px" }}
              // Marker only — script reads data-* on this element
              dangerouslySetInnerHTML={{ __html: `<div ${dataAttrs} style="max-width:560px;min-height:560px"></div>` }}
            />
          )}
          {mode === "popup" && (
            <div className="flex flex-col items-center gap-3 py-6">
              <p className="text-[12px] text-slate-500">Click the button below to open the booking modal:</p>
              <div
                dangerouslySetInnerHTML={{
                  __html: `<button type="button" ${dataAttrs} style="background:${color};color:#fff;border:0;padding:11px 18px;border-radius:10px;font:600 14px system-ui;cursor:pointer">${label}</button>`,
                }}
              />
              <p className="mt-2 text-[10.5px] text-slate-400">ESC or backdrop click closes the modal</p>
            </div>
          )}
          {mode === "floating" && (
            <div className="py-12 text-center">
              <p className="text-[12px] text-slate-500">
                Look at the bottom-right corner — the launcher mounts globally on the page.
              </p>
              <div dangerouslySetInnerHTML={{ __html: `<script ${dataAttrs}></script>` }} />
            </div>
          )}

          {/* More fake content so the floating launcher feels real */}
          {mode !== "inline" && (
            <div className="mt-8 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-2 rounded-full bg-slate-100" style={{ width: `${60 + ((i * 13) % 35)}%` }} />
              ))}
            </div>
          )}
        </section>

        <p className="mt-4 text-center text-[11px] text-slate-400">
          Powered by <a href="/dashboard/settings/embed" className="font-semibold text-slate-600 hover:text-slate-900">ZentroMeet Embed Widget Studio</a>
        </p>
      </div>

      {/* Production embed runtime */}
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <script async defer src="/embed/v1.js" />
    </main>
  );
}
