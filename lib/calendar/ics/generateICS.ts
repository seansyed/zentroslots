/**
 * Phase ICAL-1 — high-level VCALENDAR generator.
 *
 * Wraps the VEVENT/VTIMEZONE lines from buildICSEvent.ts in a
 * compliant VCALENDAR document:
 *   • PRODID + VERSION + METHOD + CALSCALE header
 *   • CRLF line endings
 *   • Line folding at 75 octets (RFC 5545 §3.1)
 *   • Returns body + matching Content-Type + filename so the email
 *     engine and the public download endpoint both speak the same
 *     contract.
 *
 * Why line folding matters:
 *   Microsoft Outlook + many older clients reject lines longer than
 *   75 octets. A DESCRIPTION with a long meeting URL trivially blows
 *   past that. We fold by inserting CRLF + space at every 75-byte
 *   boundary, which the parser un-folds back to a single logical
 *   line. Folding is OCTET-based, not character-based — multibyte
 *   UTF-8 must NOT split mid-codepoint or Apple Calendar will show
 *   a garbled name.
 */

import { buildICSEvent, type BuildOpts } from "./buildICSEvent";
import type { GeneratedIcs, IcsEvent } from "./types";

const DEFAULT_PRODID = "-//ZentroMeet//Booking 1.0//EN";

/** Fold a single logical line into one or more physical lines at
 *  the 75-octet boundary. Continuation lines start with a single
 *  space (the "linear-white-space" sentinel RFC 5545 §3.1).
 *
 *  Octet-aware: we walk the UTF-8 byte encoding and only split at
 *  a codepoint boundary so multibyte characters (à, 中, 😀) are
 *  never bisected. */
export function foldLine(logicalLine: string): string {
  const MAX = 75;
  const bytes = Buffer.from(logicalLine, "utf8");
  if (bytes.byteLength <= MAX) return logicalLine;

  const out: string[] = [];
  let start = 0;
  while (start < bytes.byteLength) {
    let end = Math.min(start + MAX, bytes.byteLength);
    // Don't split a UTF-8 multibyte sequence. Continuation bytes
    // start with 10xxxxxx (0x80..0xBF). Walk back until we're on
    // a leading byte (or ASCII).
    while (end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) {
      end--;
    }
    out.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  // Continuation lines join with CRLF + leading space.
  return out.join("\r\n ");
}

/**
 * Generate a full VCALENDAR document for a single event. Returns
 * the body string plus the metadata an email attachment header
 * needs (Content-Type with matching method + a filename).
 */
export function generateICS(
  event: IcsEvent,
  opts: BuildOpts = {},
): GeneratedIcs {
  const prodId = event.prodId ?? DEFAULT_PRODID;

  const headerLines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    `METHOD:${event.method}`,
    "CALSCALE:GREGORIAN",
  ];

  const bodyLines = buildICSEvent(event, opts);

  const footerLines: string[] = ["END:VCALENDAR"];

  const allLines = [...headerLines, ...bodyLines, ...footerLines];

  // Fold every line at 75 octets, then join with CRLF and append a
  // terminal CRLF (Outlook is picky about the trailing line ending).
  const folded = allLines.map(foldLine).join("\r\n") + "\r\n";

  // Content-Type MUST mirror the METHOD inside the body. The
  // pre-existing engine.ts had a bug where it always set
  // method=REQUEST even when generating a CANCEL body — Outlook
  // would then ignore the cancellation. Fixed by deriving from the
  // event's own method here.
  const contentType = `text/calendar; charset=utf-8; method=${event.method}`;

  // Filename: stable per booking so re-downloads/email clients
  // don't proliferate duplicates in the user's downloads folder.
  // We strip non-filename-safe chars from the UID (replace @ with -).
  const slug = event.uid.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60);
  const filename =
    event.method === "CANCEL"
      ? `cancellation-${slug}.ics`
      : `invite-${slug}.ics`;

  return {
    body: folded,
    contentType,
    filename,
    method: event.method,
  };
}
