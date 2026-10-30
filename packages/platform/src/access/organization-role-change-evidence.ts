import "server-only";

import type { AffectedRoleAssignment, RolePermissionEntry } from "./organization-access-catalogue";
import {
  organizationRoleChangePreparationSchema,
  preparedOrganizationRoleChangeSchema,
  type OrganizationRoleChangeCandidate,
  type OrganizationRoleChangePreparation,
  type OrganizationRolePolicyChoice,
  type PreparedOrganizationRoleChange,
} from "./organization-role-changes";
import { canonicalJson } from "../definition/canonical-json";

export const organizationRoleChangeEvidenceErrorCodes = [
  "INVALID_ORGANIZATION_ROLE_CHANGE_PREPARATION",
  "ORGANIZATION_ROLE_CHANGE_EVIDENCE_INVALID",
] as const;

export type OrganizationRoleChangeEvidenceErrorCode =
  (typeof organizationRoleChangeEvidenceErrorCodes)[number];

export class OrganizationRoleChangeEvidenceError extends Error {
  readonly code: OrganizationRoleChangeEvidenceErrorCode;

  constructor(code: OrganizationRoleChangeEvidenceErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "OrganizationRoleChangeEvidenceError";
    this.code = code;
  }
}

const normalizedUuid = <Value extends string>(value: Value): Value => value.toLowerCase() as Value;

const normalizePermission = (permission: RolePermissionEntry): RolePermissionEntry => ({
  ...permission,
  ...(permission.applicationRootId === undefined
    ? {}
    : { applicationRootId: normalizedUuid(permission.applicationRootId) }),
  ownerId: normalizedUuid(permission.ownerId),
  permissionId: normalizedUuid(permission.permissionId),
});

const permissionIdentity = (permission: RolePermissionEntry) =>
  [
    permission.applicationRootId,
    permission.ownerKind,
    permission.ownerId,
    permission.permissionId,
  ] as const;

const compareIdentity = (
  left: readonly (string | undefined)[],
  right: readonly (string | undefined)[],
): number => {
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === rightValue) continue;
    if (leftValue === undefined) return 1;
    if (rightValue === undefined) return -1;
    return leftValue < rightValue ? -1 : 1;
  }
  return 0;
};

const normalizePermissions = (permissions: readonly RolePermissionEntry[]): RolePermissionEntry[] =>
  permissions
    .map(normalizePermission)
    .sort((left, right) => compareIdentity(permissionIdentity(left), permissionIdentity(right)));

const normalizeAssignment = (assignment: AffectedRoleAssignment): AffectedRoleAssignment => ({
  ...assignment,
  roleAssignmentId: normalizedUuid(assignment.roleAssignmentId),
  assignee:
    assignment.assignee.kind === "organization_account"
      ? {
          kind: "organization_account",
          organizationAccountId: normalizedUuid(assignment.assignee.organizationAccountId),
        }
      : { kind: "group", groupId: normalizedUuid(assignment.assignee.groupId) },
});

const normalizePolicyChoice = (
  policy: OrganizationRolePolicyChoice,
): OrganizationRolePolicyChoice =>
  policy.kind === "standing"
    ? policy
    : policy.activationPolicy.selection === "existing"
      ? {
          kind: "activation_required",
          activationPolicy: {
            selection: "existing",
            reference: {
              ...policy.activationPolicy.reference,
              activationPolicyId: normalizedUuid(
                policy.activationPolicy.reference.activationPolicyId,
              ),
            },
          },
        }
      : {
          kind: "activation_required",
          activationPolicy: {
            selection: "new",
            policy: {
              ...policy.activationPolicy.policy,
              activationPolicyId: normalizedUuid(policy.activationPolicy.policy.activationPolicyId),
            },
          },
        };

