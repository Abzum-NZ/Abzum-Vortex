import "server-only";

import {
  organizationRoleChangeCommandSchema,
  organizationRoleChangeResultSchema,
  type OrganizationRoleChangeCommand,
  type OrganizationRoleChangeResult,
  type PreparedOrganizationRoleChange,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { canonicalJson } from "@vortex/definition";
import { verifyPreparedOrganizationRoleChangeEvidence } from "../src/organization-role-change-evidence";

export const organizationRoleChangeHandoffErrorCodes = [
  "INVALID_ORGANIZATION_ROLE_CHANGE_COMMAND",
  "INVALID_ORGANIZATION_ROLE_CHANGE_STORAGE_RESULT",
  "ORGANIZATION_ROLE_CHANGE_SCOPE_UNAVAILABLE",
  "ORGANIZATION_ROLE_CHANGE_STALE_OR_UNAVAILABLE",
  "ORGANIZATION_ROLE_CHANGE_VERSION_EXHAUSTED",
  "ORGANIZATION_ROLE_CHANGE_FAILED",
] as const;

export type OrganizationRoleChangeHandoffErrorCode =
  (typeof organizationRoleChangeHandoffErrorCodes)[number];

export class OrganizationRoleChangeHandoffError extends Error {
  readonly code: OrganizationRoleChangeHandoffErrorCode;

  constructor(code: OrganizationRoleChangeHandoffErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "OrganizationRoleChangeHandoffError";
    this.code = code;
  }
}

export interface OrganizationRoleChangeOwnerHandoff {
  change(command: OrganizationRoleChangeCommand): Promise<OrganizationRoleChangeResult>;
}

type ChangeRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  role: unknown;
  created_activation_policy: unknown;
  access_version: unknown;
  correlation_id: unknown;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const normalizedUuid = (value: string): string => value.toLowerCase();
const sameUuid = (left: string, right: string): boolean =>
  normalizedUuid(left) === normalizedUuid(right);
const optional = (value: unknown): unknown => (value === null ? undefined : value);
const equalCanonical = (left: unknown, right: unknown): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
};

const comparablePolicy = (
  policy:
    | { readonly kind: "standing" }
    | {
        readonly kind: "activation_required";
        readonly activationPolicy: {
          readonly activationPolicyId: string;
          readonly revision: number;
          readonly fingerprint: string;
        };
      },
) =>
  policy.kind === "standing"
    ? policy
    : {
        ...policy,
        activationPolicy: {
          ...policy.activationPolicy,
          activationPolicyId: normalizedUuid(policy.activationPolicy.activationPolicyId),
        },
      };

const comparablePermissions = <
  Permission extends {
    readonly applicationRootId?: string | undefined;
    readonly ownerId: string;
    readonly permissionId: string;
  },
>(
  permissions: readonly Permission[],
) =>
  permissions.map((permission) => ({
    ...permission,
    ...(permission.applicationRootId === undefined
      ? {}
      : { applicationRootId: normalizedUuid(permission.applicationRootId) }),
    ownerId: normalizedUuid(permission.ownerId),
    permissionId: normalizedUuid(permission.permissionId),
  }));

const comparableTemplateSource = <
  Source extends {
    readonly applicationRootId: string;
    readonly sourceRoleId: string;
    readonly sourceRelease: { readonly rootId: string };
  },
>(
  source: Source,
) => ({
  ...source,
  applicationRootId: normalizedUuid(source.applicationRootId),
  sourceRoleId: normalizedUuid(source.sourceRoleId),
  sourceRelease: {
    ...source.sourceRelease,
    rootId: normalizedUuid(source.sourceRelease.rootId),
  },
});

const invalidStorage = (): never => {
  throw new OrganizationRoleChangeHandoffError("INVALID_ORGANIZATION_ROLE_CHANGE_STORAGE_RESULT");
};

