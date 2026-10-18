import "server-only";

import {
  databaseRevision,
  describeFailure,
  sameId,
  type AffectedRoleAssignment,
  type OrganizationRoleChangeCandidate,
  type PreparedOrganizationRoleChange,
} from "../schema";
import type { DatabaseRow } from "../db/index";
import { organizationRoleTemplateSourceSchema } from "./organization-role-changes";
import type { createHumanOrganizationRequestService } from "./human-organization-request";
import type { HumanOrganizationRequestResult } from "./human-organization-request";
import { prepareOrganizationRoleChangeEvidence } from "./organization-role-change-evidence";

export type GroupPageRow = DatabaseRow & {
  organization_id: unknown;
  groups: unknown;
  next_after_group_id: unknown;
  access_version: unknown;
};

export type GroupDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  group_summary: unknown;
  access_version: unknown;
};

export type GroupChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  group_summary: unknown;
  access_version: unknown;
};

export type MembershipPageRow = DatabaseRow & {
  organization_id: unknown;
  group_id: unknown;
  memberships: unknown;
  next_after_membership_id: unknown;
  access_version: unknown;
};

export type MembershipDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  membership_summary: unknown;
  access_version: unknown;
};

export type MembershipChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  membership_summary: unknown;
  access_version: unknown;
};

export type PermissionPageRow = DatabaseRow & {
  organization_id: unknown;
  permissions: unknown;
  next_after_application_root_id: unknown;
  next_after_owner_kind: unknown;
  next_after_owner_id: unknown;
  next_after_permission_id: unknown;
  access_version: unknown;
};

export type PermissionDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  permission_summary: unknown;
  access_version: unknown;
};

export type RolePageRow = DatabaseRow & {
  organization_id: unknown;
  roles: unknown;
  next_after_role_id: unknown;
  access_version: unknown;
};

export type RoleDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  role_summary: unknown;
  access_version: unknown;
};

export type RoleChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  role_summary: unknown;
  access_version: unknown;
};

export type ApplicationRoleTemplatePageRow = DatabaseRow & {
  organization_id: unknown;
  templates: unknown;
  next_after_application_root_id: unknown;
  next_after_source_role_id: unknown;
  access_version: unknown;
};

export type ApplicationRoleTemplateDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  template_summary: unknown;
  access_version: unknown;
};

export type RoleAssignmentPageRow = DatabaseRow & {
  organization_id: unknown;
  assignments: unknown;
  next_after_role_assignment_id: unknown;
  access_version: unknown;
};

export type RoleAssignmentDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  assignment_summary: unknown;
  access_version: unknown;
};

export type RoleAssignmentChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  assignment_summary: unknown;
  access_version: unknown;
};

export type RoleChangePreparationRow = DatabaseRow & {
  preparation: unknown;
};

export type DelegationAuthorityChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  delegation_summary: unknown;
  access_version: unknown;
};

export type StewardshipAppointmentRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  appointment_summary: unknown;
  access_version: unknown;
};

export type RoleActivationChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  activation_summary: unknown;
  access_version: unknown;
};

export type DelegationAuthorityPageRow = DatabaseRow & {
  organization_id: unknown;
  delegations: unknown;
  next_after_delegation_authority_id: unknown;
  access_version: unknown;
};

export type DelegationAuthorityDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  delegation_summary: unknown;
  access_version: unknown;
};

export type RoleActivationPageRow = DatabaseRow & {
  organization_id: unknown;
  activations: unknown;
  next_after_role_activation_id: unknown;
  access_version: unknown;
};

export type RoleActivationDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  activation_summary: unknown;
  access_version: unknown;
};

export const normalizeGroup = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return { ...value, revision: databaseRevision((value as { revision?: unknown }).revision) };
};

export const normalizeMembership = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return { ...value, revision: databaseRevision((value as { revision?: unknown }).revision) };
};

export const normalizeAssignmentLedgerFact = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return { ...value, revision: databaseRevision((value as { revision?: unknown }).revision) };
};

export const normalizeRoleActivation = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const activation = value as {
    revision?: unknown;
    historicalRoleRevision?: unknown;
    eligibilitySource?: unknown;
    policyAtActivation?: unknown;
  };
  const source = activation.eligibilitySource;
  const normalizedSource =
    typeof source === "object" && source !== null && !Array.isArray(source)
      ? {
          ...source,
          ...(typeof (source as { eligibilityAssignment?: unknown }).eligibilityAssignment ===
            "object" &&
          (source as { eligibilityAssignment?: unknown }).eligibilityAssignment !== null &&
          !Array.isArray((source as { eligibilityAssignment?: unknown }).eligibilityAssignment)
            ? {
                eligibilityAssignment: {
                  ...(source as { eligibilityAssignment: object }).eligibilityAssignment,
                  revision: databaseRevision(
                    (
                      source as {
                        eligibilityAssignment: { revision?: unknown };
                      }
                    ).eligibilityAssignment.revision,
                  ),
                },
              }
            : {}),
          ...(typeof (source as { originatingMembership?: unknown }).originatingMembership ===
            "object" &&
          (source as { originatingMembership?: unknown }).originatingMembership !== null &&
          !Array.isArray((source as { originatingMembership?: unknown }).originatingMembership)
            ? {
                originatingMembership: {
                  ...(source as { originatingMembership: object }).originatingMembership,
                  revision: databaseRevision(
                    (
                      source as {
                        originatingMembership: { revision?: unknown };
                      }
                    ).originatingMembership.revision,
                  ),
                },
              }
            : {}),
        }
      : source;
  const policy = activation.policyAtActivation;
  return {
    ...activation,
    revision: databaseRevision(activation.revision),
    historicalRoleRevision: databaseRevision(activation.historicalRoleRevision),
    ...(source === undefined ? {} : { eligibilitySource: normalizedSource }),
    ...(typeof policy === "object" && policy !== null && !Array.isArray(policy)
      ? {
          policyAtActivation: {
            ...policy,
            maximumActivationDurationSeconds: databaseRevision(
              (policy as { maximumActivationDurationSeconds?: unknown })
                .maximumActivationDurationSeconds,
            ),
          },
        }
      : {}),
  };
};

