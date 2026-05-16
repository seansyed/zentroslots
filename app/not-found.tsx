import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="text-6xl font-semibold text-slate-300">404</div>
      <h1 className="mt-3 text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-slate-600">
        The link may be expired, mistyped, or no longer available.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        Back to home
      </Link>
    </div>
  );
}
