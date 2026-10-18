import Link from "next/link";
import { VORTEX_ICON_NAMES } from "@vortex/platform/schema";
import type { OrganizationBuilderRoot } from "@vortex/platform/server";
import { AppearanceToggle, FormattedTime, Icon } from "@vortex/ui";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { Card, CardContent, CardFooter, CardHeader } from "@vortex/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vortex/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@vortex/ui/components/empty";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@vortex/ui/components/pagination";

export type StudioHomeOrganization = Readonly<{
  organizationId: string;
  name: string;
  tenantName: string;
  roots: readonly OrganizationBuilderRoot[];
  editorNames: Readonly<Record<string, string>>;
  nextCursor: string | null;
  after: string | null;
}>;

function NewApplication({
  organizationId,
  variant = "default",
}: Readonly<{ organizationId: string; variant?: "default" | "outline" }>) {
  return (
    <Button
      variant={variant}
      nativeButton={false}
      render={<Link href={`/studio/${organizationId}/new`} />}
    >
      <Icon name="plus" />
      New application
    </Button>
  );
}

/** The one application listing, shared by the all-organization and organization routes. */
export function StudioHome({
  organizations,
  filtered = false,
}: Readonly<{
  organizations: readonly StudioHomeOrganization[];
  filtered?: boolean;
}>) {
  const only = organizations.length === 1 ? organizations[0] : undefined;
  return (
    <main className="mx-auto min-h-dvh max-w-7xl space-y-8 px-8 py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Applications</h1>
          <p className="text-sm text-muted-foreground">
            Build and publish applications for your organization.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {only !== undefined ? (
            <NewApplication organizationId={only.organizationId} />
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button />}>
                <Icon name="plus" />
                New application
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {organizations.map((organization) => (
                  <DropdownMenuItem
                    key={organization.organizationId}
                    render={<Link href={`/studio/${organization.organizationId}/new`} />}
                  >
                    {organization.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <AppearanceToggle />
        </div>
      </header>
      {organizations.map((organization) => {
        const base = filtered ? `/studio/${organization.organizationId}` : "/studio";
        return (
          <section
            key={organization.organizationId}
            id={`organization-${organization.organizationId}`}
            aria-label={organization.name}
            className="space-y-4"
          >
            <div>
              <h2 className="text-base font-semibold">{organization.name}</h2>
              {organization.tenantName !== organization.name && (
                <p className="text-sm text-muted-foreground">{organization.tenantName}</p>
              )}
            </div>
            {organization.roots.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Icon name="grid" />
                  </EmptyMedia>
                  <EmptyTitle>
                    {organization.after === null ? "No applications yet" : "No more applications"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {organization.after === null
                      ? "Create an application to start building."
                      : "Return to the first page to see your applications."}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  {organization.after === null ? (
                    <NewApplication
                      organizationId={organization.organizationId}
                      variant="outline"
                    />
                  ) : (
                    <Button variant="outline" nativeButton={false} render={<Link href={base} />}>
                      First page
                    </Button>
                  )}
                </EmptyContent>
              </Empty>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4">
                {organization.roots.map((root) => {
                  const href = `/studio/${organization.organizationId}/${root.rootId}`;
                  const icon = VORTEX_ICON_NAMES.find((name) => name === root.icon);
                  return (
                    <Card
                      key={root.rootId}
                      className="relative h-full shadow-xs focus-within:ring-2 focus-within:ring-ring"
                    >
                      <CardHeader>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 font-semibold text-foreground">
                            {icon === undefined ? (
                              root.name
                                .split(/\s+/)
                                .slice(0, 2)
                                .map((word) => word[0])
                                .join("")
                            ) : (
                              <Icon name={icon} className="size-5" />
                            )}
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`More for ${root.name}`}
                                  className="relative z-10"
                                />
                              }
                            >
                              <Icon name="more-horizontal" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                render={<Link href={`${href}?tab=releases&section=history`} />}
                              >
                                Published versions
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        <h3 className="text-base font-semibold">
                          <Link
                            href={href}
                            prefetch={false}
                            className="outline-none after:absolute after:inset-0 after:rounded-xl"
                          >
                            {root.name}
                          </Link>
                        </h3>
                      </CardHeader>
                      <CardContent className="flex-1">
                        <p className="line-clamp-2 text-sm text-muted-foreground">
                          {root.description}
                        </p>
                      </CardContent>
                      <CardFooter className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs text-muted-foreground">
                          Edited <FormattedTime iso={root.editedAt} /> by{" "}
                          {organization.editorNames[root.editedBy.toLowerCase()] ??
                            "a restricted person"}
                        </p>
                        <Badge variant="outline">
                          {root.currentReleaseRevision === null
                            ? "Draft only"
                            : `Published v${root.currentReleaseRevision}`}
                        </Badge>
                      </CardFooter>
                    </Card>
                  );
                })}
              </div>
            )}
            {(organization.after !== null || organization.nextCursor !== null) && (
              <Pagination aria-label={`${organization.name} applications pagination`}>
                <PaginationContent>
                  {organization.after !== null && (
                    <PaginationItem>
                      <PaginationPrevious
                        href={base}
                        text="First page"
                        aria-label="Go to first page"
                      />
                    </PaginationItem>
                  )}
                  {organization.nextCursor !== null && (
                    <PaginationItem>
                      <PaginationNext
                        href={`${base}?${new URLSearchParams({ organization: organization.organizationId, after: organization.nextCursor })}#organization-${organization.organizationId}`}
                      />
                    </PaginationItem>
                  )}
                </PaginationContent>
              </Pagination>
            )}
          </section>
        );
      })}
    </main>
  );
}