export const sameAssignee = (
  assignee: Readonly<
    | { kind: "organization_account"; organizationAccountId: string }
    | { kind: "group"; groupId: string }
  >,
  requested: Readonly<{
    assigneeKind: "organization_account" | "group";
    organizationAccountId?: string | undefined;
    groupId?: string | undefined;
  }>,
): boolean =>
  assignee.kind === "organization_account"
    ? requested.assigneeKind === "organization_account" &&
      requested.organizationAccountId !== undefined &&
      sameId(assignee.organizationAccountId, requested.organizationAccountId)
    : requested.assigneeKind === "group" &&
      requested.groupId !== undefined &&
      sameId(assignee.groupId, requested.groupId);

export const samePermissionReference = (
  left: Readonly<{
    applicationRootId?: string | undefined;
    ownerKind: string;
    ownerId: string;
    permissionId: string;
  }>,
  right: Readonly<{
    applicationRootId?: string | undefined;
    ownerKind: string;
    ownerId: string;
    permissionId: string;
  }>,
): boolean =>
  left.ownerKind === right.ownerKind &&
  sameId(left.ownerId, right.ownerId) &&
  sameId(left.permissionId, right.permissionId) &&
  (left.applicationRootId === undefined) === (right.applicationRootId === undefined) &&
  (left.applicationRootId === undefined ||
    right.applicationRootId === undefined ||
    sameId(left.applicationRootId, right.applicationRootId));

export const sameApplicationRoleTemplateReference = (
  left: Readonly<{ applicationRootId: string; sourceRoleId: string }>,
  right: Readonly<{ applicationRootId: string; sourceRoleId: string }>,
): boolean =>
  sameId(left.applicationRootId, right.applicationRootId) &&
  sameId(left.sourceRoleId, right.sourceRoleId);

export const requireOne = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
  return rows[0];
};

export const recordedRefusal = Symbol("recordedAccessAdministrationRefusal");
type RecordedRefusal = typeof recordedRefusal;

export const isRecordedRefusal = (
  row: Readonly<{
    outcome: unknown;
    organization_id: unknown;
    access_version: unknown;
  }>,
  summary: unknown,
  organizationId: string,
  accessVersion: number,
): boolean => {
  if (row.outcome !== "refused") return false;
  if (
    typeof row.organization_id !== "string" ||
    !sameId(row.organization_id, organizationId) ||
    summary !== null ||
    databaseRevision(row.access_version) !== accessVersion
  )
    throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
  return true;
};

/** Logs one refused or failed administration operation with a stable reason code and the cause. */
export const refuseAdministration = <Outcome>(
  operation: string,
  code: string,
  outcome: Outcome,
  cause?: unknown,
): Outcome => {
  console.error(
    `[access] administration ${operation} ${code}${cause === undefined ? "" : `: ${describeFailure(cause)}`}`,
  );
  return outcome;
};

export const mapRecordedRefusal = async <Result>(
  operation: string,
  request: Promise<HumanOrganizationRequestResult<Result | RecordedRefusal>>,
): Promise<HumanOrganizationRequestResult<Result>> => {
  const result = await request;
  if (result.kind !== "available") return result;
  if (result.value === recordedRefusal)
    return refuseAdministration(operation, "ACCESS_ADMIN_REFUSED_BY_DATABASE", {
      kind: "unavailable",
    } as const);
  return { kind: "available", value: result.value as Result };
};

/**
 * A preparation read that finds nothing usable is a permission-shaped refusal, so the protected
 * request runner maps it to the same neutral unavailability as a refused operation.
 */
export const preparationUnavailable = (cause?: unknown): Error => {
  const error = new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE", { cause });
  Object.assign(error, { code: "42501" });
  return error;
};

/**
 * The read names the Application registration the template role is prepared from: its root,
 * revision and catalogue fingerprint. The writer reads the role's live permissions from it again.
 */
export const readRoleTemplateSource = (value: unknown) => {
  const parsed = organizationRoleTemplateSourceSchema.safeParse(value);
  if (!parsed.success) throw preparationUnavailable(parsed.error);
  return parsed.data;
};

/**
 * Seals the role-change candidate with the canonical preparation. Evidence the canonical verifier
 * refuses is never retried into a different answer, so it is the same neutral unavailability.
 */
export const sealPreparedRoleChange = (
  candidate: OrganizationRoleChangeCandidate,
  affectedAssignments?: AffectedRoleAssignment[],
): PreparedOrganizationRoleChange => {
  try {
    return prepareOrganizationRoleChangeEvidence({
      candidate,
      ...(affectedAssignments === undefined ? {} : { affectedAssignments }),
    });
  } catch (error) {
    throw preparationUnavailable(error);
  }
};

export type AccessAdministrationContext = Readonly<{
  requests: ReturnType<typeof createHumanOrganizationRequestService>;
  newGroupId: () => string;
  newMembershipId: () => string;
  newRoleAssignmentId: () => string;
  newDelegationAuthorityId: () => string;
  newActivityId: () => string;
}>;
