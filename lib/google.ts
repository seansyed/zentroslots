import { google } from "googleapis";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users, type User } from "@/db/schema";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function oauthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("Google OAuth env vars missing");
  }
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

export function googleAuthUrl(userId: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",   // force refresh_token on every consent
    scope: SCOPES,
    state: userId,       // signed-in user id; verified server-side
  });
}

export async function exchangeCodeAndStore(userId: string, code: string): Promise<void> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh_token (revoke + retry with prompt=consent)");
  }

  await db
    .update(users)
    .set({
      googleRefreshToken: tokens.refresh_token,
      googleCalendarId: "primary",
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

export type CreatedEvent = {
  eventId: string;
  meetLink: string | null;
};

export async function createCalendarEventForStaff(args: {
  staff: User;
  serviceName: string;
  clientName: string;
  clientEmail: string;
  startAt: Date;
  endAt: Date;
  notes?: string;
}): Promise<CreatedEvent | null> {
  if (!args.staff.googleRefreshToken) return null;

  const client = oauthClient();
  client.setCredentials({ refresh_token: args.staff.googleRefreshToken });
  const calendar = google.calendar({ version: "v3", auth: client });

  const requestId = `${args.staff.id}-${args.startAt.getTime()}`;

  try {
    const res = await calendar.events.insert({
      calendarId: args.staff.googleCalendarId ?? "primary",
      conferenceDataVersion: 1,
      sendUpdates: "all",
      requestBody: {
        summary: `${args.serviceName} with ${args.clientName}`,
        description: args.notes ?? "",
        start: { dateTime: args.startAt.toISOString(), timeZone: "UTC" },
        end: { dateTime: args.endAt.toISOString(), timeZone: "UTC" },
        attendees: [
          { email: args.staff.email },
          { email: args.clientEmail, displayName: args.clientName },
        ],
        conferenceData: {
          createRequest: {
            requestId,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      },
    });

    // Mark the connection healthy on success — clears any stale error flag.
    await db
      .update(users)
      .set({ googleStatus: "connected", googleLastErrorAt: null })
      .where(eq(users.id, args.staff.id));

    return {
      eventId: res.data.id ?? "",
      meetLink: res.data.hangoutLink ?? null,
    };
  } catch (err) {
    // Mark connection as expired/error so the dashboard banner appears.
    // Don't throw — the booking should still succeed (Meet link will be null).
    const status = isAuthError(err) ? "expired" : "error";
    await db
      .update(users)
      .set({ googleStatus: status, googleLastErrorAt: new Date() })
      .where(eq(users.id, args.staff.id));
    throw err;
  }
}

function isAuthError(err: unknown): boolean {
  const code = (err as { code?: number; response?: { status?: number } })?.code
    ?? (err as { response?: { status?: number } })?.response?.status;
  return code === 401 || code === 403;
}
