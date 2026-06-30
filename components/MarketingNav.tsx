import Link from "next/link";

export default function MarketingNav() {
  return (
    <nav className="sticky top-0 z-10 border-b bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold">
          {/* ZentroMeet brand mark — circular blue Z badge */}
          <svg
            viewBox="0 0 160 160"
            className="h-6 w-6 rounded-full"
            aria-hidden
          >
            <circle cx="80" cy="80" r="80" fill="#2563EB" />
            <g fill="#0f172a">
              <rect x="40" y="40" width="80" height="15" />
              <rect x="40" y="105" width="80" height="15" />
            </g>
            <line x1="118" y1="48" x2="42" y2="112" stroke="#0f172a" strokeWidth="22" />
          </svg>
          ZentroMeet
        </Link>
        <div className="hidden gap-5 text-sm text-slate-600 sm:flex">
          <Link href="/features" className="hover:text-slate-900">Features</Link>
          <Link href="/business-phone" className="hover:text-slate-900">Business Phone</Link>
          <Link href="/pricing" className="hover:text-slate-900">Pricing</Link>
          <Link href="/about" className="hover:text-slate-900">About</Link>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/login" className="text-sm text-slate-600 hover:text-slate-900">Sign in</Link>
          <Link
            href="/dashboard/login"
            className="rounded-md bg-brand-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Start free
          </Link>
        </div>
      </div>
    </nav>
  );
}
