import Link from "next/link";
import { redirect } from "next/navigation";
import {
  LIST_BLOCK_RELEASE,
  ListDisplay,
  type DisplayRow,
  type DisplaySemanticEvent,
  type ProjectedDisplayValues,
} from "@vortex/ui";
import { signOut } from "../auth/actions";
import { AuthShell } from "../auth/_components/auth-shell";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { loadOrganizationLauncher } from "../_lib/organization-context";

export const dynamic = "force-dynamic";

const organizationAddressPath = (entry: {
  tenantShortName: string;
  organizationShortName: string;
}) => `/${encodeURIComponent(entry.tenantShortName)}/${encodeURIComponent(entry.organizationShortName)}`;

const organizationListValues = (
  entries: readonly {
    organizationId: string;
    tenantDisplayName: string;
    organizationDisplayName: string;
    accountDisplayName?: string;
  }[],
): ProjectedDisplayValues => {
  const rows: readonly DisplayRow[] = entries.map((entry): DisplayRow => ({
    recordId: entry.organizationId,
    cells: {
      name: { kind: "text", text: entry.organizationDisplayName },
      tenant: {
        kind: "text",
        text:
          entry.accountDisplayName === undefined
            ? entry.tenantDisplayName
            : `${entry.tenantDisplayName} · ${entry.accountDisplayName}`,
      },
    },
  }));
  return { kind: "list", headingKey: "name", secondaryKey: "tenant", rows };
};

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

  /**
   * Tile activation is the declared `row_action` event. It is handled by this server action, which
   * re-resolves the signed-in person's current organisation entries before opening the chosen
   * organisation, so a withdrawn or foreign organisation is never opened from stale page data.
   */
  async function openOrganization(event: DisplaySemanticEvent): Promise<void> {
    "use server";
    if (event.event !== "row_action") return;
    const currentIdentity = await resolveIdentitySession();
    if (
      currentIdentity.kind === "invalid_session_state" ||
      currentIdentity.kind === "expired_or_revoked"
    )
      redirect("/auth/session-ended");
    if (currentIdentity.kind !== "active") redirect("/auth/sign-in?status=session-ended");

    const current = await loadOrganizationLauncher(currentIdentity.session);
    if (current.kind !== "available") redirect("/signed-in");
    const entry = current.entries.find(
      (candidate) => candidate.organizationId === event.recordId,
    );
    if (entry === undefined) redirect("/signed-in");
    redirect(organizationAddressPath(entry));
  }

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
        <ListDisplay
          placementId="organization-chooser"
          settings={{ title: { kind: "text", value: "Available organisations" } }}
          slots={{}}
          breakpoint="desktop"
          metadata={LIST_BLOCK_RELEASE}
          availability="available"
          projectedData={{
            status: "ready",
            values: organizationListValues(launcher.entries),
          }}
          displayEvents={{ row_action: openOrganization }}
        />
      ) : null}
      <form action={signOut} className="auth-form">
        <button type="submit">Sign out</button>
      </form>
    </AuthShell>
  );
}
