import { notFound } from "next/navigation";
import {
  authoredApplicationThemeSelection,
  organizationSelectionCandidateSchema,
  organizationThemeFullSelection,
} from "@vortex/platform/schema";
import {
  readCurrentOrganizationThemeAfterAuthorization,
  readOrganizationThemeChangePermittedAfterAuthorization,
} from "@vortex/platform/server";
import { continueStudioSession } from "../../_lib/studio-session";
import { studioThemeOptions } from "../../_lib/studio-theme-catalogue";
import { StudioUnavailable } from "../../_components/studio-unavailable";
import { StudioOrganizationTheme } from "../../_components/studio-organization-theme";
import { loadOrganizationLauncher } from "../../../_lib/organization-context";
import { humanOrganizationRequests } from "../../../_lib/server-composition";

export const dynamic = "force-dynamic";

/**
 * One organisation's theme: the editor for the selection every application of the organisation
 * follows where it chose nothing of its own, and Studio draws with.
 */
export default async function StudioOrganizationThemePage({
  params,
}: Readonly<{ params: Promise<{ organizationId: string }> }>) {
  const { organizationId } = await params;
  const resolved = await continueStudioSession();
  if (resolved.kind === "temporarily_unavailable")
    return <StudioUnavailable subject="Studio" result={resolved} reloadHref="/studio" />;
  const launcher = await loadOrganizationLauncher(resolved.session);
  if (launcher.kind !== "available") {
    console.error(`[studio] organization theme could not list organisations: ${launcher.kind}`);
    return (
      <StudioUnavailable
        subject="The organisation theme"
        result={{ kind: "temporarily_unavailable" }}
        reloadHref={`/studio/${organizationId}/organization-theme`}
      />
    );
  }
  const entry = launcher.entries.find((candidate) => candidate.organizationId === organizationId);
  if (entry === undefined) notFound();
  const read = await humanOrganizationRequests().run(
    resolved.session,
    organizationSelectionCandidateSchema.parse({ organizationId: entry.organizationId }),
    async (transaction) => ({
      theme: await readCurrentOrganizationThemeAfterAuthorization(transaction),
      canChange: await readOrganizationThemeChangePermittedAfterAuthorization(transaction),
    }),
  );
  if (read.kind !== "available") {
    console.error(
      `[studio] organization theme read ${read.kind}: ${read.kind === "unavailable" ? (read.code ?? read.cause ?? "no cause") : (read.databaseCode ?? read.cause ?? "unknown")}`,
    );
    return (
      <StudioUnavailable
        subject="The organisation theme"
        result={{ kind: read.kind === "unavailable" ? "refused" : read.kind }}
        reloadHref={`/studio/${organizationId}/organization-theme`}
      />
    );
  }
  const { theme, canChange } = read.value;
  return (
    <StudioOrganizationTheme
      key={theme.revision}
      organizationId={entry.organizationId}
      organizationName={entry.organizationDisplayName}
      studioHref={`/studio/${entry.organizationId}`}
      options={studioThemeOptions}
      selection={authoredApplicationThemeSelection(organizationThemeFullSelection(theme.selection))}
      revision={theme.revision}
      canChange={canChange}
    />
  );
}
