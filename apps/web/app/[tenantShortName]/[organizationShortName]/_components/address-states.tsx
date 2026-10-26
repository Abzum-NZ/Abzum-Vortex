import "server-only";

import Link from "next/link";
import type { ReactElement } from "react";
import type { IdentitySession } from "@vortex/platform/schema";
import {
  DEFAULT_PLATFORM_THEME_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  organizationAddressStateActionPlacementId,
  organizationAddressStatePage,
  organizationLauncherShell,
  type OrganizationAddressState,
} from "@vortex/platform/server";
import type { ApplicationAccount } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@vortex/ui/components/empty";
import { AuthShell } from "../../../auth/_components/auth-shell";
import { loadOrganizationLauncher } from "../../../_lib/organization-context";
import { organizationAddressPath } from "../../../_lib/address-paths";
import { platformBlockReleasesFor } from "../../../_lib/platform-block-releases";
import { OrganizationAddressStatePage } from "./organization-launcher-page";

/**
 * What an address shows when it shows no application page. A refused and a missing address stay
 * indistinguishable: neither names a reason or whether anything exists.
 */
export type AddressState =
  | Readonly<{ kind: "unavailable"; back: "organization" | "chooser" }>
  | Readonly<{ kind: "page_not_open"; applicationName: string; homeHref: string }>
  | Readonly<{ kind: "temporarily_unavailable"; retryHref: string }>
  | Readonly<{ kind: "suspended" }>
  | Readonly<{ kind: "preview_not_runnable"; sentence: string; studioHref: string }>;

type AddressContext = Readonly<{
  session: IdentitySession;
  email: string;
  tenantShortName: string;
  organizationShortName: string;
}>;

const stateContent = (
  state: AddressState,
  organizationName: string,
  organizationHref: string,
): Readonly<{ page: OrganizationAddressState; href: string }> => {
  switch (state.kind) {
    case "unavailable":
      return state.back === "organization"
        ? {
            page: {
              key: "unavailable",
              title: "This address can't be opened",
              detail:
                "The application isn't here, or your access doesn't include it. Ask your administrator if you need it.",
              actionLabel: `Back to ${organizationName}`,
            },
            href: organizationHref,
          }
        : {
            page: {
              key: "unavailable",
              title: "This organisation can't be opened",
              detail:
                "It doesn't exist, or your sign-in doesn't belong to it. Choose one of your organisations instead.",
              actionLabel: "Choose an organisation",
            },
            href: "/signed-in",
          };
    case "page_not_open":
      return {
        page: {
          key: "page_not_open",
          title: "You don't have access to this page",
          detail:
            "Your role can't open this page, or it no longer exists. Ask an administrator if you need it.",
          actionLabel: `Back to ${state.applicationName}`,
        },
        href: state.homeHref,
      };
    case "temporarily_unavailable":
      return {
        page: {
          key: "temporarily_unavailable",
          title: "This page couldn't be loaded",
          detail: "Your sign-in is still active. Try loading it again.",
          actionLabel: "Try again",
        },
        href: state.retryHref,
      };
    case "suspended":
      return {
        page: {
          key: "suspended",
          title: "Your organisation account is suspended",
          detail:
            "This account needs explicit reactivation before it can be used. Signing in will not reactivate it.",
          actionLabel: "Choose another organisation",
        },
        href: "/signed-in",
      };
    case "preview_not_runnable":
      return {
        page: {
          key: "preview_not_runnable",
          title: "This draft cannot run yet",
          detail: state.sentence,
          actionLabel: "Open in Studio",
        },
        href: state.studioHref,
      };
  }
};

/**
 * The address state inside the organisation shell, so the header, the organisation switcher and
 * the account menu with sign out stay available, with the state's one way forward.
 */
export async function OrganizationAddressState({
  context,
  state,
}: Readonly<{ context: AddressContext; state: AddressState }>): Promise<ReactElement> {
  const { session, email, tenantShortName, organizationShortName } = context;
  const launcher = await loadOrganizationLauncher(session);
  if (launcher.kind !== "available")
    throw new Error(`Organisation launcher unavailable for the account menu: ${launcher.kind}`);
  const entry = launcher.entries.find(
    (candidate) =>
      candidate.tenantShortName === tenantShortName &&
      candidate.organizationShortName === organizationShortName,
  );
  const account: ApplicationAccount =
    entry?.accountDisplayName === undefined
      ? { email }
      : { email, displayName: entry.accountDisplayName };
  // An organisation the person does not belong to is never named back to them.
  const organizationName = entry?.organizationDisplayName ?? "your organisations";
  const organizationHref = organizationAddressPath(tenantShortName, organizationShortName);
  const content = stateContent(state, organizationName, organizationHref);
  const page = organizationAddressStatePage(content.page);
  return (
    <OrganizationAddressStatePage
      addressState={state.kind}
      page={page}
      shell={organizationLauncherShell}
      organizationName={entry?.organizationDisplayName ?? ""}
      organizationShortName={entry?.organizationShortName ?? ""}
      account={account}
      launcherHref={entry === undefined ? "/signed-in" : organizationHref}
      actionPlacementId={organizationAddressStateActionPlacementId}
      actionHref={content.href}
      platformBlockReleases={platformBlockReleasesFor(page, organizationLauncherShell)}
      fieldInputControlReleases={FIELD_INPUT_CONTROL_RELEASES}
      platformThemeTokens={DEFAULT_PLATFORM_THEME_RELEASE.tokens}
    />
  );
}

/** The sign-in itself could not be checked right now, so no account or organisation is known. */
export function SignInTemporarilyUnavailable({
  retryHref,
}: Readonly<{ retryHref: string }>): ReactElement {
  return (
    <AuthShell
      addressState="temporarily_unavailable"
      eyebrow="Application access"
      title="This address is temporarily unavailable"
      description="Your sign-in could not be checked just now. Try loading this address again."
    >
      <Button variant="outline" nativeButton={false} render={<Link href={retryHref} />}>
        Try again
      </Button>
    </AuthShell>
  );
}

/**
 * A page of an application the viewer may open whose addressed record or parameters cannot be
 * shown: the record does not exist, the viewer cannot see it, or the address is malformed. It
 * renders inside the application frame, which stays mounted around the page.
 */
export function PageSubjectNotFound({
  applicationName,
  homeHref,
}: Readonly<{ applicationName: string; homeHref: string }>): ReactElement {
  return (
    <Empty data-vortex-address-state="subject_not_found">
      <EmptyHeader>
        <EmptyTitle>This record doesn&apos;t exist or you can&apos;t see it</EmptyTitle>
        <EmptyDescription>
          The address may be out of date, or your role may not include this record.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" nativeButton={false} render={<Link href={homeHref} />}>
          {`Back to ${applicationName}`}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
