import "server-only";

import {
  createHumanDefinitionPublisher,
  type HumanDefinitionKind,
  type HumanDefinitionPublicationDraftResult,
  type HumanDefinitionPublicationPreparationResult,
  type HumanDefinitionPublicationResult,
} from "@vortex/platform/server";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import { mapWebError } from "./web-error-mapper";

export const loadHumanDefinitionPublicationDraft = async (
  organizationId: string, rootId: string, definitionKind: HumanDefinitionKind,
): Promise<HumanDefinitionPublicationDraftResult> => {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    return await createHumanDefinitionPublisher({
      requests: humanOrganizationRequests(), catalogue: installedReleaseCatalogue,
    }).readDraft(resolved.session, organizationId, rootId, definitionKind);
  } catch (error) {
    return mapWebError(error, {
      route: "definition-publication",
      operation: "read-draft",
      code: "DEFINITION_PUBLICATION_DRAFT_READ_FAILED",
      fallback: { kind: "temporarily_unavailable" },
    });
  }
};

/** Each call resolves the current human; the browser supplies only a strict command. */
export const prepareHumanDefinitionPublication = async (
  organizationId: string, candidate: unknown,
): Promise<HumanDefinitionPublicationPreparationResult> => {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    return await createHumanDefinitionPublisher({
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

export const publishHumanDefinition = async (
  organizationId: string, candidate: unknown,
): Promise<HumanDefinitionPublicationResult> => {
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return resolved.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    return await createHumanDefinitionPublisher({
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
