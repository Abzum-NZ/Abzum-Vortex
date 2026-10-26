import "server-only";

import {
  applicationRootIdSchema,
  revisionSchema,
  type ApplicationRootId,
} from "../catalogue/identifiers";
import type { ApplicationRole } from "../definition/application-contracts";
import {
  systemApplicationBoundReleaseSetResultSchema,
  type DefinitionConsumerReadResult,
} from "../definition/definition-consumer-read";
import { sessionContextSchema, type SessionContext } from "./identity-access";
import {
  preparedApplicationRoleTemplatesSchema,
  projectLiveApplicationRolePermissions,
  type ApplicationRoleTemplatePreparationBasis,
  type PreparedApplicationRoleTemplate,
  type PreparedApplicationRoleTemplates,
} from "./organization-access-catalogue";
import type { PreparedApplicationPermissionRegistration } from "./permission-registry";
import {
  PermissionRegistryPreparationError,
  prepareApplicationPermissionRegistrationForHumanRequest,
  prepareApplicationPermissionRegistrationFromReleaseSet,
  verifyPreparedApplicationPermissionRegistration,
  type PermissionRegistryDefinitionSetReader,
} from "./permission-registry-definition-adapter";
import { isLiveSystemContext } from "./private-system-context";

export const applicationRoleTemplatePreparationErrorCodes = [
  "INVALID_APPLICATION_ROLE_TEMPLATE_PREPARATION_COMMAND",
  "APPLICATION_ROLE_TEMPLATE_CONTEXT_REFUSED",
  "APPLICATION_ROLE_TEMPLATE_DEFINITION_UNAVAILABLE",
  "APPLICATION_ROLE_TEMPLATE_DEFINITION_EVIDENCE_INVALID",
  "APPLICATION_ROLE_TEMPLATE_PERMISSION_OWNERSHIP_AMBIGUOUS",
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

export interface ApplicationRoleTemplateAdapterDependencies {
  readonly definitionReader: PermissionRegistryDefinitionSetReader;
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
  return verifyPreparedApplicationRoleTemplates({
    contractVersion: "1.0.0" as const,
    preparationBasis: basis,
    permissionRegistration,
    templates: application.content.roles.map((template) =>
      resolveTemplate(template, permissionRegistration),
    ),
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
  return candidate;
};

/**
 * Prepares one exact release's role templates from a release set read under the verified human
 * request's own organisation scope. It mirrors {@link createApplicationRoleTemplateAdapter}'s
 * registration candidate exactly, but the registration basis is the human request rather than a
 * system context: it grants nothing, and the protected Access writer still re-verifies every
 * fingerprint and continuity revision before any registration changes.
 */
export const prepareApplicationRoleTemplatesForHumanRequest = (
  organizationId: string,
  commandCandidate: PrepareApplicationRoleRegistrationCandidateCommand,
  releaseSetCandidate: unknown,
): PreparedApplicationRoleTemplates => {
  const applicationRootId = parseApplicationRootId(commandCandidate?.applicationRootId);
  const releaseRevision = revisionSchema
    .max(Number.MAX_SAFE_INTEGER)
    .safeParse(commandCandidate?.releaseRevision);
  if (!releaseRevision.success)
    throw new ApplicationRoleTemplatePreparationError(
      "INVALID_APPLICATION_ROLE_TEMPLATE_PREPARATION_COMMAND",
    );
  const releaseSet = systemApplicationBoundReleaseSetResultSchema.safeParse(releaseSetCandidate);
  if (!releaseSet.success) throw evidenceError();

  const permissionRegistration = (() => {
    try {
      return prepareApplicationPermissionRegistrationForHumanRequest(
        organizationId,
        { applicationRootId, releaseRevision: releaseRevision.data },
        releaseSet.data,
      );
    } catch (error) {
      return mapPermissionPreparationError(error);
    }
  })();
  return buildCandidate(
    { kind: "registration_candidate" },
    permissionRegistration,
    releaseSet.data.application as ApplicationDefinitionRead,
  );
};

export const createApplicationRoleTemplateAdapter = (
  dependencies: ApplicationRoleTemplateAdapterDependencies,
) => {
  const prepareDefinitionEvidence = async (
    context: SessionContext,
    applicationRootId: ApplicationRootId,
    releaseRevision: number,
  ) => {
    let releaseSet;
    try {
      releaseSet = await dependencies.definitionReader.read(context, {
        applicationRootId,
        applicationReleaseRevision: releaseRevision,
      });
    } catch (error) {
      throw new ApplicationRoleTemplatePreparationError(
        "APPLICATION_ROLE_TEMPLATE_DEFINITION_UNAVAILABLE",
        { cause: error },
      );
    }
    const permissionRegistration = (() => {
      try {
        return prepareApplicationPermissionRegistrationFromReleaseSet(
          context,
          { applicationRootId, releaseRevision },
          releaseSet,
        );
      } catch (error) {
        return mapPermissionPreparationError(error);
      }
    })();
    const application = releaseSet.application as ApplicationDefinitionRead;
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
  });
};
