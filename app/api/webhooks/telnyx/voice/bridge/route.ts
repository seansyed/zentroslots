import { NextRequest, NextResponse } from "next/server";

import { readBusinessLineConfig, texmlReject } from "@/lib/telnyx-business-line";
import { verifyAndParseInbound } from "@/lib/business-line-forwarding";
import {
  resolveBridgeTarget,
  verifyBridgeToken,
  texmlBridgeDial,
} from "@/lib/business-line-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/telnyx/voice/bridge — outbound bridge leg-2 (P1.0).
 *
 * Telnyx fetches this when the STAFF leg of an outbound bridge call answers. We
 * respond with a TeXML <Dial> to the CUSTOMER, presenting the tenant's business
 * number as caller ID. Defense-in-depth, all fail-closed to a safe <Reject>:
 *   - flag-gated + Ed25519-verified body (verifyAndParseInbound) — proves Telnyx
 *     sent it, for a call we initiated;
 *   - the routing target (customer + caller ID) is carried in the URL query and
 *     bound by an HMAC token, which we verify with the server secret;
 *   - the customer number + caller ID are re-validated as US/CA E.164 (and the
 *     customer is not an emergency/N11 code) before we dial.
 * Never emits a number unless every check passes.
 */
function texml(xml: string, status = 200) {
  return new NextResponse(xml, {
    status,
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const config = readBusinessLineConfig();

  // Authenticate the webhook body (flag + Ed25519). On OFF/misconfig/bad-sig →
  // decline safely with no number in the response.
  const vp = verifyAndParseInbound({
    config,
    rawBody: raw,
    signatureB64: req.headers.get("telnyx-signature-ed25519"),
    timestamp: req.headers.get("telnyx-timestamp"),
  });
  if (!vp.ok) {
    console.log(`[telnyx/voice/bridge] declined (${vp.reason})`);
    return texml(texmlReject());
  }

  try {
    const to = req.nextUrl.searchParams.get("to");
    const cid = req.nextUrl.searchParams.get("cid");
    const token = req.nextUrl.searchParams.get("t");

    // Integrity of the URL routing params (separate from the body signature).
    // If we have a secret, the token MUST verify; without a secret no bridge URL
    // could have been minted, so decline.
    if (!config.apiKey || !to || !cid || !verifyBridgeToken(config.apiKey, to, cid, token)) {
      console.log("[telnyx/voice/bridge] declined (bad_token)");
      return texml(texmlReject());
    }

    const target = resolveBridgeTarget({ to, cid });
    if (!target.ok) {
      console.log(`[telnyx/voice/bridge] declined (${target.reason})`);
      return texml(texmlReject());
    }

    return texml(
      texmlBridgeDial({ customerNumber: target.customerNumber, callerId: target.callerId }),
    );
  } catch (err) {
    console.error("[telnyx/voice/bridge] handler error — declining:", err instanceof Error ? err.message : err);
    return texml(texmlReject());
  }
}
