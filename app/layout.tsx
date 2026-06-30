import "./globals.css";
import type { Metadata } from "next";
import { ToastHost, ConfirmHost } from "@/components/ui/primitives";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import GAProvider from "@/components/analytics/GAProvider";

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3001";

// Platform-wide brand metadata. Tenant-uploaded logos (via Settings
// -> Branding) continue to override the per-workspace sidebar mark
// at runtime — this metadata only sets the *default* identity used
// for the browser tab, social previews, and any surface where no
// tenant context exists yet (login, public landing).
export const metadata: Metadata = {
  metadataBase: new URL(APP_BASE_URL),
  title: {
    default: "ZentroMeet — Appointments. Automation. Growth.",
    template: "%s — ZentroMeet",
  },
  description:
    "Premium scheduling infrastructure for service businesses — workforce orchestration, calendar sync, and a booking experience customers actually finish.",
  applicationName: "ZentroMeet",
  openGraph: {
    title: "ZentroMeet — Appointments. Automation. Growth.",
    description: "Book meetings without the back-and-forth.",
    type: "website",
    siteName: "ZentroMeet",
    images: ["/zentromeet-wordmark.svg"],
  },
  twitter: {
    card: "summary_large_image",
    title: "ZentroMeet",
    images: ["/zentromeet-wordmark.svg"],
  },
  // The mark is square (1:1) and renders cleanly at favicon size.
  // Apple touch icon reuses the same file — circular shape masks
  // gracefully on iOS home screens.
  icons: {
    icon: "/zentromeet-mark.png",
    apple: "/zentromeet-mark.png",
    shortcut: "/zentromeet-mark.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow"
        >
          Skip to content
        </a>
        <ImpersonationBanner />
        <main id="main" className="min-h-screen">{children}</main>
        <ToastHost />
        <ConfirmHost />
        {/* Phase GA4 — mounted at the root so both public marketing
            routes (/, /pricing, /features, /for/[vertical]) and the
            authenticated app shell (/dashboard/**, /u/[slug]/**) share
            a single tracker. Renders nothing when the measurement ID
            env var is absent, so this is safe in dev. */}
        <GAProvider />
      </body>
    </html>
  );
}
