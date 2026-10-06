import "server-only";

import {
  createHumanApplicationPublisher,
  type HumanApplicationPublicationPreparationResult,
  type HumanApplicationPublicationResult,
} from "@vortex/access";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";

/** Each call resolves the current human; the browser supplies only a strict command. */
export const prepareHumanApplicationPublication = async (
  organizationId: string, candidate: unknown,
): Promise<HumanApplicationPublicationPreparationResult> => {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    return await createHumanApplicationPublisher({
      requests: humanOrganizationRequests(), catalogue: installedReleaseCatalogue,
    }).prepare(resolved.session, organizationId, candidate);
  } catch { return { kind: "temporarily_unavailable" }; }
};

export const publishHumanApplication = async (
  organizationId: string, candidate: unknown,
): Promise<HumanApplicationPublicationResult> => {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    return await createHumanApplicationPublisher({
      requests: humanOrganizationRequests(), catalogue: installedReleaseCatalogue,
    }).publish(resolved.session, organizationId, candidate);
  } catch { return { kind: "temporarily_unavailable" }; }
};
