import Link from "next/link";

export default function MarketingNav() {
  return (
    <nav className="sticky top-0 z-10 border-b bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold">
          {/* ZentroMeet brand mark — official circular badge */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/zentromeet-mark.png" alt="ZentroMeet" className="h-6 w-6 rounded-full" />
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
