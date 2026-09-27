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
import { continueSessionOrEnd, SESSION_ENDED_PATH } from "../auth/_lib/session-redirect";
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
  const identity = continueSessionOrEnd(await resolveIdentitySession());
  if (identity.kind === "temporarily_unavailable") redirect("/signed-in");

  const current = await loadOrganizationLauncher(identity.session);
  if (current.kind !== "available") redirect("/signed-in");
  const entry = current.entries.find((candidate) => candidate.organizationId === event.recordId);
  if (entry === undefined) redirect("/signed-in");
  redirect(organizationAddressPath(entry.tenantShortName, entry.organizationShortName));
}

export default async function SignedInPage() {
  const result = continueSessionOrEnd(
    await retryOnceWhenTemporarilyUnavailable("session", resolveIdentitySession),
  );
  if (result.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="Organisations are temporarily unavailable"
        description="Your sign-in is still active. Try loading your organisations again."
      >
        <Link className="font-medium underline underline-offset-4" href="/signed-in">
          Try again
        </Link>
      </AuthShell>
    );

  const launcher = await retryOnceWhenTemporarilyUnavailable("organisations", () =>
    loadOrganizationLauncher(result.session),
  );
  if (launcher.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="Organisations are temporarily unavailable"
        description="Your sign-in is still active. Try loading your organisations again."
      >
        <Link className="font-medium underline underline-offset-4" href="/signed-in">
          Try again
        </Link>
      </AuthShell>
    );
  if (launcher.kind !== "available") redirect(SESSION_ENDED_PATH);
  const onlyEntry = launcher.entries[0];
  if (launcher.entries.length === 1 && onlyEntry)
    redirect(organizationAddressPath(onlyEntry.tenantShortName, onlyEntry.organizationShortName));

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
      <form action={signOut}>
        <SubmitButton pendingLabel="Signing out…">Sign out</SubmitButton>
      </form>
    </AuthShell>
  );
}
