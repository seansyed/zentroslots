import { NextResponse } from "next/server";
import { errorResponse, requireRole } from "@/lib/auth";
import { googleAuthUrl } from "@/lib/google";

export async function GET() {
  try {
    const user = await requireRole(["admin", "staff"]);
    const url = googleAuthUrl(user.id);
    return NextResponse.redirect(url);
  } catch (err) {
    return errorResponse(err);
  }
}
