import "server-only";

import {
  applicationRootIdSchema,
  revisionSchema,
  sessionContextSchema,
  type DefinitionConsumerReadResult,
  type PreparedApplicationPermissionRegistration,
  type SessionContext,
} from "@vortex/contracts";
import { withResolvedRequestTransaction } from "@vortex/db";
import {
  createDatabaseDefinitionConsumerReadService,
  type ImmutableDefinitionPublicationCatalogueDefinition,
} from "@vortex/definition";
import type { HumanOrganizationRequestDependencies } from "./human-organization-request";
import { createPermissionRegistryDefinitionAdapter } from "./permission-registry-definition-adapter";

type ApplicationRelease = Extract<DefinitionConsumerReadResult, { kind: "application" }>;

export type StoredApplicationPermissionSourceEvidence = Readonly<{
  applicationRelease: ApplicationRelease;
  permissionRegistration: PreparedApplicationPermissionRegistration;
}>;

export type StoredApplicationPermissionSourceDependencies = Readonly<{
  systemContext: SessionContext;
  applicationRootId: string;
  releaseRevision: number;
  definitionCatalogue: ImmutableDefinitionPublicationCatalogueDefinition;
  resolvedRequestTransaction?: HumanOrganizationRequestDependencies["resolvedRequestTransaction"];
}>;

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

export const createStoredApplicationPermissionSource = (
  dependencies: StoredApplicationPermissionSourceDependencies,
) => {
  const systemContext = sessionContextSchema.parse(dependencies.systemContext);
  if (systemContext.callerKind !== "system")
    throw new Error("STORED_APPLICATION_SYSTEM_CONTEXT_UNAVAILABLE");
  const applicationRootId = applicationRootIdSchema.parse(dependencies.applicationRootId);
  if (
    systemContext.applicationRootId !== undefined &&
    !sameUuid(systemContext.applicationRootId, applicationRootId)
  )
    throw new Error("STORED_APPLICATION_SYSTEM_CONTEXT_UNAVAILABLE");
  const releaseRevision = revisionSchema
    .max(Number.MAX_SAFE_INTEGER)
    .parse(dependencies.releaseRevision);
  const runResolved = dependencies.resolvedRequestTransaction ?? withResolvedRequestTransaction;

  return Object.freeze({
    readExact: (): Promise<StoredApplicationPermissionSourceEvidence> =>
      runResolved(
        async () => ({ context: systemContext, scope: undefined }),
        async (transaction) => {
          const reader = createDatabaseDefinitionConsumerReadService(
            dependencies.definitionCatalogue,
            transaction,
          );
          const definitionAdapter = createPermissionRegistryDefinitionAdapter(reader);
          const permissionRegistration = await definitionAdapter.prepareApplicationRegistration(
            systemContext,
            {
              applicationRootId,
              releaseRevision,
            },
          );
          const applicationRelease = await reader.read(systemContext, {
            kind: "application",
            rootId: applicationRootId,
            selector: { selection: "revision", releaseRevision },
          });
          if (
            applicationRelease.kind !== "application" ||
            !sameUuid(applicationRelease.organizationId, systemContext.organizationId) ||
            !sameUuid(applicationRelease.rootId, applicationRootId) ||
            applicationRelease.releaseRevision !== releaseRevision ||
            applicationRelease.correlationId.toLowerCase() !==
              systemContext.correlationId.toLowerCase() ||
            !sameUuid(permissionRegistration.organizationId, applicationRelease.organizationId) ||
            !sameUuid(permissionRegistration.applicationRootId, applicationRelease.rootId) ||
            permissionRegistration.applicationRelease.definitionKey !==
              applicationRelease.definitionKey ||
            permissionRegistration.applicationRelease.releaseRevision !==
              applicationRelease.releaseRevision ||
            permissionRegistration.applicationRelease.releaseVersion !==
              applicationRelease.releaseVersion ||
            permissionRegistration.applicationRelease.validationContractVersion !==
              applicationRelease.validationContractVersion ||
            permissionRegistration.applicationRelease.contentFingerprint !==
              applicationRelease.contentFingerprint ||
            permissionRegistration.applicationRelease.resolutionFingerprint !==
              applicationRelease.resolutionFingerprint
          )
            throw new Error("STORED_APPLICATION_DEFINITION_EVIDENCE_UNAVAILABLE");
          return { applicationRelease, permissionRegistration };
        },
      ),
  });
};
