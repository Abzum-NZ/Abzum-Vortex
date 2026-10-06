import "server-only";

import {
  createOrganizationLocalAdministrationService,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import type { IdentitySession, OrganizationAccountId, OrganizationId } from "@vortex/contracts";
import { humanOrganizationRequestDependencies } from "./server-composition";

export type CurrentOrganizationAccountResult = HumanOrganizationRequestResult<
  Readonly<{
    organizationId: OrganizationId;
    organizationAccountId: OrganizationAccountId;
    revision: number;
  }>
>;

export const loadCurrentOrganizationAccount = async (
  session: IdentitySession,
  organizationId: OrganizationId,
): Promise<CurrentOrganizationAccountResult> => {
  try {
    const result = await createOrganizationLocalAdministrationService(
      humanOrganizationRequestDependencies(),
    ).readOwnProfile(session, { organizationId });
    if (result.kind !== "available") return result;

    return {
      kind: "available",
      value: {
        organizationId,
        organizationAccountId: result.value.organizationAccountId,
        revision: result.value.revision,
      },
    };
  } catch {
    return { kind: "temporarily_unavailable" };
  }
};
