import "server-only";

import {
  applicationRootIdSchema,
  permissionRegistryDefinitionReleaseSchema,
  platformIdSchema,
  preparedApplicationPermissionRegistrationSchema,
  revisionSchema,
  sessionContextSchema,
  type DefinitionConsumerReadResult,
  type ApplicationRootId,
  type PermissionDeclaration,
  type PermissionRegistryDefinitionRelease,
  type PermissionRegistryEntryCandidate,
  type PreparedApplicationPermissionRegistration,
  type SessionContext,
  type SystemApplicationBoundReleaseSetCommand,
  type SystemApplicationBoundReleaseSetResult,
  systemApplicationBoundReleaseSetResultSchema,
} from "@vortex/contracts";
import {
  canonicalJson,
  compareCanonicalStrings,
  fingerprintCanonicalValue,
} from "@vortex/definition";
import { fingerprintPermissionMeaning } from "./permission-fingerprints";
import { isLiveSystemContext } from "./private-system-context";

export const permissionRegistryPreparationErrorCodes = [
  "INVALID_PERMISSION_REGISTRY_PREPARATION_COMMAND",
  "PERMISSION_REGISTRY_CONTEXT_REFUSED",
  "PERMISSION_REGISTRY_DEFINITION_UNAVAILABLE",
  "PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID",
  "PERMISSION_REGISTRY_PERMISSION_OWNERSHIP_AMBIGUOUS",
] as const;

export type PermissionRegistryPreparationErrorCode =
  (typeof permissionRegistryPreparationErrorCodes)[number];

export class PermissionRegistryPreparationError extends Error {
  readonly code: PermissionRegistryPreparationErrorCode;

  constructor(code: PermissionRegistryPreparationErrorCode) {
    super(code);
    this.name = "PermissionRegistryPreparationError";
    this.code = code;
  }
}

export interface PermissionRegistryDefinitionSetReader {
  read(
    context: SessionContext,
    command: SystemApplicationBoundReleaseSetCommand,
  ): Promise<SystemApplicationBoundReleaseSetResult>;
}

export type PrepareApplicationPermissionRegistrationCommand = Readonly<{
  applicationRootId: ApplicationRootId;
  releaseRevision: number;
}>;

const releaseEvidence = (
  release: DefinitionConsumerReadResult,
): PermissionRegistryDefinitionRelease =>
  permissionRegistryDefinitionReleaseSchema.parse({
    kind: release.kind,
    definitionKey: release.definitionKey,
    rootId: release.rootId,
    releaseRevision: release.releaseRevision,
    releaseVersion: release.releaseVersion,
    validationContractVersion: release.validationContractVersion,
    contentFingerprint: release.contentFingerprint,
    resolutionFingerprint: release.resolutionFingerprint,
  });

const entriesFor = (
  applicationRootId: ApplicationRootId,
  release: DefinitionConsumerReadResult,
): PermissionRegistryEntryCandidate[] => {
  if (release.kind !== "application" && release.kind !== "module")
    throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID");
  const ownerKind = release.kind;
  const ownerId = platformIdSchema.parse(release.rootId);
  const sourceRelease = releaseEvidence(release);
  return release.content.permissions.map((permission) => ({
    applicationRootId,
    ownerKind,
    ownerId,
    permission,
    sourceRelease,
    meaningFingerprint: fingerprintPermissionMeaning(ownerKind, ownerId, permission),
  }));
};

const entrySubject = (entry: PermissionRegistryEntryCandidate): string =>
  `${entry.ownerKind}:${entry.ownerId}:${entry.permission.key}:${entry.permission.permissionId}`;

const applicationCatalogue = (permissions: readonly PermissionDeclaration[]) => {
  const included = permissions
    .filter((permission) => !permission.administrative)
    .sort((left, right) => compareCanonicalStrings(left.key, right.key));
  return {
    fingerprint: fingerprintCanonicalValue(included),
    permissionIds: included.map((permission) => permission.permissionId),
    permissionKeys: included.map((permission) => permission.key),
  };
};

const validateApplicationWildcardEvidence = (
  release: Extract<DefinitionConsumerReadResult, { kind: "application" }>,
  catalogue: ReturnType<typeof applicationCatalogue>,
): void => {
  const invalid = release.content.roles.some(
    (role) =>
      role.permissionSelection.kind === "application_wildcard" &&
      (role.permissionSelection.catalogueFingerprint !== catalogue.fingerprint ||
        role.permissionKeys.length !== catalogue.permissionKeys.length ||
        role.permissionKeys.some((key, index) => key !== catalogue.permissionKeys[index])),
  );
  if (invalid)
    throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID");
};

const requireUniqueOwnership = (entries: readonly PermissionRegistryEntryCandidate[]): void => {
  const identities = new Set<string>();
  const keys = new Set<string>();
  for (const entry of entries) {
    const owner = `${entry.ownerKind}:${entry.ownerId}`;
    const identity = `${owner}:${entry.permission.permissionId}`;
    const key = `${owner}:${entry.permission.key}`;
    if (identities.has(identity) || keys.has(key))
      throw new PermissionRegistryPreparationError(
        "PERMISSION_REGISTRY_PERMISSION_OWNERSHIP_AMBIGUOUS",
      );
    identities.add(identity);
    keys.add(key);
  }
};

