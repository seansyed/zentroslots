import Link from "next/link";

export default function Footer() {
  return (
    <footer className="border-t bg-white py-10 text-center text-xs text-slate-500">
      <nav className="mb-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
        <Link href="/pricing" className="hover:text-slate-800">Pricing</Link>
        <Link href="/features" className="hover:text-slate-800">Features</Link>
        <Link href="/business-phone" className="hover:text-slate-800">Business Phone</Link>
        <Link href="/privacy" className="hover:text-slate-800">Privacy</Link>
        <Link href="/terms" className="hover:text-slate-800">Terms</Link>
        <a href="mailto:support@zentromeet.com" className="hover:text-slate-800">Support</a>
      </nav>
      © {new Date().getFullYear()} ZentroMeet · Enterprise scheduling platform
    </footer>
  );
}
