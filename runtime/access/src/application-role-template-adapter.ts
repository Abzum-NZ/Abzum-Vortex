import "server-only";

import {
  applicationRootIdSchema,
  definitionConsumerReadResultSchema,
  preparedApplicationRoleTemplatesSchema,
  projectLiveApplicationRolePermissions,
  revisionSchema,
  sessionContextSchema,
  type ApplicationPermissionCatalogueSnapshot,
  type ApplicationRole,
  type ApplicationRoleTemplatePreparationBasis,
  type ApplicationRootId,
  type DefinitionConsumerReadResult,
  type PermissionCatalogueLookupResult,
  type PermissionRegistryEntryCandidate,
  type PreparedApplicationPermissionRegistration,
  type PreparedApplicationRoleTemplate,
  type PreparedApplicationRoleTemplates,
  type SessionContext,
} from "@vortex/contracts";
import { canonicalJson, fingerprintCanonicalValue } from "@vortex/definition";
import {
  createPermissionRegistryDefinitionAdapter,
  mapInDeterministicBatches,
  permissionRegistryModuleReadConcurrency,
  PermissionRegistryPreparationError,
  verifyPreparedApplicationPermissionRegistration,
  type PermissionRegistryDefinitionReader,
} from "./permission-registry-definition-adapter";
import type { PermissionRegistryPrivateRepository } from "./permission-registry-repository";
import { isLiveSystemContext } from "./private-system-context";

export const applicationRoleTemplatePreparationErrorCodes = [
  "INVALID_APPLICATION_ROLE_TEMPLATE_PREPARATION_COMMAND",
  "APPLICATION_ROLE_TEMPLATE_CONTEXT_REFUSED",
  "APPLICATION_ROLE_TEMPLATE_DEFINITION_UNAVAILABLE",
  "APPLICATION_ROLE_TEMPLATE_DEFINITION_EVIDENCE_INVALID",
  "APPLICATION_ROLE_TEMPLATE_PERMISSION_OWNERSHIP_AMBIGUOUS",
  "APPLICATION_ROLE_TEMPLATE_ACTIVE_REGISTRATION_UNAVAILABLE",
] as const;

export type ApplicationRoleTemplatePreparationErrorCode =
  (typeof applicationRoleTemplatePreparationErrorCodes)[number];

export class ApplicationRoleTemplatePreparationError extends Error {
  readonly code: ApplicationRoleTemplatePreparationErrorCode;

  constructor(code: ApplicationRoleTemplatePreparationErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "ApplicationRoleTemplatePreparationError";
    this.code = code;
  }
}

export type PrepareApplicationRoleRegistrationCandidateCommand = Readonly<{
  applicationRootId: ApplicationRootId;
  releaseRevision: number;
}>;

export type PrepareCurrentApplicationRoleTemplatesCommand = Readonly<{
  applicationRootId: ApplicationRootId;
}>;

export interface ApplicationRoleTemplateAdapterDependencies {
  readonly definitionReader: PermissionRegistryDefinitionReader;
  readonly permissionRegistryFacts: Pick<
    PermissionRegistryPrivateRepository,
    "lookup" | "readApplicationSnapshot"
  >;
}

type ApplicationDefinitionRead = Extract<DefinitionConsumerReadResult, { kind: "application" }>;

const evidenceError = (cause?: unknown) =>
  new ApplicationRoleTemplatePreparationError(
    "APPLICATION_ROLE_TEMPLATE_DEFINITION_EVIDENCE_INVALID",
    cause === undefined ? undefined : { cause },
  );

const parseContext = (candidate: SessionContext): SessionContext => {
  const parsed = sessionContextSchema.safeParse(candidate);
  if (!parsed.success || !isLiveSystemContext(parsed.data))
    throw new ApplicationRoleTemplatePreparationError("APPLICATION_ROLE_TEMPLATE_CONTEXT_REFUSED");
  return parsed.data;
};

const parseApplicationRootId = (candidate: unknown): ApplicationRootId => {
  const parsed = applicationRootIdSchema.safeParse(candidate);
  if (!parsed.success)
    throw new ApplicationRoleTemplatePreparationError(
      "INVALID_APPLICATION_ROLE_TEMPLATE_PREPARATION_COMMAND",
    );
  return parsed.data;
};

