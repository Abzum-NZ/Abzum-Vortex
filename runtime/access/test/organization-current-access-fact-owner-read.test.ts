import * as shippingAccess from "../src/index";
import { describe, expect, it } from "vitest";
import {
  OrganizationCurrentAccessFactOwnerReadError,
  parseOrganizationDelegationAuthorityOwnerRead,
  parseOrganizationGroupMembershipOwnerRead,
  parseOrganizationGroupOwnerRead,
  parseOrganizationRoleActivationOwnerRead,
  parseOrganizationRoleAssignmentOwnerRead,
} from "./helpers/organization-current-access-fact-owner-read";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const fingerprint = (character: string): string => `sha256:${character.repeat(64)}`;

const organizationId = id(1);
const actorId = id(2);
const correlationId = id(3);
const changedAt = new Date("2026-09-05T01:02:03.000Z");
const temporal = {
  starts_at: "2026-09-05T00:00:00.000Z",
  expires_at: "2026-09-06T00:00:00.000Z",
  state: "live",
  granted_by_actor_id: actorId,
  granted_at: "2026-09-05T00:00:00.000Z",
  grant_correlation_id: correlationId,
  changed_by_actor_id: actorId,
  changed_at: changedAt,
  change_correlation_id: correlationId,
  revoked_by_actor_id: null,
  revoked_at: null,
  revocation_correlation_id: null,
};

