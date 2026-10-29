import "server-only";

import {
  createHumanDefinitionPublisher,
  type HumanDefinitionPublicationPreparationResult,
  type HumanDefinitionPublicationResult,
} from "@vortex/platform/server";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import { mapWebError } from "./web-error-mapper";

/** Each call resolves the current human; the browser supplies only a strict command. */
export const prepareHumanDefinitionPublication = async (
  organizationId: string,
  candidate: unknown,
): Promise<HumanDefinitionPublicationPreparationResult> => {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" }
        : { kind: "refused" };
    return await createHumanDefinitionPublisher({
      requests: humanOrganizationRequests(),
      catalogue: installedReleaseCatalogue,
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

export const publishHumanDefinition = async (
  organizationId: string,
  candidate: unknown,
): Promise<HumanDefinitionPublicationResult> => {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" }
        : { kind: "refused" };
    return await createHumanDefinitionPublisher({
      requests: humanOrganizationRequests(),
      catalogue: installedReleaseCatalogue,
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