const mapPermissionPreparationError = (error: unknown): never => {
  if (!(error instanceof PermissionRegistryPreparationError)) throw evidenceError(error);
  switch (error.code) {
    case "INVALID_PERMISSION_REGISTRY_PREPARATION_COMMAND":
      throw new ApplicationRoleTemplatePreparationError(
        "INVALID_APPLICATION_ROLE_TEMPLATE_PREPARATION_COMMAND",
        { cause: error },
      );
    case "PERMISSION_REGISTRY_CONTEXT_REFUSED":
      throw new ApplicationRoleTemplatePreparationError(
        "APPLICATION_ROLE_TEMPLATE_CONTEXT_REFUSED",
        { cause: error },
      );
    case "PERMISSION_REGISTRY_DEFINITION_UNAVAILABLE":
      throw new ApplicationRoleTemplatePreparationError(
        "APPLICATION_ROLE_TEMPLATE_DEFINITION_UNAVAILABLE",
        { cause: error },
      );
    case "PERMISSION_REGISTRY_PERMISSION_OWNERSHIP_AMBIGUOUS":
      throw new ApplicationRoleTemplatePreparationError(
        "APPLICATION_ROLE_TEMPLATE_PERMISSION_OWNERSHIP_AMBIGUOUS",
        { cause: error },
      );
    case "PERMISSION_REGISTRY_DEFINITION_EVIDENCE_INVALID":
      throw evidenceError(error);
  }
};

const readExactApplication = async (
  reader: PermissionRegistryDefinitionReader,
  context: SessionContext,
  registration: PreparedApplicationPermissionRegistration,
): Promise<ApplicationDefinitionRead> => {
  let candidate: unknown;
  try {
    candidate = await reader.read(context, {
      kind: "application",
      rootId: registration.applicationRootId,
      selector: {
        selection: "revision",
        releaseRevision: registration.applicationRelease.releaseRevision,
      },
    });
  } catch (error) {
    throw new ApplicationRoleTemplatePreparationError(
      "APPLICATION_ROLE_TEMPLATE_DEFINITION_UNAVAILABLE",
      { cause: error },
    );
  }
  const parsed = definitionConsumerReadResultSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.kind !== "application" ||
    parsed.data.organizationId !== context.organizationId ||
    parsed.data.correlationId !== context.correlationId ||
    parsed.data.rootId !== registration.applicationRootId
  )
    throw evidenceError();
  const release = {
    kind: parsed.data.kind,
    definitionKey: parsed.data.definitionKey,
    rootId: parsed.data.rootId,
    releaseRevision: parsed.data.releaseRevision,
    releaseVersion: parsed.data.releaseVersion,
    validationContractVersion: parsed.data.validationContractVersion,
    contentFingerprint: parsed.data.contentFingerprint,
    resolutionFingerprint: parsed.data.resolutionFingerprint,
  };
  if (canonicalJson(release) !== canonicalJson(registration.applicationRelease))
    throw evidenceError();
  return parsed.data;
};

const candidateEvidenceKey = (candidate: PermissionRegistryEntryCandidate): string =>
  canonicalJson(candidate);

const resolveTemplate = (
  template: ApplicationRole,
  registration: PreparedApplicationPermissionRegistration,
): PreparedApplicationRoleTemplate => {
  const wildcard = template.permissionSelection.kind === "application_wildcard";
  const sourcePermissions = template.permissionKeys.map((key) => {
    const matches = registration.entries.filter((entry) => {
      if (entry.permission.key !== key) return false;
      if (!wildcard) return true;
      return (
        entry.ownerKind === "application" &&
        entry.applicationRootId === registration.applicationRootId &&
        String(entry.ownerId) === String(registration.applicationRootId) &&
        registration.applicationPermissionIds.includes(entry.permission.permissionId)
      );
    });
    if (matches.length !== 1)
      throw new ApplicationRoleTemplatePreparationError(
        "APPLICATION_ROLE_TEMPLATE_PERMISSION_OWNERSHIP_AMBIGUOUS",
      );
    return matches[0]!;
  });
  return {
    template,
    sourceTemplateFingerprint: fingerprintCanonicalValue(template),
    sourcePermissions,
    livePermissions: [
      ...projectLiveApplicationRolePermissions(
        template.permissionSelection,
        registration.applicationRootId,
        sourcePermissions,
      ),
    ],
  };
};

