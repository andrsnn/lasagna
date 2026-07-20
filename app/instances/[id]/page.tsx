import { redirect } from "next/navigation";

// Legacy route from before the v7 rename. Repoint to the canonical app route.
// Note: in v7 the app id == designer id (not the legacy instance id), so a
// best-effort redirect to /apps/{legacy-id} may 404. For non-canonical legacy
// instances the chat history was repointed during the v7 IDB upgrade; for
// canonical ones the id matches the templateId which IS the new app id.
export default async function LegacyInstanceDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/apps/${id}`);
}
