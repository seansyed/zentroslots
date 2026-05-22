import { NextRequest, NextResponse } from "next/server";

import { errorResponse, HttpError } from "@/lib/auth";
import { verifyBookingToken } from "@/lib/tokens";
import { publicRescheduleSchema } from "@/lib/validation";
import { performReschedule } from "@/lib/reschedule";

/**
 * Public token-gated reschedule.
 *
 * Behavior is byte-identical to the prior implementation — the core
 * transaction + calendar sync + waitlist release + email logic is now
 * shared with the portal-authenticated route via lib/reschedule.ts.
 * Both call sites converge on the same engine so there's exactly one
 * place to maintain reschedule semantics.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;
    const payload = await verifyBookingToken(token);
    if (!payload || payload.kind !== "reschedule") {
      throw new HttpError(401, "Invalid or expired link");
    }

    const body = publicRescheduleSchema.parse(await req.json());

    const result = await performReschedule({
      bookingId: payload.bookingId,
      tenantId: payload.tenantId,
      newStartIso: body.startAt,
      source: "public_token",
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, status: "confirmed" });
  } catch (err) {
    return errorResponse(err);
  }
}
