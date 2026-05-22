import { redirect } from "next/navigation";

/**
 * /client/[slug]/messages
 *
 * The Messages tab was removed from the portal navigation in Phase 18 —
 * it was a "Coming soon" stub on a customer-facing surface and eroded
 * trust. The route is preserved as a redirect so any existing bookmarks
 * or links land on the portal home instead of a dead-end stub.
 *
 * When two-way messaging actually ships, replace this with the real
 * implementation and re-add the nav entry in ClientPortalShell.
 */
export default async function ClientMessagesPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  redirect(`/client/${slug}`);
}
