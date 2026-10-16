import { redirect } from "next/navigation";

/** Release history is in the workspace's Releases tab; this address opens it there. */
export default async function StudioApplicationHistoryPage({ params }: Readonly<{
  params: Promise<{ organizationId: string; applicationRootId: string }>;
}>) {
  const { organizationId, applicationRootId } = await params;
  redirect(`/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(applicationRootId)}?tab=releases&section=history`);
}
