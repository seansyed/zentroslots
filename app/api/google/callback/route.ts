import { NextRequest, NextResponse } from "next/server";

import { errorResponse, getSession, HttpError } from "@/lib/auth";
import { exchangeCodeAndStore } from "@/lib/google";

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3001";

export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    if (!code || !state) throw new HttpError(400, "Missing code/state");

    // The state we sent was the signed-in user id. Verify the session matches.
    const session = await getSession();
    if (!session) throw new HttpError(401, "Sign in before connecting Google");
    if (session.sub !== state) throw new HttpError(403, "OAuth state mismatch");

    await exchangeCodeAndStore(session.sub, code);
    return NextResponse.redirect(`${APP_BASE_URL}/dashboard?google=connected`);
  } catch (err) {
    return errorResponse(err);
  }
}
