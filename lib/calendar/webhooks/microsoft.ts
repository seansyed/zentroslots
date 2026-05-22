/**
 * Microsoft Graph subscription helper.
 *
 * Wave E — Microsoft's push model:
 *   • POST /v1.0/subscriptions with body
 *     { changeType, notificationUrl, resource, expirationDateTime,
 *       clientState }
 *   • Initial validation: Graph immediately POSTs to notificationUrl
 *     with `?validationToken=XXX`. We MUST reply with the raw token as
 *     `text/plain` within 10 seconds or the subscription is rejected.
 *   • Subsequent notifications: POST body
 *     { value: [{ subscriptionId, clientState, resource, changeType }] }
 *     `clientState` is our shared secret — verify it matches.
 *   • Max TTL for /me/calendar resource: 4230 minutes (~70.5 hours)
 *     for delegated user-context apps. Renew well before expiry.
 *   • DELETE /v1.0/subscriptions/{id} to cancel.
 */

// Max subscription TTL Microsoft allows for /me/calendar events
// (delegated). 4230 minutes = ~70.5 hours. We request the full window.
const MAX_TTL_MINUTES = 4230;

export type MicrosoftSubscribeResult = {
  subscriptionId: string;
  expiresAt: Date;
};

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function graphRaw(
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${GRAPH_BASE}${path}`, { method, headers, body });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Graph ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Create a Graph subscription for the user's primary calendar events.
 *
 *   accessToken    : current access token (refresh handled by caller)
 *   notificationUrl: public HTTPS URL of our receiver
 *   clientState    : random secret. Graph echoes it back so we can
 *                    verify each incoming notification is authentic.
 *   changeType     : "created,updated,deleted" by default.
 */
export async function subscribeCalendar(args: {
  accessToken: string;
  notificationUrl: string;
  clientState: string;
}): Promise<MicrosoftSubscribeResult> {
  const expirationDateTime = new Date(Date.now() + MAX_TTL_MINUTES * 60_000).toISOString();
  const res = (await graphRaw(args.accessToken, "/subscriptions", {
    method: "POST",
    body: {
      changeType: "created,updated,deleted",
      notificationUrl: args.notificationUrl,
      resource: "/me/events",
      expirationDateTime,
      clientState: args.clientState,
      // Graph requires lifecycleNotificationUrl for some resource
      // types; for /me/events we let it default to the notificationUrl.
      // If a future Wave needs reauthorization events we wire that here.
    },
  })) as {
    id?: string;
    expirationDateTime?: string;
  };

  if (!res?.id) {
    throw new Error("Microsoft subscribe response missing id");
  }
  return {
    subscriptionId: res.id,
    expiresAt: res.expirationDateTime ? new Date(res.expirationDateTime) : new Date(expirationDateTime),
  };
}

/**
 * Extend an existing subscription's expiration. Same TTL ceiling as
 * create. Returns the new expiration. PATCH body is JUST the
 * expirationDateTime — Graph rejects other fields here.
 */
export async function renewSubscription(args: {
  accessToken: string;
  subscriptionId: string;
}): Promise<Date> {
  const expirationDateTime = new Date(Date.now() + MAX_TTL_MINUTES * 60_000).toISOString();
  const res = (await graphRaw(args.accessToken, `/subscriptions/${encodeURIComponent(args.subscriptionId)}`, {
    method: "PATCH",
    body: { expirationDateTime },
  })) as { expirationDateTime?: string };
  return res?.expirationDateTime ? new Date(res.expirationDateTime) : new Date(expirationDateTime);
}

/**
 * Delete a subscription. Idempotent: 404 absorbed silently.
 */
export async function unsubscribe(args: {
  accessToken: string;
  subscriptionId: string;
}): Promise<void> {
  try {
    await graphRaw(args.accessToken, `/subscriptions/${encodeURIComponent(args.subscriptionId)}`, {
      method: "DELETE",
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404 || status === 410) return;
    throw err;
  }
}
