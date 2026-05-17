import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/auth";
import { getImpersonationState } from "@/lib/impersonate";

export async function GET() {
  try {
    const state = await getImpersonationState();
    return NextResponse.json(state);
  } catch (err) {
    return errorResponse(err);
  }
}