const buildCandidate = (
  basis: ApplicationRoleTemplatePreparationBasis,
  registrationValue: PreparedApplicationPermissionRegistration,
  application: ApplicationDefinitionRead,
): PreparedApplicationRoleTemplates => {
  let permissionRegistration: PreparedApplicationPermissionRegistration;
  try {
    permissionRegistration = verifyPreparedApplicationPermissionRegistration(registrationValue);
  } catch (error) {
    throw evidenceError(error);
  }
  const core = {
    contractVersion: "1.0.0" as const,
    preparationBasis: basis,
    permissionRegistration,
    templates: application.content.roles.map((template) =>
      resolveTemplate(template, permissionRegistration),
    ),
  };
  return verifyPreparedApplicationRoleTemplates({
    ...core,
    candidateFingerprint: fingerprintCanonicalValue(core),
  });
};

export const verifyPreparedApplicationRoleTemplates = (
  candidateValue: unknown,
): PreparedApplicationRoleTemplates => {
  const parsed = preparedApplicationRoleTemplatesSchema.safeParse(candidateValue);
  if (!parsed.success) throw evidenceError(parsed.error);
  const candidate = parsed.data;
  try {
    verifyPreparedApplicationPermissionRegistration(candidate.permissionRegistration);
  } catch (error) {
    throw evidenceError(error);
  }
  if (
    candidate.templates.some(
      (prepared) =>
        prepared.sourceTemplateFingerprint !== fingerprintCanonicalValue(prepared.template),
    )
  )
    throw evidenceError();
  const { candidateFingerprint, ...core } = candidate;
  if (candidateFingerprint !== fingerprintCanonicalValue(core)) throw evidenceError();
  return candidate;
};

const registrationMatchesSnapshot = (
  registration: PreparedApplicationPermissionRegistration,
  snapshot: ApplicationPermissionCatalogueSnapshot | undefined,
): snapshot is NonNullable<typeof snapshot> =>
  snapshot !== undefined &&
  snapshot.organizationId === registration.organizationId &&
  snapshot.applicationRootId === registration.applicationRootId &&
  canonicalJson(snapshot.applicationRelease) === canonicalJson(registration.applicationRelease) &&
  snapshot.catalogueFingerprint === registration.applicationCatalogueFingerprint &&
  canonicalJson(snapshot.permissionIds) === canonicalJson(registration.applicationPermissionIds);

const uniqueSourcePermissions = (
  candidate: PreparedApplicationRoleTemplates,
): PermissionRegistryEntryCandidate[] => {
  const unique = new Map<string, PermissionRegistryEntryCandidate>();
  for (const prepared of candidate.templates)
    for (const permission of prepared.sourcePermissions) {
      const identity = `${permission.applicationRootId}:${permission.ownerKind}:${permission.ownerId}:${permission.permission.permissionId}`;
      if (!unique.has(identity)) unique.set(identity, permission);
    }
  return [...unique.values()];
};

/** Fixed I/O concurrency, not an application permission or template limit. */
export const applicationRoleTemplateFactReadConcurrency = permissionRegistryModuleReadConcurrency;

