import "server-only";

import { databaseRevision, describeFailure, sameId } from "../catalogue/runtime-primitives";
import type { AffectedRoleAssignment } from "./organization-access-catalogue";
import type {
  OrganizationRoleChangeCandidate,
  PreparedOrganizationRoleChange,
} from "./organization-role-changes";
import type { DatabaseRow } from "../db/request-transaction";
import { organizationRoleTemplateSourceSchema } from "./organization-role-changes";
import type { createHumanOrganizationRequestService } from "./human-organization-request";
import type { HumanOrganizationRequestResult } from "./human-organization-request";
import { prepareOrganizationRoleChangeEvidence } from "./organization-role-change-evidence";

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
  refusal_reason: unknown;
};

export type MembershipChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  membership_summary: unknown;
  access_version: unknown;
  refusal_reason: unknown;
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
  refusal_reason: unknown;
};

export type RoleAssignmentChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  assignment_summary: unknown;
  access_version: unknown;
  refusal_reason: unknown;
};

export type RoleChangePreparationRow = DatabaseRow & {
  preparation: unknown;
};

export type DelegationAuthorityChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  delegation_summary: unknown;
  access_version: unknown;
  refusal_reason: unknown;
};

export type StewardshipAppointmentRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  appointment_summary: unknown;
  access_version: unknown;
  refusal_reason: unknown;
};

export type RoleActivationChangeRow = DatabaseRow & {
  outcome: unknown;
  organization_id: unknown;
  activation_summary: unknown;
  access_version: unknown;
  refusal_reason: unknown;
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

export const requireOne = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
  return rows[0];
};

const recordedRefusalMarker = Symbol("recordedAccessAdministrationRefusal");
export const recordedRefusal = (row: Readonly<{ refusal_reason: unknown }>) => {
  const reason = row.refusal_reason;
  if (
    reason !== null &&
    reason !== "recent_authentication_required" &&
    reason !== "multi_factor_required"
  )
    throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
  return { marker: recordedRefusalMarker, reason };
};
type RecordedRefusal = ReturnType<typeof recordedRefusal>;

export const isRecordedRefusal = (
  row: Readonly<{
    outcome: unknown;
    organization_id: unknown;
    access_version: unknown;
    refusal_reason: unknown;
  }>,
  summary: unknown,
  organizationId: string,
  accessVersion: number,
): boolean => {
  if (row.outcome !== "refused") {
    if (row.refusal_reason !== null)
      throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
    return false;
  }
  if (
    typeof row.organization_id !== "string" ||
    !sameId(row.organization_id, organizationId) ||
    summary !== null ||
    (row.refusal_reason !== null &&
      row.refusal_reason !== "recent_authentication_required" &&
      row.refusal_reason !== "multi_factor_required") ||
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
  if (
    typeof result.value === "object" &&
    result.value !== null &&
    "marker" in result.value &&
    result.value.marker === recordedRefusalMarker
  ) {
    const reason = (result.value as RecordedRefusal).reason;
    return refuseAdministration(operation, "ACCESS_ADMIN_REFUSED_BY_DATABASE", {
      kind: "unavailable",
      ...(reason === null ? {} : { code: reason }),
    } as const);
  }
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