describe("owner-only organization current access fact read contract proof", () => {
  it("keeps owner-only read bindings out of the shipping Access surface", () => {
    expect(shippingAccess).not.toHaveProperty("parseOrganizationGroupOwnerRead");
    expect(shippingAccess).not.toHaveProperty("createOrganizationCurrentAccessFactRepository");
  });

  it("maps an exact Group row and preserves safe revisions and timestamps", () => {
    expect(
      parseOrganizationGroupOwnerRead([
        {
          group_id: id(10),
          organization_id: organizationId,
          group_key: "review_group",
          label: "Review Group",
          state: "active",
          revision: "2",
          created_by_actor_id: actorId,
          created_at: "2026-09-01T00:00:00.000Z",
          changed_by_actor_id: actorId,
          changed_at: changedAt,
          change_correlation_id: correlationId,
        },
      ]),
    ).toEqual({
      groupId: id(10),
      organizationId,
      key: "review_group",
      label: "Review Group",
      state: "active",
      revision: 2,
      createdByActorId: actorId,
      createdAt: "2026-09-01T00:00:00.000Z",
      changedByActorId: actorId,
      changedAt: changedAt.toISOString(),
      changeCorrelationId: correlationId,
    });
  });

  it("maps timing-only membership and assignment states without implying permission", () => {
    const membership = parseOrganizationGroupMembershipOwnerRead([
      {
        membership_id: id(20),
        organization_id: organizationId,
        group_id: id(10),
        organization_account_id: id(11),
        revision: 1n,
        effective_state: "scheduled",
        ...temporal,
      },
    ]);
    expect(membership?.membership.revision).toBe(1);
    expect(membership?.effectiveState).toBe("scheduled");

    const assignment = parseOrganizationRoleAssignmentOwnerRead([
      {
        role_assignment_id: id(30),
        organization_id: organizationId,
        role_id: id(31),
        assignee_kind: "group",
        organization_account_id: null,
        group_id: id(10),
        assignment_kind: "eligible",
        revision: "7",
        effective_state: "active",
        ...temporal,
      },
    ]);
    expect(assignment).toMatchObject({
      assignment: {
        assignee: { kind: "group", groupId: id(10) },
        assignmentKind: "eligible",
        revision: 7,
      },
      effectiveState: "active",
    });

    expect(
      parseOrganizationRoleAssignmentOwnerRead([
        {
          role_assignment_id: id(32),
          organization_id: organizationId,
          role_id: id(31),
          assignee_kind: "organization_account",
          organization_account_id: id(11),
          group_id: null,
          assignment_kind: "standing",
          revision: "1",
          effective_state: "active",
          ...temporal,
        },
      ])?.assignment.assignee,
    ).toEqual({ kind: "organization_account", organizationAccountId: id(11) });
  });

  it("maps direct and Group activation evidence while returning only temporal state", () => {
    const activationRow = {
      role_activation_id: id(40),
      organization_id: organizationId,
      organization_account_id: id(11),
      role_id: id(31),
      revision: "3",
      historical_role_revision: "5",
      authority_continuity_revision: "2",
      policy_continuity_revision: "4",
      activation_policy_id: id(41),
      activation_policy_revision: "6",
      activation_policy_fingerprint: fingerprint("a"),
      eligibility_source_kind: "direct",
      role_assignment_id: id(30),
      role_assignment_revision: "7",
      membership_id: null,
      membership_revision: null,
      state: "live",
      activated_by_actor_id: actorId,
      activated_at: "2026-09-05T00:00:00.000Z",
      expires_at: "2026-09-05T01:00:00.000Z",
      activation_correlation_id: correlationId,
      changed_by_actor_id: actorId,
      changed_at: changedAt,
      change_correlation_id: correlationId,
      revoked_by_actor_id: null,
      revoked_at: null,
      revocation_correlation_id: null,
      temporal_state: "expired",
    };
    const direct = parseOrganizationRoleActivationOwnerRead([activationRow]);
    expect(direct).toMatchObject({
      activation: {
        eligibilitySource: {
          kind: "direct",
          eligibilityAssignment: { roleAssignmentId: id(30), revision: 7 },
        },
      },
      temporalState: "expired",
    });

    const group = parseOrganizationRoleActivationOwnerRead([
      {
        ...activationRow,
        eligibility_source_kind: "group",
        membership_id: id(20),
        membership_revision: "9",
      },
    ]);
    expect(group?.activation.eligibilitySource).toEqual({
      kind: "group",
      eligibilityAssignment: { roleAssignmentId: id(30), revision: 7 },
      originatingMembership: { membershipId: id(20), revision: 9 },
    });
  });

  it("maps the reader-assembled closed delegation scope", () => {
    const permission = {
      kind: "exact",
      applicationRootId: id(50),
      ownerKind: "application",
      ownerId: id(50),
      permissionId: id(51),
      acceptedRegistrationRevision: 3,
      catalogueFingerprint: fingerprint("b"),
      continuityRevision: 2,
      meaningFingerprint: fingerprint("c"),
    };
    const delegation = parseOrganizationDelegationAuthorityOwnerRead([
      {
        delegation_authority_id: id(60),
        organization_id: organizationId,
        holder_kind: "organization_account",
        organization_account_id: id(11),
        group_id: null,
        scope: {
          kind: "bounded",
          permissions: [permission],
          scopeFingerprint: fingerprint("d"),
        },
        revision: "1",
        effective_state: "active",
        ...temporal,
      },
    ]);
    expect(delegation).toMatchObject({
      delegation: {
        holder: { kind: "organization_account", organizationAccountId: id(11) },
        scope: { kind: "bounded", permissions: [permission] },
      },
      effectiveState: "active",
    });
  });

  it("refuses duplicate, malformed, unsafe, or discriminator-incoherent rows", () => {
    expect(parseOrganizationGroupOwnerRead([])).toBeUndefined();
    expect(() => parseOrganizationGroupOwnerRead([{}, {}])).toThrow(
      OrganizationCurrentAccessFactOwnerReadError,
    );
    expect(() =>
      parseOrganizationGroupOwnerRead([
        {
          group_id: id(10),
          organization_id: organizationId,
          group_key: "review_group",
          label: "Review Group",
          state: "active",
          revision: "9007199254740992",
          created_by_actor_id: actorId,
          created_at: "2026-09-01T00:00:00.000Z",
          changed_by_actor_id: actorId,
          changed_at: changedAt,
          change_correlation_id: correlationId,
        },
      ]),
    ).toThrow(OrganizationCurrentAccessFactOwnerReadError);

    expect(() =>
      parseOrganizationRoleAssignmentOwnerRead([
        {
          role_assignment_id: id(30),
          organization_id: organizationId,
          role_id: id(31),
          assignee_kind: "group",
          organization_account_id: id(11),
          group_id: null,
          assignment_kind: "eligible",
          revision: "1",
          effective_state: "active",
          ...temporal,
        },
      ]),
    ).toThrow(OrganizationCurrentAccessFactOwnerReadError);

    expect(() =>
      parseOrganizationRoleAssignmentOwnerRead([
        {
          role_assignment_id: id(30),
          organization_id: organizationId,
          role_id: id(31),
          assignee_kind: "group",
          organization_account_id: id(11),
          group_id: id(10),
          assignment_kind: "eligible",
          revision: "1",
          effective_state: "active",
          ...temporal,
        },
      ]),
    ).toThrow(OrganizationCurrentAccessFactOwnerReadError);

    expect(() =>
      parseOrganizationRoleAssignmentOwnerRead([
        {
          role_assignment_id: id(30),
          organization_id: organizationId,
          role_id: id(31),
          assignee_kind: "organization_account",
          organization_account_id: id(11),
          group_id: id(10),
          assignment_kind: "standing",
          revision: "1",
          effective_state: "active",
          ...temporal,
        },
      ]),
    ).toThrow(OrganizationCurrentAccessFactOwnerReadError);

    const activationWithMixedSource = {
      role_activation_id: id(40),
      organization_id: organizationId,
      organization_account_id: id(11),
      role_id: id(31),
      revision: "1",
      historical_role_revision: "1",
      authority_continuity_revision: "1",
      policy_continuity_revision: "1",
      activation_policy_id: id(41),
      activation_policy_revision: "1",
      activation_policy_fingerprint: fingerprint("a"),
      eligibility_source_kind: "direct",
      role_assignment_id: id(30),
      role_assignment_revision: "1",
      membership_id: id(20),
      membership_revision: "1",
      state: "live",
      activated_by_actor_id: actorId,
      activated_at: "2026-09-05T00:00:00.000Z",
      expires_at: "2026-09-05T01:00:00.000Z",
      activation_correlation_id: correlationId,
      changed_by_actor_id: actorId,
      changed_at: changedAt,
      change_correlation_id: correlationId,
      revoked_by_actor_id: null,
      revoked_at: null,
      revocation_correlation_id: null,
      temporal_state: "active",
    };
    expect(() => parseOrganizationRoleActivationOwnerRead([activationWithMixedSource])).toThrow(
      OrganizationCurrentAccessFactOwnerReadError,
    );

    expect(() =>
      parseOrganizationDelegationAuthorityOwnerRead([
        {
          delegation_authority_id: id(60),
          organization_id: organizationId,
          holder_kind: "organization_account",
          organization_account_id: id(11),
          group_id: id(10),
          scope: { kind: "organization_catalogue" },
          revision: "1",
          effective_state: "active",
          ...temporal,
        },
      ]),
    ).toThrow(OrganizationCurrentAccessFactOwnerReadError);
  });
});
