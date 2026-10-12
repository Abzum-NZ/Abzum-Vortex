import "server-only";

import {
  createHumanApplicationPublisher,
  type HumanApplicationPublicationPreparationResult,
  type HumanApplicationPublicationResult,
} from "@web/platform-server";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import { mapWebError } from "./web-error-mapper";

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
  } catch (error) {
    return mapWebError(error, {
      route: "definition-publication",
      operation: "prepare",
      code: "DEFINITION_PUBLICATION_PREPARATION_FAILED",
      fallback: { kind: "temporarily_unavailable" },
    });
  }
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
  } catch (error) {
    return mapWebError(error, {
      route: "definition-publication",
      operation: "publish",
      code: "DEFINITION_PUBLICATION_FAILED",
      fallback: { kind: "temporarily_unavailable" },
    });
  }
};
