import { notFound } from "next/navigation";

import WaitlistClaimClient from "@/components/WaitlistClaimClient";
import { verifyWaitlistClaimToken } from "@/lib/waitlists/tokens";

export const metadata = { title: "Claim your slot" };
export const dynamic = "force-dynamic";

// Public claim page. The CLIENT component does the actual fetch +
// post — this server component just sanity-checks the token format
// and 404s on garbage. Real validation happens in the API handler.
export default async function WaitlistClaimPage(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  const payload = await verifyWaitlistClaimToken(token);
  if (!payload) notFound();

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <main className="mx-auto max-w-xl px-6 py-12">
        <WaitlistClaimClient token={token} />
      </main>
    </div>
  );
}
