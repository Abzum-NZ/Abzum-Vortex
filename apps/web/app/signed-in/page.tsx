import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { OrganizationLauncherEntry } from "@vortex/platform/schema";
import {
  createThemeRootProps,
  type DisplayRow,
  type DisplaySemanticEvent,
  type LauncherRowsPayload,
} from "@vortex/ui";
import {
  acceptOrganizationInvitation,
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  CONTAINER_BLOCK_RELEASE,
  DEFAULT_PLATFORM_THEME_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  HEADING_BLOCK_RELEASE,
  listPendingInvitations,
  organizationChooserEmptyPage,
  organizationChooserJoinEventId,
  organizationChooserPage,
  organizationChooserOpenEventId,
  organizationChooserPlacementId,
  organizationChooserShell,
  organizationChooserWithInvitationsPage,
  organizationInvitationsPage,
  organizationInvitationsPlacementId,
  type PendingInvitation,
} from "@vortex/platform/server";
import { correlationIdSchema, describeFailure } from "@vortex/platform/schema";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@vortex/ui/components/card";
import { signOut } from "../auth/actions";
import { SubmitButton } from "../auth/_components/submit-button";
import { continueSessionOrEnd, redirectToSessionEnd } from "../auth/_lib/session-redirect";
import {
  resolveIdentitySession,
  resolveIdentitySessionWithEmail,
  resolveVerifiedIdentity,
} from "../auth/_lib/session-server";
import { JoinOutcomeNotice } from "./_components/join-outcome-notice";
import { OrganizationChooserPage } from "./_components/organization-chooser-page";
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
): LauncherRowsPayload => {
  const rows = entries.map((entry): DisplayRow => ({
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
  }));
  return { kind: "launcher_rows", headingKey: "name", secondaryKey: "icon", rows };
};

/**
 * Tile activation is the launcher block's declared `row_action` event. The browser supplies only
 * the tile's identity and the event's declared identity, which must be the chooser's open identity; this server action re-resolves the signed-in person's current organisation
 * entries and opens the matching one, so a withdrawn or foreign organisation is never opened from
 * stale page data or a crafted identity.
 */
async function openOrganization(event: DisplaySemanticEvent): Promise<void> {
  "use server";
  if (event?.event !== "row_action" || typeof event.recordId !== "string") return;
  if (event.eventId !== organizationChooserOpenEventId) {
    console.error(
      `[chooser] open refused: ROW_ACTION_EVENT_UNKNOWN eventId=${String(event.eventId)}`,
    );
    return;
  }
  const identity = await continueSessionOrEnd(await resolveIdentitySession());
  if (identity.kind === "temporarily_unavailable") redirect("/signed-in");

  const current = await loadOrganizationLauncher(identity.session);
  if (current.kind !== "available") redirect("/signed-in");
  const entry = current.entries.find((candidate) => candidate.organizationId === event.recordId);
  if (entry === undefined) redirect("/signed-in");
  redirect(organizationAddressPath(entry.tenantShortName, entry.organizationShortName));
}

const DAY_MS = 86_400_000;

/** How long an invitation stays open, in whole days: the same in every time zone. */
const invitationOpenFor = (expiresAt: string, now: number): string => {
  const days = Math.floor((Date.parse(expiresAt) - now) / DAY_MS);
  return days < 1
    ? "Invitation closes within a day"
    : `Invitation open for ${days} more ${days === 1 ? "day" : "days"}`;
};

/** Closed launcher projection of the invitations waiting for the person's verified email. */
const invitationTileValues = (
  invitations: readonly PendingInvitation[],
  now: number,
): LauncherRowsPayload => ({
  kind: "launcher_rows",
  headingKey: "name",
  secondaryKey: "icon",
  rows: invitations.map((invitation): DisplayRow => ({
    recordId: invitation.invitationId,
    cells: {
      name: { kind: "text", text: invitation.organizationName },
      description: {
        kind: "text",
        text: [
          invitation.tenantName === invitation.organizationName ? undefined : invitation.tenantName,
          invitationOpenFor(invitation.expiresAt, now),
        ]
          .filter((part) => part !== undefined)
          .join(" · "),
      },
      icon: { kind: "text", text: "building-2" },
    },
  })),
});

/** The invitations waiting for the signed-in person, or undefined when they could not be read. */
const readPendingInvitations = async (): Promise<readonly PendingInvitation[] | undefined> => {
  const verified = await resolveVerifiedIdentity();
  if (verified === undefined) return [];
  try {
    return await listPendingInvitations(verified);
  } catch (error) {
    console.error("[signed-in] pending invitations unavailable: " + describeFailure(error));
    return undefined;
  }
};

/** Why a join from an invitation did not happen, keyed by the outcome the chooser is given. */
const joinOutcomeSentences: Readonly<Record<string, string>> = {
  closed: "That invitation is no longer open. Ask the organisation to invite you again.",
  inactive: "Your account is not active, so it cannot join an organisation.",
  unavailable: "Joining is not available right now. Try again shortly.",
};

const joinRefused = (outcome: keyof typeof joinOutcomeSentences): never =>
  redirect(`/signed-in?join=${outcome}`);