const expectedRevision = (evidence: PreparedOrganizationRoleChange): number => {
  const candidate = evidence.candidate;
  if (
    candidate.operation === "create_custom" ||
    candidate.operation === "create_custom_from_template" ||
    candidate.operation === "accept_new_application_role"
  )
    return 1;
  return candidate.expectedRoleRevision + 1;
};

const createsRole = (evidence: PreparedOrganizationRoleChange): boolean => {
  const operation = evidence.candidate.operation;
  return (
    operation === "create_custom" ||
    operation === "create_custom_from_template" ||
    operation === "accept_new_application_role"
  );
};

const newPolicy = (evidence: PreparedOrganizationRoleChange) => {
  const candidate = evidence.candidate;
  if (
    !("assignmentPolicy" in candidate) ||
    candidate.assignmentPolicy.kind !== "activation_required" ||
    candidate.assignmentPolicy.activationPolicy.selection !== "new"
  )
    return undefined;
  return candidate.assignmentPolicy.activationPolicy.policy;
};

const expectedStoredPolicy = (evidence: PreparedOrganizationRoleChange) => {
  const candidate = evidence.candidate;
  if (!("assignmentPolicy" in candidate)) return undefined;
  if (candidate.assignmentPolicy.kind === "standing") return candidate.assignmentPolicy;
  const selection = candidate.assignmentPolicy.activationPolicy;
  if (selection.selection === "existing")
    return { kind: "activation_required" as const, activationPolicy: selection.reference };
  if (evidence.newActivationPolicyFingerprint === undefined) return undefined;
  return {
    kind: "activation_required" as const,
    activationPolicy: {
      activationPolicyId: selection.policy.activationPolicyId,
      revision: selection.policy.revision,
      fingerprint: evidence.newActivationPolicyFingerprint,
    },
  };
};

const selectedTemplate = (evidence: PreparedOrganizationRoleChange) => {
  const candidate = evidence.candidate;
  if (!("preparedTemplates" in candidate)) return undefined;
  return candidate.preparedTemplates.templates.find((entry) =>
    sameUuid(entry.template.roleId, candidate.sourceRoleId),
  );
};

const expectedApplicationSource = (evidence: PreparedOrganizationRoleChange) => {
  const candidate = evidence.candidate;
  if (
    candidate.operation !== "accept_new_application_role" &&
    candidate.operation !== "accept_application_role_revision"
  )
    return undefined;
  const basis = candidate.preparedTemplates.preparationBasis;
  const template = selectedTemplate(evidence);
  if (
    basis.kind !== "current_active_registration" ||
    template === undefined ||
    evidence.acceptedGrantFingerprint === undefined
  )
    return undefined;
  const registration = candidate.preparedTemplates.permissionRegistration;
  return {
    applicationRootId: registration.applicationRootId,
    sourceRoleId: candidate.sourceRoleId,
    sourceRelease: registration.applicationRelease,
    sourceTemplateFingerprint: template.sourceTemplateFingerprint,
    sourceCatalogueFingerprint: registration.applicationCatalogueFingerprint,
    acceptedRegistrationRevision: basis.registrationRevision,
    templateContinuityRevision: candidate.templateContinuityRevision,
    acceptedGrantFingerprint: evidence.acceptedGrantFingerprint,
  };
};

const expectedCustomTemplateSource = (evidence: PreparedOrganizationRoleChange) => {
  const candidate = evidence.candidate;
  if (candidate.operation !== "create_custom_from_template") return undefined;
  const template = selectedTemplate(evidence);
  if (template === undefined) return undefined;
  const registration = candidate.preparedTemplates.permissionRegistration;
  return {
    applicationRootId: registration.applicationRootId,
    sourceRoleId: candidate.sourceRoleId,
    sourceRelease: registration.applicationRelease,
    sourceTemplateFingerprint: template.sourceTemplateFingerprint,
  };
};

