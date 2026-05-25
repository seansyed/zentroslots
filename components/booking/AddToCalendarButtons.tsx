/**
 * Phase ICAL-1 — "Add to calendar" button row for the booking
 * confirmation page (server component — no client JS needed since
 * every action is a plain anchor link).
 *
 * Four targets:
 *   • Apple Calendar — downloads the signed .ics; iOS/macOS open
 *     the calendar app automatically via their .ics URL handler
 *   • Google Calendar — opens calendar.google.com prefilled
 *   • Outlook — opens outlook.live.com prefilled
 *   • Yahoo — opens calendar.yahoo.com prefilled
 *
 * Polished but small. DOES NOT redesign the surrounding page — sits
 * inside the existing "Your booking" card's button slot. The
 * provider buttons mirror the visual treatment of the existing
 * Google + Outlook buttons (slate border, hover state, icons).
 *
 * Why the .ics download is Apple's button: Apple has no documented
 * web-add deep link. The standard pattern across the industry
 * (Calendly, Cal.com, HubSpot) is to expose a downloadable .ics —
 * macOS Safari opens it directly in Calendar.app; iOS Safari saves
 * to Files and the user taps to open. ical-style URL schemes
 * (webcal://) exist but trigger a SUBSCRIBE prompt which is wrong
 * for one-shot invites.
 */

import { Apple, Calendar as CalendarIcon, Download, Mail } from "lucide-react";

import {
  generateGoogleCalendarUrl,
  generateICSDownloadUrl,
  generateOutlookCalendarUrl,
  generateYahooCalendarUrl,
  type AddToCalendarArgs,
} from "@/lib/calendar/ics/calendarLinks";

interface Props {
  event: AddToCalendarArgs;
  /** Pre-signed token (kind=ics) for the .ics download endpoint.
   *  Issued by the caller server-side so the token never lives in
   *  client code or URL history. */
  icsToken: string;
}

export default function AddToCalendarButtons({ event, icsToken }: Props) {
  const icsUrl = generateICSDownloadUrl(icsToken);
  const googleUrl = generateGoogleCalendarUrl(event);
  const outlookUrl = generateOutlookCalendarUrl(event);
  const yahooUrl = generateYahooCalendarUrl(event);

  return (
    <div className="mt-4 w-full">
      <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.10em] text-slate-500">
        Add to your calendar
      </div>
      <div className="grid grid-cols-2 gap-2">
        <CalendarButton
          href={icsUrl}
          label="Apple Calendar"
          icon={<Apple className="h-3.5 w-3.5" />}
          // download attribute hints the browser to save rather than
          // navigate; iOS Safari respects it for .ics MIME by
          // surfacing the "Open with Calendar" sheet.
          download
        />
        <CalendarButton
          href={googleUrl}
          label="Google Calendar"
          icon={<CalendarIcon className="h-3.5 w-3.5" />}
          external
        />
        <CalendarButton
          href={outlookUrl}
          label="Outlook"
          icon={<Mail className="h-3.5 w-3.5" />}
          external
        />
        <CalendarButton
          href={yahooUrl}
          label="Yahoo"
          icon={<CalendarIcon className="h-3.5 w-3.5" />}
          external
        />
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
        <Download className="h-3 w-3" strokeWidth={1.75} />
        <a
          href={icsUrl}
          download
          className="underline underline-offset-2 hover:text-slate-700"
        >
          Download .ics file
        </a>
        <span className="text-slate-400">·</span>
        <span>Works with any calendar app</span>
      </div>
    </div>
  );
}

function CalendarButton({
  href,
  label,
  icon,
  download,
  external,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
  download?: boolean;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      {...(download ? { download: true } : {})}
      {...(external
        ? { target: "_blank", rel: "noopener noreferrer" }
        : {})}
      className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-[12.5px] font-medium text-slate-700 transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-sm"
    >
      {icon}
      <span>{label}</span>
    </a>
  );
}