/**
 * Joining is the invitation tile's declared `row_action`. The browser names only the invitation;
 * this server action reads the signed-in person's verified identity again, accepts the invitation
 * only while it is still waiting for that verified email, and opens the organisation it joined.
 * When it cannot, the chooser says why.
 */
async function joinOrganization(event: DisplaySemanticEvent): Promise<void> {
  "use server";
  if (event?.event !== "row_action" || typeof event.recordId !== "string") return;
  if (event.eventId !== organizationChooserJoinEventId) {
    console.error(
      "[chooser] join refused: ROW_ACTION_EVENT_UNKNOWN eventId=" + String(event.eventId),
    );
    return;
  }
  const identity = await continueSessionOrEnd(await resolveIdentitySession());
  if (identity.kind === "temporarily_unavailable") return joinRefused("unavailable");
  const verified = await resolveVerifiedIdentity();
  if (verified === undefined) return joinRefused("unavailable");
  const pending = await readPendingInvitations();
  if (pending === undefined) return joinRefused("unavailable");
  const invitation = pending.find((candidate) => candidate.invitationId === event.recordId);
  if (invitation === undefined) return joinRefused("closed");
  const accepted = await acceptOrganizationInvitation(verified, {
    invitationId: invitation.invitationId,
    correlationId: correlationIdSchema.parse(randomUUID()),
  });
  if (accepted.outcome !== "accepted" && accepted.outcome !== "already_accepted") {
    console.info("[chooser] join refused: INVITATION_" + accepted.outcome.toUpperCase());
    return joinRefused(accepted.outcome === "identity_inactive" ? "inactive" : "closed");
  }
  const current = await loadOrganizationLauncher(identity.session);
  const entry =
    current.kind === "available"
      ? current.entries.find((candidate) => candidate.organizationId === invitation.organizationId)
      : undefined;
  if (entry === undefined) redirect("/signed-in");
  redirect(organizationAddressPath(entry.tenantShortName, entry.organizationShortName));
}

const organizationsUnavailable = (
  <main
    className="flex min-h-svh items-center justify-center p-4 bg-background text-foreground"
    {...createThemeRootProps(undefined, DEFAULT_PLATFORM_THEME_RELEASE.tokens)}
  >
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
      <CardFooter className="flex justify-between gap-3">
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

const CHOOSER_BLOCK_RELEASES = [
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  CONTAINER_BLOCK_RELEASE,
  HEADING_BLOCK_RELEASE,
];

export default async function SignedInPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ join?: string | string[] }> }>) {
  const { join } = await searchParams;
  const joinSentence = typeof join === "string" ? joinOutcomeSentences[join] : undefined;
  const result = await continueSessionOrEnd(
    await retryOnceWhenTemporarilyUnavailable("session", resolveIdentitySession),
  );
  if (result.kind === "temporarily_unavailable") return organizationsUnavailable;

  const launcher = await retryOnceWhenTemporarilyUnavailable("organisations", () =>
    loadOrganizationLauncher(result.session),
  );
  if (launcher.kind === "temporarily_unavailable") return organizationsUnavailable;
  if (launcher.kind !== "available") return redirectToSessionEnd();
  // Invitations that cannot be read never hide the organisations the person already belongs to.
  const read = await readPendingInvitations();
  if (read === undefined && launcher.entries.length === 0) return organizationsUnavailable;
  const invitations = read ?? [];
  const onlyEntry = launcher.entries[0];
  if (
    launcher.entries.length === 1 &&
    onlyEntry &&
    invitations.length === 0 &&
    joinSentence === undefined
  )
    redirect(organizationAddressPath(onlyEntry.tenantShortName, onlyEntry.organizationShortName));

  const { email } = await resolveIdentitySessionWithEmail();
  if (email === undefined) throw new Error("Active identity session resolved without an email");
  const hasOrganizations = launcher.entries.length > 0;
  const hasInvitations = invitations.length > 0;
  const page = hasOrganizations
    ? hasInvitations
      ? organizationChooserWithInvitationsPage
      : organizationChooserPage
    : hasInvitations
      ? organizationInvitationsPage
      : organizationChooserEmptyPage;

  const now = Date.now();
  return (
    <>
      {joinSentence === undefined ? null : <JoinOutcomeNotice sentence={joinSentence} />}
      <OrganizationChooserPage
        page={page}
        shell={organizationChooserShell}
        launchers={[
          ...(hasOrganizations
            ? [
                {
                  placementId: organizationChooserPlacementId,
                  values: organizationTileValues(launcher.entries),
                  onRowAction: openOrganization,
                },
              ]
            : []),
          ...(hasInvitations
            ? [
                {
                  placementId: organizationInvitationsPlacementId,
                  values: invitationTileValues(invitations, now),
                  onRowAction: joinOrganization,
                },
              ]
            : []),
        ]}
        account={{ email }}
        platformBlockReleases={CHOOSER_BLOCK_RELEASES}
        fieldInputControlReleases={FIELD_INPUT_CONTROL_RELEASES}
        platformThemeTokens={DEFAULT_PLATFORM_THEME_RELEASE.tokens}
      />
    </>
  );
}
