"use server";

import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { loadApplicationSearch } from "../../../_lib/application-search";

type ApplicationSearchView = Awaited<ReturnType<typeof loadApplicationSearch>>;

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
  )
    return { kind: "unavailable" };
  const resolution = await resolveIdentitySession();
  if (resolution.kind !== "active") return { kind: "unavailable" };
  return loadApplicationSearch(
    resolution.session,
    { tenantShortName, organizationShortName, applicationKey },
    expression,
  );
}
