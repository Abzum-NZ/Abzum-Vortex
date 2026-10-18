import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@vortex/ui/components/card";
import type { OrganizationBuilderRoot } from "@vortex/platform/server";
import { continueStudioSession } from "./_lib/studio-session";
import { StudioUnavailable } from "./_components/studio-unavailable";
import { loadOrganizationLauncher } from "../_lib/organization-context";
import { loadStudioOrganizationHome } from "../_lib/studio-organization-home";

export const dynamic = "force-dynamic";

const defaultPageSize = 40;
const maxPageSize = 200;

const pageSizeFrom = (candidate: string | string[] | undefined): number => {
  const parsed = Number(Array.isArray(candidate) ? candidate[0] : candidate);
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, maxPageSize) : defaultPageSize;
};

const byName = (left: OrganizationBuilderRoot, right: OrganizationBuilderRoot): number =>
  left.name.localeCompare(right.name);

function RootList({
  roots,
  organizationId,
  size,
  empty,
}: Readonly<{
  roots: readonly OrganizationBuilderRoot[];
  organizationId: string;
  size: number;
  empty: string;
}>) {
  if (roots.length === 0) return <p className="text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y">
      {roots.slice(0, size).map((root) => (
        <li key={root.rootId}>
          <Link
            className="block py-2 font-medium underline-offset-4 hover:underline"
            href={`/studio/${organizationId}/${root.rootId}`}
          >
            {root.name}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function StudioLandingPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ size?: string | string[] }> }>) {
  const size = pageSizeFrom((await searchParams).size);
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
      home: await loadStudioOrganizationHome(entry.organizationId),
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
  const sizeLinks = size < maxPageSize && (
    <Link
      className="text-sm underline underline-offset-4"
      href={`/studio?size=${Math.min(size * 5, maxPageSize)}`}
    >
      Show more
    </Link>
  );
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Studio</h1>
        <p className="text-muted-foreground">
          Applications you can build. A module is edited inside the application that owns it.
        </p>
      </div>
      {organizations.map(({ entry, home }) => {
        const applications = [...home.roots].sort(byName);
        return (
          <Card key={entry.organizationId}>
            <CardHeader>
              <CardTitle>{entry.organizationDisplayName}</CardTitle>
              {entry.tenantDisplayName !== entry.organizationDisplayName && (
                <CardDescription>{entry.tenantDisplayName}</CardDescription>
              )}
            </CardHeader>
            <CardContent className="space-y-6">
              <section className="space-y-2">
                <h2 className="text-lg font-medium">Applications</h2>
                <RootList
                  roots={applications}
                  organizationId={home.organizationId}
                  size={size}
                  empty="No applications yet."
                />
                {applications.length > size && sizeLinks}
                <Link
                  className="block text-sm underline underline-offset-4"
                  href={`/studio/${home.organizationId}/new`}
                >
                  Create an application
                </Link>
              </section>
            </CardContent>
          </Card>
        );
      })}
    </main>
  );
}
