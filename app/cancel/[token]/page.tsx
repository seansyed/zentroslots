import PublicCancel from "@/components/PublicCancel";

export default async function CancelPage(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold">Cancel appointment</h1>
      <PublicCancel token={token} />
    </div>
  );
}