export const verifyPreparedApplicationPermissionRegistration = (
  candidateValue: unknown,
): PreparedApplicationPermissionRegistration => {
  const parsed = preparedApplicationPermissionRegistrationSchema.safeParse(candidateValue);
  if (!parsed.success)
    throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID");
  const candidate = parsed.data;
  const orderedEntries = [...candidate.entries].sort((left, right) =>
    compareCanonicalStrings(entrySubject(left), entrySubject(right)),
  );
  if (
    orderedEntries.some((entry, index) => entry !== candidate.entries[index]) ||
    candidate.entries.some(
      (entry) =>
        entry.meaningFingerprint !==
        fingerprintPermissionMeaning(entry.ownerKind, entry.ownerId, entry.permission),
    )
  )
    throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID");

  const applicationEntries = candidate.entries
    .filter((entry) => entry.ownerKind === "application")
    .sort((left, right) => compareCanonicalStrings(left.permission.key, right.permission.key));
  if (
    applicationEntries.some(
      (entry) => canonicalJson(entry.sourceRelease) !== canonicalJson(candidate.applicationRelease),
    )
  )
    throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID");
  const catalogue = applicationCatalogue(applicationEntries.map((entry) => entry.permission));
  if (
    catalogue.fingerprint !== candidate.applicationCatalogueFingerprint ||
    catalogue.permissionIds.length !== candidate.applicationPermissionIds.length ||
    catalogue.permissionIds.some(
      (permissionId, index) => permissionId !== candidate.applicationPermissionIds[index],
    )
  )
    throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID");

  const moduleReleaseByOwner = new Map<string, string>();
  for (const entry of candidate.entries.filter((item) => item.ownerKind === "module")) {
    const release = canonicalJson(entry.sourceRelease);
    const prior = moduleReleaseByOwner.get(entry.ownerId);
    if (prior !== undefined && prior !== release)
      throw new PermissionRegistryPreparationError(
        "PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID",
      );
    moduleReleaseByOwner.set(entry.ownerId, release);
  }

  const { candidateFingerprint, ...candidateCore } = candidate;
  if (candidateFingerprint !== fingerprintCanonicalValue(candidateCore))
    throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID");
  return candidate;
};

export const prepareApplicationPermissionRegistrationFromReleaseSet = (
  contextCandidate: SessionContext,
  commandCandidate: PrepareApplicationPermissionRegistrationCommand,
  releaseSetCandidate: unknown,
): PreparedApplicationPermissionRegistration => {
  const context = sessionContextSchema.safeParse(contextCandidate);
  if (!context.success || !isLiveSystemContext(context.data))
    throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_CONTEXT_REFUSED");
  const applicationRootId = applicationRootIdSchema.safeParse(commandCandidate?.applicationRootId);
  const releaseRevision = revisionSchema
    .max(Number.MAX_SAFE_INTEGER)
    .safeParse(commandCandidate?.releaseRevision);
  if (!applicationRootId.success || !releaseRevision.success)
    throw new PermissionRegistryPreparationError("INVALID_PERMISSION_REGISTRY_PREPARATION_COMMAND");

  const releaseSet = systemApplicationBoundReleaseSetResultSchema.safeParse(releaseSetCandidate);
  if (!releaseSet.success)
    throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID");
  const application = releaseSet.data.application;
  if (
    application.organizationId !== context.data.organizationId ||
    application.correlationId !== context.data.correlationId ||
    application.rootId !== applicationRootId.data ||
    application.releaseRevision !== releaseRevision.data ||
    releaseSet.data.modules.some((module) => module.correlationId !== application.correlationId)
  )
    throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID");

  const catalogue = applicationCatalogue(application.content.permissions);
  validateApplicationWildcardEvidence(application, catalogue);
  const entries = [
    ...entriesFor(application.rootId, application),
    ...releaseSet.data.modules.flatMap((module) => entriesFor(application.rootId, module)),
  ].sort((left, right) => compareCanonicalStrings(entrySubject(left), entrySubject(right)));
  requireUniqueOwnership(entries);

  const candidate = {
    contractVersion: "1.0.0" as const,
    organizationId: context.data.organizationId,
    applicationRootId: application.rootId,
    applicationRelease: releaseEvidence(application) as Extract<
      PermissionRegistryDefinitionRelease,
      { kind: "application" }
    >,
    applicationCatalogueFingerprint: catalogue.fingerprint,
    applicationPermissionIds: catalogue.permissionIds,
    entries,
  };
  return verifyPreparedApplicationPermissionRegistration({
    ...candidate,
    candidateFingerprint: fingerprintCanonicalValue(candidate),
  });
};

export const createPermissionRegistryDefinitionAdapter = (
  reader: PermissionRegistryDefinitionSetReader,
) => ({
  async prepareApplicationRegistration(
    contextCandidate: SessionContext,
    commandCandidate: PrepareApplicationPermissionRegistrationCommand,
  ): Promise<PreparedApplicationPermissionRegistration> {
    const context = sessionContextSchema.safeParse(contextCandidate);
    const applicationRootId = applicationRootIdSchema.safeParse(
      commandCandidate?.applicationRootId,
    );
    const releaseRevision = revisionSchema
      .max(Number.MAX_SAFE_INTEGER)
      .safeParse(commandCandidate?.releaseRevision);
    if (!context.success || !isLiveSystemContext(context.data))
      throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_CONTEXT_REFUSED");
    if (!applicationRootId.success || !releaseRevision.success)
      throw new PermissionRegistryPreparationError(
        "INVALID_PERMISSION_REGISTRY_PREPARATION_COMMAND",
      );
    let releaseSet: SystemApplicationBoundReleaseSetResult;
    try {
      releaseSet = await reader.read(context.data, {
        applicationRootId: applicationRootId.data,
        applicationReleaseRevision: releaseRevision.data,
      });
    } catch {
      throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_DEFINITION_UNAVAILABLE");
    }
    return prepareApplicationPermissionRegistrationFromReleaseSet(
      context.data,
      commandCandidate,
      releaseSet,
    );
  },
});
