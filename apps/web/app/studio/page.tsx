import { notFound } from "next/navigation";
import { namespacedKeySchema } from "@vortex/platform/schema";
import { StudioHome } from "./_components/studio-home";
import { continueStudioSession } from "./_lib/studio-session";
import { StudioUnavailable } from "./_components/studio-unavailable";
import { loadOrganizationLauncher } from "../_lib/organization-context";
import { loadStudioOrganizationHome } from "../_lib/studio-organization-home";

export const dynamic = "force-dynamic";

export default async function StudioLandingPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ after?: string; organization?: string }> }>) {
  const paging = await searchParams;
  if (paging.after !== undefined && !namespacedKeySchema.safeParse(paging.after).success)
    notFound();
  const resolved = await continueStudioSession();
  if (resolved.kind === "temporarily_unavailable")
    return <StudioUnavailable subject="Studio" result={resolved} reloadHref="/studio" />;
  const launcher = await loadOrganizationLauncher(resolved.session);
  if (launcher.kind !== "available") {
    console.error(`[studio] landing could not list organizations: ${launcher.kind}`);
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Studio</h1>
        <p role="status">Studio could not load your organizations. Try again shortly.</p>
      </main>
    );
  }

  const homes = await Promise.all(
    launcher.entries.map(async (entry) => ({
      entry,
      home: await loadStudioOrganizationHome(
        entry.organizationId,
        paging.organization === entry.organizationId ? (paging.after ?? null) : null,
      ),
    })),
  );
  const buildable = homes.flatMap(({ entry, home }) =>
    home.kind === "available" ? [{ entry, home }] : [],
  );
  if (buildable.length === 0) {
    if (homes.some(({ home }) => home.kind === "temporarily_unavailable"))
      return (
        <main className="mx-auto max-w-4xl space-y-4 p-6">
          <h1 className="text-2xl font-semibold">Studio</h1>
          <p role="status">Studio could not load right now. Try again shortly.</p>
        </main>
      );
    notFound();
  }

  const organizations = [...buildable].sort((left, right) =>
    left.entry.organizationDisplayName.localeCompare(right.entry.organizationDisplayName),
  );
  return (
    <StudioHome
      organizations={organizations.map(({ entry, home }) => ({
        organizationId: home.organizationId,
        name: entry.organizationDisplayName,
        tenantName: entry.tenantDisplayName,
        roots: home.roots,
        editorNames: home.editorNames,
        nextCursor: home.nextCursor,
        after: paging.organization === entry.organizationId ? (paging.after ?? null) : null,
      }))}
    />
  );
}
