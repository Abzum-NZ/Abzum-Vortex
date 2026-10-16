import { redirect } from "next/navigation";

/** Release history is a tab of the workspace; this address opens it there. */
export default async function StudioApplicationHistoryPage({ params }: Readonly<{
  params: Promise<{ organizationId: string; applicationRootId: string }>;
}>) {
  const { organizationId, applicationRootId } = await params;
  redirect(`/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(applicationRootId)}?tab=history`);
}
