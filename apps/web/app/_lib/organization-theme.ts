import "server-only";

import { cache } from "react";
import {
  organizationSelectionCandidateSchema,
  type IdentitySession,
} from "@vortex/platform/schema";
import {
  readCurrentOrganizationThemeAfterAuthorization,
  type OrganizationThemeRead,
} from "@vortex/platform/server";
import { humanOrganizationRequests } from "./server-composition";

export type OrganizationThemeLoad =
  | Readonly<{ kind: "available"; theme: OrganizationThemeRead }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/**
 * The organisation theme of one organisation, as any member of it may read it. One read per
 * request and organisation: the document root, the application frame and the page of one request
 * share it. A read that fails is reported, never replaced by "no organisation theme".
 */
export const loadOrganizationTheme = cache(
  async (session: IdentitySession, organizationId: string): Promise<OrganizationThemeLoad> => {
    const result = await humanOrganizationRequests().run(
      session,
      organizationSelectionCandidateSchema.parse({ organizationId }),
      (transaction) => readCurrentOrganizationThemeAfterAuthorization(transaction),
    );
    if (result.kind === "available") return { kind: "available", theme: result.value };
    // A person who is not a member of the organisation is refused: expected, not a fault.
    if (result.kind === "unavailable")
      console.info(
        `[organization-theme] read refused: ${result.code ?? result.cause ?? "no cause"}`,
      );
    else
      console.error(
        `[organization-theme] read unavailable: ${result.databaseCode ?? result.cause ?? "unknown"}`,
      );
    return { kind: result.kind };
  },
);
