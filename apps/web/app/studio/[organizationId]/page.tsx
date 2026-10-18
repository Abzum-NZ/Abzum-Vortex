import { notFound } from "next/navigation";
import { namespacedKeySchema } from "@vortex/platform/schema";
import { resolveIdentitySession } from "../../auth/_lib/session-server";
import { loadOrganizationLauncher } from "../../_lib/organization-context";
import { loadStudioOrganizationHome } from "../../_lib/studio-organization-home";
import { StudioHome } from "../_components/studio-home";

export const dynamic = "force-dynamic";

export default async function StudioOrganizationPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ after?: string }>;
}>) {
  const { organizationId } = await params;
  const { after } = await searchParams;
  if (after !== undefined && !namespacedKeySchema.safeParse(after).success) notFound();
  const resolved = await resolveIdentitySession();
  if (resolved.kind !== "active") notFound();
  const launcher = await loadOrganizationLauncher(resolved.session);
  const result = await loadStudioOrganizationHome(organizationId, after ?? null);
  if (result.kind !== "available" || launcher.kind !== "available") {
    console.error(
      `[studio] organization listing unavailable: ${result.kind}, launcher ${launcher.kind}`,
    );
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-6">
        <h1 className="text-3xl font-semibold tracking-tight">Studio unavailable</h1>
        <p role="status">
          {result.kind === "refused"
            ? result.reason
            : "Studio could not load this organization. Try again shortly."}
        </p>
      </main>
    );
  }
  const entry = launcher.entries.find((entry) => entry.organizationId === result.organizationId);
  if (entry === undefined) notFound();
  return (
    <StudioHome
      filtered
      organizations={[
        {
          organizationId: result.organizationId,
          name: entry.organizationDisplayName,
          tenantName: entry.tenantDisplayName,
          roots: result.roots,
          editorNames: result.editorNames,
          nextCursor: result.nextCursor,
          after: after ?? null,
        },
      ]}
    />
  );
}
