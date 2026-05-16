import PublicReschedule from "@/components/PublicReschedule";

export default async function ReschedulePage(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold">Reschedule appointment</h1>
      <PublicReschedule token={token} />
    </div>
  );
}
