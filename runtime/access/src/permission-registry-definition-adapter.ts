import "server-only";

import {
  applicationRootIdSchema,
  definitionConsumerReadResultSchema,
  permissionRegistryDefinitionReleaseSchema,
  platformIdSchema,
  preparedApplicationPermissionRegistrationSchema,
  revisionSchema,
  sessionContextSchema,
  type DefinitionConsumerReadCommand,
  type DefinitionConsumerReadResult,
  type ApplicationRootId,
  type PermissionDeclaration,
  type PermissionRegistryDefinitionRelease,
  type PermissionRegistryEntryCandidate,
  type PreparedApplicationPermissionRegistration,
  type SessionContext,
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

export interface PermissionRegistryDefinitionReader {
  read(
    context: SessionContext,
    command: DefinitionConsumerReadCommand,
  ): Promise<DefinitionConsumerReadResult>;
}

/** Fixed I/O concurrency, not a product or catalogue-size limit. */
export const permissionRegistryModuleReadConcurrency = 16;

/** @internal Exported from this module only so the no-cap/concurrency contract is testable. */
export const mapInDeterministicBatches = async <Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> => {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new TypeError("Permission registry concurrency must be a positive safe integer");
  const output: Output[] = [];
  for (let start = 0; start < values.length; start += concurrency) {
    const batch = values.slice(start, start + concurrency);
    const settled = await Promise.allSettled(
      batch.map((value, batchIndex) => map(value, start + batchIndex)),
    );
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      output.push(result.value);
    }
  }
  return output;
};

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

const exactRead = async (
  reader: PermissionRegistryDefinitionReader,
  context: SessionContext,
  command: DefinitionConsumerReadCommand,
): Promise<DefinitionConsumerReadResult> => {
  let candidate: unknown;
  try {
    candidate = await reader.read(context, command);
  } catch {
    throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_DEFINITION_UNAVAILABLE");
  }
  const parsed = definitionConsumerReadResultSchema.safeParse(candidate);
  if (!parsed.success)
    throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID");
  return parsed.data;
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

export const createPermissionRegistryDefinitionAdapter = (
  reader: PermissionRegistryDefinitionReader,
) => ({
  async prepareApplicationRegistration(
    contextCandidate: SessionContext,
    commandCandidate: PrepareApplicationPermissionRegistrationCommand,
  ): Promise<PreparedApplicationPermissionRegistration> {
    const context = sessionContextSchema.safeParse(contextCandidate);
    if (!context.success || !isLiveSystemContext(context.data))
      throw new PermissionRegistryPreparationError("PERMISSION_REGISTRY_CONTEXT_REFUSED");
    const applicationRootId = applicationRootIdSchema.safeParse(
      commandCandidate?.applicationRootId,
    );
    const releaseRevision = revisionSchema
      .max(Number.MAX_SAFE_INTEGER)
      .safeParse(commandCandidate?.releaseRevision);
    if (!applicationRootId.success || !releaseRevision.success)
      throw new PermissionRegistryPreparationError(
        "INVALID_PERMISSION_REGISTRY_PREPARATION_COMMAND",
      );

    const applicationCandidate = await exactRead(reader, context.data, {
      kind: "application",
      rootId: applicationRootId.data,
      selector: { selection: "revision", releaseRevision: releaseRevision.data },
    });
    if (
      applicationCandidate.kind !== "application" ||
      applicationCandidate.organizationId !== context.data.organizationId ||
      applicationCandidate.correlationId !== context.data.correlationId ||
      applicationCandidate.rootId !== applicationRootId.data ||
      applicationCandidate.releaseRevision !== releaseRevision.data
    )
      throw new PermissionRegistryPreparationError(
        "PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID",
      );

    const moduleBindings = applicationCandidate.content.moduleBindings;
    const moduleDependencies = applicationCandidate.dependencyManifest.filter(
      (entry) => entry.kind === "module",
    );
    if (
      new Set(moduleBindings.map((binding) => binding.moduleRootId)).size !==
        moduleBindings.length ||
      new Set(moduleDependencies.map((dependency) => dependency.rootId)).size !==
        moduleDependencies.length ||
      moduleBindings.length !== moduleDependencies.length
    )
      throw new PermissionRegistryPreparationError(
        "PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID",
      );

    const modules = await mapInDeterministicBatches(
      moduleBindings,
      permissionRegistryModuleReadConcurrency,
      async (binding) => {
        const dependency = moduleDependencies.find(
          (candidate) => candidate.rootId === binding.moduleRootId,
        );
        if (!dependency || dependency.releaseVersion !== binding.resolvedVersion)
          throw new PermissionRegistryPreparationError(
            "PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID",
          );
        const moduleCandidate = await exactRead(reader, context.data, {
          kind: "module",
          rootId: dependency.rootId,
          selector: {
            selection: "revision",
            releaseRevision: dependency.releaseRevision,
          },
        });
        if (
          moduleCandidate.kind !== "module" ||
          moduleCandidate.organizationId !== context.data.organizationId ||
          moduleCandidate.correlationId !== context.data.correlationId ||
          moduleCandidate.rootId !== dependency.rootId ||
          moduleCandidate.definitionKey !== dependency.key ||
          moduleCandidate.releaseRevision !== dependency.releaseRevision ||
          moduleCandidate.releaseVersion !== dependency.releaseVersion ||
          moduleCandidate.contentFingerprint !== dependency.contentFingerprint ||
          moduleCandidate.resolutionFingerprint !== dependency.resolutionFingerprint
        )
          throw new PermissionRegistryPreparationError(
            "PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID",
          );
        return moduleCandidate;
      },
    );

    const catalogue = applicationCatalogue(applicationCandidate.content.permissions);
    validateApplicationWildcardEvidence(applicationCandidate, catalogue);
    const entries = [
      ...entriesFor(applicationCandidate.rootId, applicationCandidate),
      ...modules.flatMap((moduleRelease) => entriesFor(applicationCandidate.rootId, moduleRelease)),
    ].sort((left, right) => compareCanonicalStrings(entrySubject(left), entrySubject(right)));
    requireUniqueOwnership(entries);

    const candidate = {
      contractVersion: "1.0.0" as const,
      organizationId: context.data.organizationId,
      applicationRootId: applicationCandidate.rootId,
      applicationRelease: releaseEvidence(applicationCandidate) as Extract<
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
  },
});
