import { loadStudioStandardPageAdoption } from "../../../../_lib/studio-standard-page-adoption";
import { StandardPageAdoption } from "../../../_components/standard-page-adoption";

export const dynamic = "force-dynamic";

export default async function StudioStandardPageAdoptionPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ organizationId: string; applicationRootId: string }>;
  searchParams: Promise<{ result?: string }>;
}>) {
  const [{ organizationId, applicationRootId }, search] = await Promise.all([params, searchParams]);
  const result = await loadStudioStandardPageAdoption(organizationId, applicationRootId);
  return <StandardPageAdoption result={result} message={search.result} />;
}
