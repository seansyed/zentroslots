import "./globals.css";
import type { Metadata } from "next";
import { ToastHost } from "@/components/ui/primitives";

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3001";

export const metadata: Metadata = {
  metadataBase: new URL(APP_BASE_URL),
  title: { default: "Scheduling SaaS — Calendly-style bookings", template: "%s — Scheduling SaaS" },
  description:
    "Multi-tenant scheduling platform with custom branding, Google Meet, and enterprise-grade availability rules.",
  applicationName: "Scheduling SaaS",
  openGraph: {
    title: "Scheduling SaaS",
    description: "Book meetings without the back-and-forth.",
    type: "website",
    siteName: "Scheduling SaaS",
  },
  twitter: { card: "summary_large_image", title: "Scheduling SaaS" },
  icons: { icon: "/favicon.ico" },
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
        <main id="main" className="min-h-screen">{children}</main>
        <ToastHost />
      </body>
    </html>
  );
}
