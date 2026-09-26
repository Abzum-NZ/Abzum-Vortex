import Link from "next/link";
import { redirect } from "next/navigation";
import type { OrganizationLauncherEntry } from "@vortex/contracts";
import {
  ALL_UI_STYLES_CSS,
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  ApplicationLauncher,
  createThemeRootProps,
  type DisplayRow,
  type DisplaySemanticEvent,
  type ListPayload,
} from "@vortex/ui";
import { signOut } from "../auth/actions";
import { AuthShell } from "../auth/_components/auth-shell";
import { SubmitButton } from "../auth/_components/submit-button";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { loadOrganizationLauncher } from "../_lib/organization-context";

export const dynamic = "force-dynamic";

const organizationAddressPath = (entry: {
  tenantShortName: string;
  organizationShortName: string;
}) => `/${encodeURIComponent(entry.tenantShortName)}/${encodeURIComponent(entry.organizationShortName)}`;

/**
 * Closed launcher projection of the person's current organisation entries. Each tile's identity is
 * the organisation's permanent identity and its only cell is the name the chooser always showed
 * (organisation, tenant and, when present, account), so no address or authority reaches the page.
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
          text: [entry.organizationDisplayName, entry.tenantDisplayName, entry.accountDisplayName]
            .filter((part) => part !== undefined)
            .join(" · "),
        },
      },
    }),
  );
  return { kind: "list", headingKey: "name", rows };
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
  const identity = await resolveIdentitySession();
  if (identity.kind === "temporarily_unavailable") redirect("/signed-in");
  if (identity.kind === "invalid_session_state" || identity.kind === "expired_or_revoked")
    redirect("/auth/session-ended");
  if (identity.kind !== "active") redirect("/auth/sign-in?status=session-ended");

  const current = await loadOrganizationLauncher(identity.session);
  if (current.kind !== "available") redirect("/signed-in");
  const entry = current.entries.find((candidate) => candidate.organizationId === event.recordId);
  if (entry === undefined) redirect("/signed-in");
  redirect(organizationAddressPath(entry));
}

export default async function SignedInPage() {
  const result = await resolveIdentitySession();
  if (result.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="Organisations are temporarily unavailable"
        description="Your sign-in is still active. Try loading your organisations again."
      >
        <Link href="/signed-in">Try again</Link>
      </AuthShell>
    );
  if (result.kind === "invalid_session_state" || result.kind === "expired_or_revoked")
    redirect("/auth/session-ended");
  if (result.kind !== "active") redirect("/auth/sign-in?status=session-ended");

  const launcher = await loadOrganizationLauncher(result.session);
  if (launcher.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="Organisations are temporarily unavailable"
        description="Your sign-in is still active. Try loading your organisations again."
      >
        <Link href="/signed-in">Try again</Link>
      </AuthShell>
    );
  if (launcher.kind !== "available") redirect("/auth/session-ended");
  const onlyEntry = launcher.entries[0];
  if (launcher.entries.length === 1 && onlyEntry) redirect(organizationAddressPath(onlyEntry));

  return (
    <AuthShell
      eyebrow="Organisation access"
      title={
        launcher.entries.length === 0 ? "No organisations available" : "Choose an organisation"
      }
      description={
        launcher.entries.length === 0
          ? "You are signed in, but you do not currently have an active organisation account."
          : "Each browser tab keeps its selected organisation in the page address."
      }
    >
      {launcher.entries.length > 0 ? (
        <div {...createThemeRootProps(undefined)}>
          <style href="vortex-ui-styles" precedence="default">
            {ALL_UI_STYLES_CSS}
          </style>
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
      ) : null}
      <form action={signOut} className="auth-form">
        <SubmitButton pendingLabel="Signing out…">Sign out</SubmitButton>
      </form>
    </AuthShell>
  );
}
