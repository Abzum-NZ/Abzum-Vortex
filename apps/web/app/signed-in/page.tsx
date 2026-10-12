import Link from "next/link";
import { redirect } from "next/navigation";
import type { OrganizationLauncherEntry } from "@vortex/contracts";
import {
  ALL_UI_STYLES_CSS,
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  ApplicationLauncher,
  createThemeRootProps,
  VortexFontStylesheets,
  type DisplayRow,
  type DisplaySemanticEvent,
  type ListPayload,
} from "@vortex/ui";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@vortex/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@vortex/ui/components/empty";
import { Icon } from "@vortex/ui/icons";
import { signOut } from "../auth/actions";
import { SubmitButton } from "../auth/_components/submit-button";
import { continueSessionOrEnd, redirectToSessionEnd } from "../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { organizationAddressPath } from "../_lib/address-paths";
import { loadOrganizationLauncher } from "../_lib/organization-context";

export const dynamic = "force-dynamic";

/**
 * The first load right after sign-in (for example straight after a database reset) can meet a
 * transient failure in the session or organisation read, so a temporarily unavailable result is
 * read once more before the person is shown the unavailable page. Refusals are never retried, and
 * each retry is logged without any token, cookie or identity value so a lasting failure stays
 * visible.
 */
const retryOnceWhenTemporarilyUnavailable = async <Result extends Readonly<{ kind: string }>>(
  read: "session" | "organisations",
  load: () => Promise<Result>,
): Promise<Result> => {
  const first = await load();
  if (first.kind !== "temporarily_unavailable") return first;
  console.error(`[signed-in] ${read} read temporarily unavailable; retrying once`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const second = await load();
  if (second.kind === "temporarily_unavailable")
    console.error(`[signed-in] ${read} read still temporarily unavailable after one retry`);
  return second;
};

/**
 * Closed launcher projection of the person's current organisation entries. Each tile's identity is
 * the organisation's permanent identity, populated with name, description (tenant and account) and icon.
 */
const organizationTileValues = (
  entries: readonly OrganizationLauncherEntry[],
): ListPayload => {
  const rows = entries.map(
    (entry): DisplayRow => ({
      recordId: entry.organizationId,
      cells: {
        name: {
          kind: "text",
          text: entry.organizationDisplayName,
        },
        description: {
          kind: "text",
          text:
            [entry.tenantDisplayName, entry.accountDisplayName]
              .filter((part) => part !== undefined && part !== entry.organizationDisplayName)
              .join(" · ") || entry.tenantShortName,
        },
        icon: {
          kind: "text",
          text: "building-2",
        },
      },
    }),
  );
  return { kind: "list", headingKey: "name", secondaryKey: "icon", rows };
};

/**
 * Tile activation is the launcher block's declared `row_action` event. The browser supplies only
 * the tile's identity; this server action re-resolves the signed-in person's current organisation
 * entries and opens the matching one, so a withdrawn or foreign organisation is never opened from
 * stale page data or a crafted identity.
 */
async function openOrganization(event: DisplaySemanticEvent): Promise<void> {
  "use server";
  if (event?.event !== "row_action" || typeof event.recordId !== "string") return;
  const identity = await continueSessionOrEnd(await resolveIdentitySession());
  if (identity.kind === "temporarily_unavailable") redirect("/signed-in");

  const current = await loadOrganizationLauncher(identity.session);
  if (current.kind !== "available") redirect("/signed-in");
  const entry = current.entries.find((candidate) => candidate.organizationId === event.recordId);
  if (entry === undefined) redirect("/signed-in");
  redirect(organizationAddressPath(entry.tenantShortName, entry.organizationShortName));
}

export default async function SignedInPage() {
  const result = await continueSessionOrEnd(
    await retryOnceWhenTemporarilyUnavailable("session", resolveIdentitySession),
  );
  if (result.kind === "temporarily_unavailable")
    return (
      <main
        className="flex min-h-svh items-center justify-center p-4 bg-background text-foreground"
        {...createThemeRootProps(undefined)}
      >
        <VortexFontStylesheets />
        <style href="vortex-ui-styles" precedence="default">
          {ALL_UI_STYLES_CSS}
        </style>
        <Card className="w-full max-w-md border-border bg-card text-card-foreground shadow-sm">
          <CardHeader className="gap-2">
            <Badge variant="secondary" className="w-fit text-xs uppercase">
              Organisation access
            </Badge>
            <CardTitle>
              <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">
                Organisations are temporarily unavailable
              </h1>
            </CardTitle>
            <CardDescription className="text-sm text-muted-foreground">
              Your sign-in is still active. Try loading your organisations again.
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex justify-between gap-3 pt-2">
            <Button variant="outline" nativeButton={false} render={<Link href="/signed-in" />}>
              Try again
            </Button>
            <form action={signOut}>
              <SubmitButton variant="ghost" pendingLabel="Signing out…">
                Sign out
              </SubmitButton>
            </form>
          </CardFooter>
        </Card>
      </main>
    );

  const launcher = await retryOnceWhenTemporarilyUnavailable("organisations", () =>
    loadOrganizationLauncher(result.session),
  );
  if (launcher.kind === "temporarily_unavailable")
    return (
      <main
        className="flex min-h-svh items-center justify-center p-4 bg-background text-foreground"
        {...createThemeRootProps(undefined)}
      >
        <VortexFontStylesheets />
        <style href="vortex-ui-styles" precedence="default">
          {ALL_UI_STYLES_CSS}
        </style>
        <Card className="w-full max-w-md border-border bg-card text-card-foreground shadow-sm">
          <CardHeader className="gap-2">
            <Badge variant="secondary" className="w-fit text-xs uppercase">
              Organisation access
            </Badge>
            <CardTitle>
              <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">
                Organisations are temporarily unavailable
              </h1>
            </CardTitle>
            <CardDescription className="text-sm text-muted-foreground">
              Your sign-in is still active. Try loading your organisations again.
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex justify-between gap-3 pt-2">
            <Button variant="outline" nativeButton={false} render={<Link href="/signed-in" />}>
              Try again
            </Button>
            <form action={signOut}>
              <SubmitButton variant="ghost" pendingLabel="Signing out…">
                Sign out
              </SubmitButton>
            </form>
          </CardFooter>
        </Card>
      </main>
    );
  if (launcher.kind !== "available") return redirectToSessionEnd();
  const onlyEntry = launcher.entries[0];
  if (launcher.entries.length === 1 && onlyEntry)
    redirect(organizationAddressPath(onlyEntry.tenantShortName, onlyEntry.organizationShortName));

  return (
    <main
      className="flex min-h-svh w-full flex-col bg-background text-foreground"
      {...createThemeRootProps(undefined)}
    >
      <VortexFontStylesheets />
      <style href="vortex-ui-styles" precedence="default">
        {ALL_UI_STYLES_CSS}
      </style>
      <header className="sticky top-0 z-10 border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="text-base font-bold tracking-tight text-foreground hover:text-primary transition-colors"
            >
              Vortex
            </Link>
            <Badge variant="outline" className="text-xs">
              Organisations
            </Badge>
          </div>
          <form action={signOut}>
            <SubmitButton variant="ghost" className="w-auto text-sm" pendingLabel="Signing out…">
              Sign out
            </SubmitButton>
          </form>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {launcher.entries.length === 0 ? "No organisations available" : "Choose an organisation"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {launcher.entries.length === 0
              ? "You are signed in, but you do not currently have an active organisation account."
              : "Select an organisation to open its applications and workspace."}
          </p>
        </div>

        {launcher.entries.length === 0 ? (
          <Empty className="my-auto border border-dashed border-border py-12">
            <EmptyMedia variant="icon">
              <Icon name="building-2" className="size-8 text-muted-foreground" />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No organisations available</EmptyTitle>
              <EmptyDescription>
                You are signed in, but you do not currently have an active organisation account.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="w-full">
            <ApplicationLauncher
              placementId="organization-chooser"
              settings={{ title: { kind: "text", value: "Available organisations" } }}
              slots={{}}
              breakpoint="desktop"
              metadata={APPLICATION_LAUNCHER_BLOCK_RELEASE}
              availability="available"
              data={{ status: "ready", values: organizationTileValues(launcher.entries) }}
              events={{ row_action: openOrganization }}
            />
          </div>
        )}
      </div>
    </main>
  );
}
