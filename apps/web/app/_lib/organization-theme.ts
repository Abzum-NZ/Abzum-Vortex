import "server-only";

import { cache } from "react";
import {
  organizationSelectionCandidateSchema,
  type IdentitySession,
} from "@vortex/platform/schema";
import {
  readCurrentOrganizationThemeAfterAuthorization,
  resolveApplicationTheme,
  type ApplicationTheme,
  type OrganizationThemeRead,
  type StoredApplicationTheme,
} from "@vortex/platform/server";
import { humanOrganizationRequests } from "./server-composition";

export type OrganizationThemeLoad =
  | Readonly<{ kind: "available"; theme: OrganizationThemeRead }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/**
 * The organisation theme of one organisation, as any member of it may read it. One read per
 * request and organisation: the document root, the application frame and the page of one request
 * share it. A read that fails is reported (the request runner logs it once), never replaced by
 * "no organisation theme".
 */
export const loadOrganizationTheme = cache(
  async (session: IdentitySession, organizationId: string): Promise<OrganizationThemeLoad> => {
    const result = await humanOrganizationRequests().run(
      session,
      organizationSelectionCandidateSchema.parse({ organizationId }),
      (transaction) => readCurrentOrganizationThemeAfterAuthorization(transaction),
    );
    if (result.kind === "available") return { kind: "available", theme: result.value };
    // The request runner already logged a refused or failed read, once.
    return { kind: result.kind };
  },
);

export type ApplicationThemeLoad =
  | Readonly<{ kind: "available"; theme: ApplicationTheme }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/**
 * The theme one installed application is drawn with in an organisation: its stored theme resolved
 * through the organisation's by the one resolution function. The organisation read is the request's
 * shared one, so the frame, the page and the document root add no read.
 */
export const loadApplicationTheme = async (
  session: IdentitySession,
  organizationId: string,
  stored: StoredApplicationTheme,
): Promise<ApplicationThemeLoad> => {
  const organization = await loadOrganizationTheme(session, organizationId);
  return organization.kind === "available"
    ? { kind: "available", theme: resolveApplicationTheme(stored, organization.theme.selection) }
    : organization;
};