export const createApplicationRoleTemplateAdapter = (
  dependencies: ApplicationRoleTemplateAdapterDependencies,
) => {
  const definitionAdapter = createPermissionRegistryDefinitionAdapter(
    dependencies.definitionReader,
  );

  const prepareDefinitionEvidence = async (
    context: SessionContext,
    applicationRootId: ApplicationRootId,
    releaseRevision: number,
  ) => {
    const permissionRegistration = await definitionAdapter
      .prepareApplicationRegistration(context, { applicationRootId, releaseRevision })
      .catch(mapPermissionPreparationError);
    const application = await readExactApplication(
      dependencies.definitionReader,
      context,
      permissionRegistration,
    );
    return { permissionRegistration, application };
  };

  return Object.freeze({
    async prepareRegistrationCandidate(
      contextCandidate: SessionContext,
      commandCandidate: PrepareApplicationRoleRegistrationCandidateCommand,
    ): Promise<PreparedApplicationRoleTemplates> {
      const context = parseContext(contextCandidate);
      const applicationRootId = parseApplicationRootId(commandCandidate?.applicationRootId);
      const releaseRevision = revisionSchema
        .max(Number.MAX_SAFE_INTEGER)
        .safeParse(commandCandidate?.releaseRevision);
      if (!releaseRevision.success)
        throw new ApplicationRoleTemplatePreparationError(
          "INVALID_APPLICATION_ROLE_TEMPLATE_PREPARATION_COMMAND",
        );
      const evidence = await prepareDefinitionEvidence(
        context,
        applicationRootId,
        releaseRevision.data,
      );
      return buildCandidate(
        { kind: "registration_candidate" },
        evidence.permissionRegistration,
        evidence.application,
      );
    },

    async prepareCurrentActive(
      contextCandidate: SessionContext,
      commandCandidate: PrepareCurrentApplicationRoleTemplatesCommand,
    ): Promise<PreparedApplicationRoleTemplates> {
      const context = parseContext(contextCandidate);
      const applicationRootId = parseApplicationRootId(commandCandidate?.applicationRootId);
      let initialSnapshot: ApplicationPermissionCatalogueSnapshot | undefined;
      try {
        initialSnapshot = await dependencies.permissionRegistryFacts.readApplicationSnapshot({
          organizationId: context.organizationId,
          applicationRootId,
        });
      } catch (error) {
        throw new ApplicationRoleTemplatePreparationError(
          "APPLICATION_ROLE_TEMPLATE_ACTIVE_REGISTRATION_UNAVAILABLE",
          { cause: error },
        );
      }
      if (initialSnapshot === undefined)
        throw new ApplicationRoleTemplatePreparationError(
          "APPLICATION_ROLE_TEMPLATE_ACTIVE_REGISTRATION_UNAVAILABLE",
        );

      const evidence = await prepareDefinitionEvidence(
        context,
        applicationRootId,
        initialSnapshot.applicationRelease.releaseRevision,
      );
      if (!registrationMatchesSnapshot(evidence.permissionRegistration, initialSnapshot))
        throw evidenceError();
      const candidate = buildCandidate(
        {
          kind: "current_active_registration",
          registrationRevision: initialSnapshot.registrationRevision,
        },
        evidence.permissionRegistration,
        evidence.application,
      );

      await mapInDeterministicBatches(
        uniqueSourcePermissions(candidate),
        applicationRoleTemplateFactReadConcurrency,
        async (permission) => {
          let result: PermissionCatalogueLookupResult;
          try {
            result = await dependencies.permissionRegistryFacts.lookup({
              organizationId: context.organizationId,
              applicationRootId: permission.applicationRootId,
              ownerKind: permission.ownerKind,
              ownerId: permission.ownerId,
              permissionId: permission.permission.permissionId,
            });
          } catch (error) {
            throw new ApplicationRoleTemplatePreparationError(
              "APPLICATION_ROLE_TEMPLATE_ACTIVE_REGISTRATION_UNAVAILABLE",
              { cause: error },
            );
          }
          if (
            result.outcome !== "available" ||
            result.entry.organizationId !== context.organizationId ||
            result.entry.registrationRevision !== initialSnapshot.registrationRevision ||
            result.entry.applicationRootId === undefined ||
            result.entry.ownerKind === "platform" ||
            result.entry.sourceRelease.kind === "platform_catalogue" ||
            candidateEvidenceKey({
              applicationRootId: result.entry.applicationRootId,
              ownerKind: result.entry.ownerKind,
              ownerId: result.entry.ownerId,
              permission: result.entry.permission,
              sourceRelease: result.entry.sourceRelease,
              meaningFingerprint: result.entry.meaningFingerprint,
            }) !== candidateEvidenceKey(permission)
          )
            throw new ApplicationRoleTemplatePreparationError(
              "APPLICATION_ROLE_TEMPLATE_ACTIVE_REGISTRATION_UNAVAILABLE",
            );
        },
      );

      let finalSnapshot: ApplicationPermissionCatalogueSnapshot | undefined;
      try {
        finalSnapshot = await dependencies.permissionRegistryFacts.readApplicationSnapshot({
          organizationId: context.organizationId,
          applicationRootId,
        });
      } catch (error) {
        throw new ApplicationRoleTemplatePreparationError(
          "APPLICATION_ROLE_TEMPLATE_ACTIVE_REGISTRATION_UNAVAILABLE",
          { cause: error },
        );
      }
      if (
        finalSnapshot === undefined ||
        canonicalJson(finalSnapshot) !== canonicalJson(initialSnapshot)
      )
        throw new ApplicationRoleTemplatePreparationError(
          "APPLICATION_ROLE_TEMPLATE_ACTIVE_REGISTRATION_UNAVAILABLE",
        );
      return candidate;
    },
  });
};
