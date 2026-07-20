import { redirect } from "next/navigation";

export default async function LegacyTemplateDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/designer/${id}`);
}