const bindsConfiguration = (
  result: OrganizationRoleChangeResult,
  evidence: PreparedOrganizationRoleChange,
): boolean => {
  const candidate = evidence.candidate;
  if (!("assignmentPolicy" in candidate)) return true;
  return (
    result.role.key === candidate.key &&
    result.role.label === candidate.label &&
    result.role.description === candidate.description &&
    result.role.privilegeClassification === candidate.privilegeClassification &&
    equalCanonical(
      comparablePolicy(result.role.assignmentPolicy),
      comparablePolicy(expectedStoredPolicy(evidence)!),
    )
  );
};

const bindsBranchState = (
  result: OrganizationRoleChangeResult,
  evidence: PreparedOrganizationRoleChange,
): boolean => {
  const candidate = evidence.candidate;
  switch (candidate.operation) {
    case "create_custom":
      return (
        result.role.kind === "custom" &&
        result.role.lifecycle === "active" &&
        result.role.derivedFromTemplate === undefined &&
        equalCanonical(
          comparablePermissions(result.role.permissions),
          comparablePermissions(candidate.permissions),
        )
      );
    case "create_custom_from_template":
      return (
        result.role.kind === "custom" &&
        result.role.lifecycle === "active" &&
        result.role.derivedFromTemplate !== undefined &&
        expectedCustomTemplateSource(evidence) !== undefined &&
        equalCanonical(
          comparableTemplateSource(result.role.derivedFromTemplate),
          comparableTemplateSource(expectedCustomTemplateSource(evidence)!),
        ) &&
        equalCanonical(
          comparablePermissions(result.role.permissions),
          comparablePermissions(candidate.permissions),
        )
      );
    case "accept_new_application_role":
    case "accept_application_role_revision":
      return (
        result.role.kind === "application" &&
        result.role.lifecycle === "active" &&
        sameUuid(
          result.role.applicationRootId,
          candidate.preparedTemplates.permissionRegistration.applicationRootId,
        ) &&
        expectedApplicationSource(evidence) !== undefined &&
        equalCanonical(
          comparableTemplateSource(result.role.source),
          comparableTemplateSource(expectedApplicationSource(evidence)!),
        ) &&
        equalCanonical(
          comparablePermissions(result.role.permissions),
          comparablePermissions(candidate.permissions),
        )
      );
    case "revise_custom_permissions":
      return (
        result.role.kind === "custom" &&
        result.role.lifecycle === "active" &&
        equalCanonical(
          comparablePermissions(result.role.permissions),
          comparablePermissions(candidate.permissions),
        )
      );
    case "revise_metadata_policy":
      return true;
    case "retire_role":
      return result.role.lifecycle === "retired";
  }
};

const bindsCreatedPolicy = (
  result: OrganizationRoleChangeResult,
  command: OrganizationRoleChangeCommand,
): boolean => {
  const policy = newPolicy(command.evidence);
  if (policy === undefined) return result.createdActivationPolicy === undefined;
  const created = result.createdActivationPolicy;
  return (
    created !== undefined &&
    command.evidence.newActivationPolicyFingerprint !== undefined &&
    sameUuid(created.organizationId, command.evidence.candidate.organizationId) &&
    sameUuid(created.roleId, command.evidence.candidate.roleId) &&
    sameUuid(created.activationPolicyId, policy.activationPolicyId) &&
    created.revision === policy.revision &&
    created.fingerprint === command.evidence.newActivationPolicyFingerprint &&
    created.maximumActivationDurationSeconds === policy.maximumActivationDurationSeconds &&
    created.reasonRequired === policy.reasonRequired &&
    equalCanonical(created.recentAuthentication, policy.recentAuthentication) &&
    created.independentApprovalRequired === policy.independentApprovalRequired &&
    sameUuid(created.changedByActorId, command.changedBy) &&
    sameUuid(created.changeCorrelationId, command.correlationId)
  );
};

