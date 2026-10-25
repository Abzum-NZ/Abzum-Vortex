"use server";

import type { ApplicationSwitcherData } from "@vortex/ui";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { loadApplicationSearch } from "../../../_lib/application-search";
import { loadPermittedApplicationsAtAddress } from "../../../_lib/organization-context";

type ApplicationSearchView = Awaited<ReturnType<typeof loadApplicationSearch>>;

/** Reads the viewer's permitted applications only when the frame's switcher is opened. */
export async function readApplicationSwitcherAction(
  tenantShortName: string,
  organizationShortName: string,
): Promise<ApplicationSwitcherData> {
  if ([tenantShortName, organizationShortName].some((value) => typeof value !== "string")) {
    console.error("[application-frame] switcher refused: malformed address");
    return { state: "unavailable", applications: [] };
  }
  const resolution = await resolveIdentitySession();
  if (resolution.kind !== "active") {
    console.error(`[application-frame] switcher refused: session ${resolution.kind}`);
    return { state: "unavailable", applications: [] };
  }
  try {
    const read = await loadPermittedApplicationsAtAddress(
      resolution.session,
      tenantShortName,
      organizationShortName,
    );
    if (read.kind === "temporarily_unavailable")
      console.error(
        `[application-shell] permitted applications unavailable: cause=${read.cause ?? "cause_not_provided"}`,
      );
    return {
      state:
        read.kind === "available"
          ? "available"
          : read.kind === "temporarily_unavailable"
            ? "temporarily_unavailable"
            : "unavailable",
      applications:
        read.kind === "available"
          ? read.applications.map((candidate) => ({
              key: candidate.key,
              name: candidate.name,
              href: `/${encodeURIComponent(tenantShortName)}/${encodeURIComponent(organizationShortName)}/${encodeURIComponent(candidate.key)}/${encodeURIComponent(candidate.homePageKey)}`,
            }))
          : [],
    };
  } catch (error) {
    console.error("[application-shell] permitted applications failed", error);
    return { state: "temporarily_unavailable", applications: [] };
  }
}

/**
 * Searches one application for the frame's header search when the address's query changes without
 * a new document. Only the expression comes from the browser; the address is rechecked against the
 * signed-in person's own permitted applications by the search read itself.
 */
export async function searchApplicationAction(
  tenantShortName: string,
  organizationShortName: string,
  applicationKey: string,
  expression: string,
): Promise<ApplicationSearchView> {
  if (
    [tenantShortName, organizationShortName, applicationKey, expression].some(
      (value) => typeof value !== "string",
    )
  ) {
    console.error("[application-frame] search refused: malformed address or expression");
    return { kind: "unavailable" };
  }
  const resolution = await resolveIdentitySession();
  if (resolution.kind !== "active") {
    console.error(`[application-frame] search refused: session ${resolution.kind}`);
    return { kind: "unavailable" };
  }
  return loadApplicationSearch(
    resolution.session,
    { tenantShortName, organizationShortName, applicationKey },
    expression,
  );
}
