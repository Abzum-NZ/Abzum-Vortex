import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@vortex/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vortex/ui/components/table";
import { loadStudioOrganizationHome } from "../../_lib/studio-organization-home";
import type { OrganizationBuilderRoot } from "@vortex/platform/server";

export const dynamic = "force-dynamic";

function RootTable({
  roots,
  organizationId,
}: Readonly<{
  roots: readonly OrganizationBuilderRoot[];
  organizationId: string;
}>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Open</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {roots.map((root) => {
          const base =
            root.kind === "application"
              ? `/studio/${organizationId}/${root.rootId}`
              : `/studio/modules/${organizationId}/${root.rootId}`;
          return (
            <TableRow key={root.rootId}>
              <TableCell>
                <span className="font-medium">{root.name}</span>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {root.draftRevision === null ? "No draft yet" : "Draft saved"} ·{" "}
                {root.currentReleaseRevision === null ? "Not published yet" : "Published"}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                  {root.draftRevision !== null && (
                    <Link className="underline underline-offset-4" href={base}>
                      Workspace
                    </Link>
                  )}
                  {root.kind === "application" ? (
                    <Link className="underline underline-offset-4" href={`${base}/history`}>
                      Published versions
                    </Link>
                  ) : root.draftRevision !== null ? (
                    <>
                      <Link className="underline underline-offset-4" href={`${base}/fields`}>
                        Fields
                      </Link>
                      <Link className="underline underline-offset-4" href={`${base}/queries`}>
                        Saved views
                      </Link>
                      <Link className="underline underline-offset-4" href={`${base}/publish`}>
                        Publish
                      </Link>
                    </>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export default async function StudioOrganizationPage({
  params,
}: Readonly<{
  params: Promise<{ organizationId: string }>;
}>) {
  const { organizationId } = await params;
  const result = await loadStudioOrganizationHome(organizationId);
  if (result.kind !== "available")
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Studio unavailable</h1>
        <p role="status">
          {result.kind === "refused"
            ? result.reason
            : "Studio could not load this organization. Try again shortly."}
        </p>
      </main>
    );

  const applications = result.roots.filter((root) => root.kind === "application");
  const modules = result.roots.filter((root) => root.kind === "module");
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Studio</h1>
          <p className="text-muted-foreground">Applications and modules in this organization.</p>
        </div>
        <Link
          className="underline underline-offset-4"
          href={`/studio/${result.organizationId}/new`}
        >
          New application
        </Link>
      </div>
      {result.mayHaveMore && (
        <p role="status" className="text-sm text-muted-foreground">
          Showing the first 200 definitions. More may exist in this organization.
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Applications</CardTitle>
          <CardDescription>Open an application to edit it, or look at its published versions.</CardDescription>
        </CardHeader>
        <CardContent>
          {applications.length === 0 ? (
            <p className="text-muted-foreground">No applications yet. Create one to get started.</p>
          ) : (
            <RootTable roots={applications} organizationId={result.organizationId} />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Modules</CardTitle>
          <CardDescription>Open a module to edit its fields, saved views or publish it.</CardDescription>
        </CardHeader>
        <CardContent>
          {modules.length === 0 ? (
            <p className="text-muted-foreground">No modules yet.</p>
          ) : (
            <RootTable roots={modules} organizationId={result.organizationId} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}
