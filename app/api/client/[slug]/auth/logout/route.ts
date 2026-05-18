import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/auth";
import { clearClientSessionCookie } from "@/lib/client-auth";

export async function POST() {
  try {
    await clearClientSessionCookie();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