const parseResult = (
  rows: readonly ChangeRow[],
  command: OrganizationRoleChangeCommand,
): OrganizationRoleChangeResult => {
  if (rows.length !== 1 || rows[0] === undefined) return invalidStorage();
  const row = rows[0];
  const parsed = organizationRoleChangeResultSchema.safeParse({
    outcome: row.outcome,
    operation: row.operation,
    role: row.role,
    createdActivationPolicy: optional(row.created_activation_policy),
    accessVersion: revision(row.access_version),
    correlationId: row.correlation_id,
  });
  if (!parsed.success) return invalidStorage();

  if (
    parsed.data.operation !== command.evidence.candidate.operation ||
    !sameUuid(parsed.data.role.organizationId, command.evidence.candidate.organizationId) ||
    !sameUuid(parsed.data.role.roleId, command.evidence.candidate.roleId) ||
    parsed.data.role.liveRevision !== expectedRevision(command.evidence) ||
    !sameUuid(parsed.data.role.changedByActorId, command.changedBy) ||
    !sameUuid(parsed.data.role.changeCorrelationId, command.correlationId) ||
    !sameUuid(parsed.data.correlationId, command.correlationId) ||
    (createsRole(command.evidence) &&
      !sameUuid(parsed.data.role.createdByActorId, command.changedBy)) ||
    !bindsConfiguration(parsed.data, command.evidence) ||
    !bindsBranchState(parsed.data, command.evidence) ||
    !bindsCreatedPolicy(parsed.data, command)
  )
    return invalidStorage();

  return parsed.data;
};

const mapStorageFailure = (error: unknown): OrganizationRoleChangeHandoffError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  if (databaseCode === "22023")
    return new OrganizationRoleChangeHandoffError("INVALID_ORGANIZATION_ROLE_CHANGE_COMMAND");
  if (databaseCode === "42501")
    return new OrganizationRoleChangeHandoffError("ORGANIZATION_ROLE_CHANGE_SCOPE_UNAVAILABLE");
  if (databaseCode === "22003")
    return new OrganizationRoleChangeHandoffError("ORGANIZATION_ROLE_CHANGE_VERSION_EXHAUSTED");
  if (["23503", "23505", "23514", "40001", "55000"].includes(databaseCode ?? ""))
    return new OrganizationRoleChangeHandoffError("ORGANIZATION_ROLE_CHANGE_STALE_OR_UNAVAILABLE");
  return new OrganizationRoleChangeHandoffError("ORGANIZATION_ROLE_CHANGE_FAILED");
};

/**
 * Contract/result-binding proof for the owner-only role-change composition. It is
 * not callable by current runtime/request roles. D/#40 must provide the later
 * stewardship and caller-authority wrapper before any shipping adapter exists.
 */
export const createOrganizationRoleChangeOwnerHandoff = (
  transaction: RequestDatabaseTransaction,
): OrganizationRoleChangeOwnerHandoff =>
  Object.freeze({
    async change(commandCandidate: OrganizationRoleChangeCommand) {
      const parsed = organizationRoleChangeCommandSchema.safeParse(commandCandidate);
      if (!parsed.success)
        throw new OrganizationRoleChangeHandoffError("INVALID_ORGANIZATION_ROLE_CHANGE_COMMAND");

      let evidence: PreparedOrganizationRoleChange;
      try {
        evidence = verifyPreparedOrganizationRoleChangeEvidence(parsed.data.evidence);
      } catch (error) {
        throw new OrganizationRoleChangeHandoffError("INVALID_ORGANIZATION_ROLE_CHANGE_COMMAND", {
          cause: error,
        });
      }
      const command = { ...parsed.data, evidence };

      try {
        const rows = await transaction.query<ChangeRow>`
          select *
          from vortex_access.coordinate_organization_role_change(
            ${JSON.stringify(command.evidence)}::text::jsonb,
            ${command.changedBy}::uuid,
            ${command.correlationId}::uuid
          )
        `;
        return parseResult(rows, command);
      } catch (error) {
        if (error instanceof OrganizationRoleChangeHandoffError) throw error;
        throw mapStorageFailure(error);
      }
    },
  });
