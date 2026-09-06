import "server-only";

import {
  delegationAuthorityEffectiveStateSchema,
  groupMembershipEffectiveStateSchema,
  groupSchema,
  roleActivationTemporalStateSchema,
  roleAssignmentEffectiveStateSchema,
  type DelegationAuthorityEffectiveState,
  type Group,
  type GroupMembershipEffectiveState,
  type RoleActivationTemporalState,
  type RoleAssignmentEffectiveState,
} from "@vortex/contracts";

type OwnerReadRow = Readonly<Record<string, unknown>>;

export class OrganizationCurrentAccessFactOwnerReadError extends Error {
  constructor() {
    super("INVALID_ORGANIZATION_CURRENT_ACCESS_FACT_STORAGE_RESULT");
    this.name = "OrganizationCurrentAccessFactOwnerReadError";
  }
}

const oneOrNone = (rows: readonly OwnerReadRow[]): OwnerReadRow | undefined => {
  if (rows.length === 0) return undefined;
  if (rows.length !== 1 || rows[0] === undefined)
    throw new OrganizationCurrentAccessFactOwnerReadError();
  return rows[0];
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const timestamp = (value: unknown): unknown =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : value;

const optional = (value: unknown): unknown => (value === null ? undefined : value);
const optionalTimestamp = (value: unknown): unknown => optional(timestamp(value));

const parseOne = <Output>(
  rows: readonly OwnerReadRow[],
  candidate: (row: OwnerReadRow) => unknown,
  parse: (value: unknown) => { success: true; data: Output } | { success: false },
): Output | undefined => {
  const row = oneOrNone(rows);
  if (row === undefined) return undefined;
  const parsed = parse(candidate(row));
  if (!parsed.success) throw new OrganizationCurrentAccessFactOwnerReadError();
  return parsed.data;
};

const changeEvidence = (row: OwnerReadRow) => ({
  changedByActorId: row.changed_by_actor_id,
  changedAt: timestamp(row.changed_at),
  changeCorrelationId: row.change_correlation_id,
});

const temporalGrant = (row: OwnerReadRow) => ({
  startsAt: timestamp(row.starts_at),
  expiresAt: optionalTimestamp(row.expires_at),
  state: row.state,
  grantedByActorId: row.granted_by_actor_id,
  grantedAt: timestamp(row.granted_at),
  grantCorrelationId: row.grant_correlation_id,
  ...changeEvidence(row),
  revokedByActorId: optional(row.revoked_by_actor_id),
  revokedAt: optionalTimestamp(row.revoked_at),
  revocationCorrelationId: optional(row.revocation_correlation_id),
});

const assignee = (row: OwnerReadRow): unknown => {
  if (
    row.assignee_kind === "organization_account" &&
    (row.group_id === null || row.group_id === undefined)
  )
    return {
      kind: "organization_account",
      organizationAccountId: row.organization_account_id,
    };
  if (
    row.assignee_kind === "group" &&
    (row.organization_account_id === null || row.organization_account_id === undefined)
  )
    return { kind: "group", groupId: row.group_id };
  return { kind: row.assignee_kind };
};

export const parseOrganizationGroupOwnerRead = (rows: readonly OwnerReadRow[]): Group | undefined =>
  parseOne(
    rows,
    (row) => ({
      groupId: row.group_id,
      organizationId: row.organization_id,
      key: row.group_key,
      label: row.label,
      state: row.state,
      revision: revision(row.revision),
      createdByActorId: row.created_by_actor_id,
      createdAt: timestamp(row.created_at),
      ...changeEvidence(row),
    }),
    (value) => groupSchema.safeParse(value),
  );

export const parseOrganizationGroupMembershipOwnerRead = (
  rows: readonly OwnerReadRow[],
): GroupMembershipEffectiveState | undefined =>
  parseOne(
    rows,
    (row) => ({
      membership: {
        membershipId: row.membership_id,
        organizationId: row.organization_id,
        groupId: row.group_id,
        organizationAccountId: row.organization_account_id,
        revision: revision(row.revision),
        ...temporalGrant(row),
      },
      effectiveState: row.effective_state,
    }),
    (value) => groupMembershipEffectiveStateSchema.safeParse(value),
  );

export const parseOrganizationRoleAssignmentOwnerRead = (
  rows: readonly OwnerReadRow[],
): RoleAssignmentEffectiveState | undefined =>
  parseOne(
    rows,
    (row) => ({
      assignment: {
        roleAssignmentId: row.role_assignment_id,
        organizationId: row.organization_id,
        roleId: row.role_id,
        assignee: assignee(row),
        assignmentKind: row.assignment_kind,
        revision: revision(row.revision),
        ...temporalGrant(row),
      },
      effectiveState: row.effective_state,
    }),
    (value) => roleAssignmentEffectiveStateSchema.safeParse(value),
  );

export const parseOrganizationRoleActivationOwnerRead = (
  rows: readonly OwnerReadRow[],
): RoleActivationTemporalState | undefined =>
  parseOne(
    rows,
    (row) => ({
      activation: {
        roleActivationId: row.role_activation_id,
        organizationId: row.organization_id,
        organizationAccountId: row.organization_account_id,
        roleId: row.role_id,
        revision: revision(row.revision),
        historicalRoleRevision: revision(row.historical_role_revision),
        authorityContinuityRevision: revision(row.authority_continuity_revision),
        policyContinuityRevision: revision(row.policy_continuity_revision),
        activationPolicy: {
          activationPolicyId: row.activation_policy_id,
          revision: revision(row.activation_policy_revision),
          fingerprint: row.activation_policy_fingerprint,
        },
        eligibilitySource:
          row.eligibility_source_kind === "direct" &&
          (row.membership_id === null || row.membership_id === undefined) &&
          (row.membership_revision === null || row.membership_revision === undefined)
            ? {
                kind: "direct",
                eligibilityAssignment: {
                  roleAssignmentId: row.role_assignment_id,
                  revision: revision(row.role_assignment_revision),
                },
              }
            : row.eligibility_source_kind === "group"
              ? {
                  kind: "group",
                  eligibilityAssignment: {
                    roleAssignmentId: row.role_assignment_id,
                    revision: revision(row.role_assignment_revision),
                  },
                  originatingMembership: {
                    membershipId: row.membership_id,
                    revision: revision(row.membership_revision),
                  },
                }
              : { kind: row.eligibility_source_kind },
        state: row.state,
        activatedByActorId: row.activated_by_actor_id,
        activatedAt: timestamp(row.activated_at),
        expiresAt: timestamp(row.expires_at),
        activationCorrelationId: row.activation_correlation_id,
        ...changeEvidence(row),
        revokedByActorId: optional(row.revoked_by_actor_id),
        revokedAt: optionalTimestamp(row.revoked_at),
        revocationCorrelationId: optional(row.revocation_correlation_id),
      },
      temporalState: row.temporal_state,
    }),
    (value) => roleActivationTemporalStateSchema.safeParse(value),
  );

export const parseOrganizationDelegationAuthorityOwnerRead = (
  rows: readonly OwnerReadRow[],
): DelegationAuthorityEffectiveState | undefined =>
  parseOne(
    rows,
    (row) => ({
      delegation: {
        delegationAuthorityId: row.delegation_authority_id,
        organizationId: row.organization_id,
        holder: assignee({
          ...row,
          assignee_kind: row.holder_kind,
        }),
        scope: row.scope,
        revision: revision(row.revision),
        ...temporalGrant(row),
      },
      effectiveState: row.effective_state,
    }),
    (value) => delegationAuthorityEffectiveStateSchema.safeParse(value),
  );