const normalizeCandidate = (
  candidate: OrganizationRoleChangeCandidate,
): OrganizationRoleChangeCandidate => {
  const identity = {
    organizationId: normalizedUuid(candidate.organizationId),
    roleId: normalizedUuid(candidate.roleId),
  };
  switch (candidate.operation) {
    case "create_custom":
      return {
        ...candidate,
        ...identity,
        assignmentPolicy: normalizePolicyChoice(candidate.assignmentPolicy),
        permissions: normalizePermissions(candidate.permissions),
      };
    case "create_custom_from_template":
    case "accept_new_application_role":
    case "accept_application_role_revision":
      return {
        ...candidate,
        ...identity,
        sourceRoleId: normalizedUuid(candidate.sourceRoleId),
        templateSource: {
          ...candidate.templateSource,
          applicationRootId: normalizedUuid(candidate.templateSource.applicationRootId),
        },
        assignmentPolicy: normalizePolicyChoice(candidate.assignmentPolicy),
        permissions: normalizePermissions(candidate.permissions),
      };
    case "revise_metadata_policy":
      return {
        ...candidate,
        ...identity,
        assignmentPolicy: normalizePolicyChoice(candidate.assignmentPolicy),
      };
    case "revise_custom_permissions":
      return {
        ...candidate,
        ...identity,
        assignmentPolicy: normalizePolicyChoice(candidate.assignmentPolicy),
        permissions: normalizePermissions(candidate.permissions),
      };
    case "retire_role":
      return { ...candidate, ...identity };
  }
};

const evidenceError = (cause?: unknown): OrganizationRoleChangeEvidenceError =>
  new OrganizationRoleChangeEvidenceError(
    "ORGANIZATION_ROLE_CHANGE_EVIDENCE_INVALID",
    cause === undefined ? undefined : { cause },
  );

const prepareParsed = (
  preparation: OrganizationRoleChangePreparation,
): PreparedOrganizationRoleChange => {
  const candidate = normalizeCandidate(preparation.candidate);

  const assignments = preparation.affectedAssignments
    ?.map(normalizeAssignment)
    .sort((left, right) => left.roleAssignmentId.localeCompare(right.roleAssignmentId));
  const affectedAssignmentManifest =
    assignments === undefined
      ? undefined
      : {
          organizationId: normalizedUuid(candidate.organizationId),
          roleId: normalizedUuid(candidate.roleId),
          assignments,
        };
  const prepared = {
    contractVersion: "1.0.0" as const,
    candidate,
    ...(affectedAssignmentManifest === undefined ? {} : { affectedAssignmentManifest }),
  };
  const result = preparedOrganizationRoleChangeSchema.safeParse(prepared);
  if (!result.success) throw evidenceError(result.error);
  return result.data;
};

export const prepareOrganizationRoleChangeEvidence = (
  preparationCandidate: OrganizationRoleChangePreparation,
): PreparedOrganizationRoleChange => {
  const parsed = organizationRoleChangePreparationSchema.safeParse(preparationCandidate);
  if (!parsed.success)
    throw new OrganizationRoleChangeEvidenceError("INVALID_ORGANIZATION_ROLE_CHANGE_PREPARATION", {
      cause: parsed.error,
    });
  return prepareParsed(parsed.data);
};

export const verifyPreparedOrganizationRoleChangeEvidence = (
  candidateValue: unknown,
): PreparedOrganizationRoleChange => {
  const parsed = preparedOrganizationRoleChangeSchema.safeParse(candidateValue);
  if (!parsed.success) throw evidenceError(parsed.error);
  let expected: PreparedOrganizationRoleChange;
  try {
    expected = prepareParsed({
      candidate: parsed.data.candidate,
      ...(parsed.data.affectedAssignmentManifest === undefined
        ? {}
        : { affectedAssignments: parsed.data.affectedAssignmentManifest.assignments }),
    });
  } catch (error) {
    if (error instanceof OrganizationRoleChangeEvidenceError) throw error;
    throw evidenceError(error);
  }
  if (canonicalJson(expected) !== canonicalJson(parsed.data)) throw evidenceError();
  return parsed.data;
};
