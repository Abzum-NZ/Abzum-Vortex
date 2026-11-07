import { notFound } from "next/navigation";
import {
  authoredApplicationThemeSelection,
  organizationSelectionCandidateSchema,
  organizationThemeFullSelection,
} from "@vortex/platform/schema";
import { readOrganizationThemeChangePermittedAfterAuthorization } from "@vortex/platform/server";
import { loadStudioFrameContext } from "../../_lib/studio-frame";
import { continueStudioSession } from "../../_lib/studio-session";
import { studioThemeOptions } from "../../_lib/studio-theme-catalogue";
import { StudioUnavailable } from "../../_components/studio-unavailable";
import { StudioOrganizationTheme } from "../../_components/studio-organization-theme";
import { loadStudioChromeTheme } from "../../../_lib/document-theme";
import { loadOrganizationLauncher } from "../../../_lib/organization-context";
import { loadOrganizationTheme } from "../../../_lib/organization-theme";
import { humanOrganizationRequests } from "../../../_lib/server-composition";

export const dynamic = "force-dynamic";

/** A refusal here says what the editor address says for the same person: their account lacks the permission. */
const refused = { kind: "refused", reason: "permission_missing" } as const;

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
    return <StudioUnavailable subject="Studio" result={resolved} />;
  const launcher = await loadOrganizationLauncher(resolved.session);
  if (launcher.kind !== "available") {
    console.error(`[studio] organization theme could not list organisations: ${launcher.kind}`);
    return (
      <StudioUnavailable
        subject="The organisation theme"
        result={{ kind: "temporarily_unavailable" }}
      />
    );
  }
  const entry = launcher.entries.find((candidate) => candidate.organizationId === organizationId);
  if (entry === undefined) notFound();
  // A person without Studio gets Studio's refusal here too, before this page reads the theme or the
  // change permission (the document root's chrome colours are the only theme read before it).
  const studio = await loadStudioFrameContext(organizationId);
  if (studio.kind !== "available")
    return (
      <StudioUnavailable
        subject="The organisation theme"
        result={studio.kind === "refused" ? refused : studio}
        organizationId={organizationId}
      />
    );
  // The theme is the request's one organisation-theme read, shared with the document root; a read
  // that fails was logged once by the request runner, so nothing is logged again here.
  const themeRead = await loadOrganizationTheme(resolved.session, entry.organizationId);
  const unavailable = (kind: "unavailable" | "refused" | "temporarily_unavailable") => (
    <StudioUnavailable
      subject="The organisation theme"
      result={kind === "temporarily_unavailable" ? { kind } : refused}
      organizationId={organizationId}
    />
  );
  if (themeRead.kind !== "available") return unavailable(themeRead.kind);
  const permitted = await humanOrganizationRequests().run(
    resolved.session,
    organizationSelectionCandidateSchema.parse({ organizationId: entry.organizationId }),
    (transaction) => readOrganizationThemeChangePermittedAfterAuthorization(transaction),
  );
  if (permitted.kind !== "available") return unavailable(permitted.kind);
  const theme = themeRead.theme;
  const canChange = permitted.value;
  const { unresolvable } = await loadStudioChromeTheme(organizationId);
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
      unresolvable={unresolvable}
    />
  );
}
