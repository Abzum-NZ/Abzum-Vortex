import type {
  DatabaseRow,
  DatabaseValue,
  RequestDatabaseTransaction,
  RuntimeDatabaseTransaction,
} from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationAccessAdministrationService } from "../src/organization-access-administration";

vi.mock("server-only", () => ({}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const selectedScope = {
  tenant_id: id(1),
  organization_id: id(2),
  organization_account_id: id(3),
  access_version: "7",
};
const verifiedSession = {
  identityId: id(4),
  sessionId: id(5),
  authenticationStrength: "multi_factor" as const,
  accessTokenIssuedAt: "2026-09-06T00:00:00.000Z",
  accessTokenExpiresAt: "2026-09-06T02:00:00.000Z",
};

const serviceFor = (result: readonly DatabaseRow[]) => {
  const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
  const service = createOrganizationAccessAdministrationService({
    identityAuthorityId: id(6),
    clock: () => new Date("2026-09-06T01:00:00.000Z"),
    correlationId: () => id(7),
    groupId: () => id(20),
    activityId: () => id(21),
    resolvedRequestTransaction: async (resolve, operation) => {
      const resolved = await resolve({
        query: async () => [selectedScope] as never,
      } satisfies RuntimeDatabaseTransaction);
      const transaction: RequestDatabaseTransaction = {
        query: async <Row extends DatabaseRow>(
          strings: TemplateStringsArray,
          ...values: readonly DatabaseValue[]
        ) => {
          calls.push({ text: strings.join("$value"), values });
          return result as readonly Row[];
        },
      };
      return operation(transaction, resolved.scope);
    },
  });
  return { calls, service };
};

const serviceForSequence = (results: readonly (readonly DatabaseRow[])[]) => {
  const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
  let queryIndex = 0;
  const service = createOrganizationAccessAdministrationService({
    identityAuthorityId: id(6),
    clock: () => new Date("2026-09-06T01:00:00.000Z"),
    correlationId: () => id(7),
    groupId: () => id(20),
    activityId: () => id(21),
    resolvedRequestTransaction: async (resolve, operation) => {
      const resolved = await resolve({
        query: async () => [selectedScope] as never,
      } satisfies RuntimeDatabaseTransaction);
      const transaction: RequestDatabaseTransaction = {
        query: async <Row extends DatabaseRow>(
          strings: TemplateStringsArray,
          ...values: readonly DatabaseValue[]
        ) => {
          calls.push({ text: strings.join("$value"), values });
          const result = results[queryIndex];
          queryIndex += 1;
          return (result ?? []) as readonly Row[];
        },
      };
      return operation(transaction, resolved.scope);
    },
  });
  return { calls, service };
};

describe("organization Access administration", () => {
  it("creates a Group with trusted identities and binds the safe result", async () => {
    const { calls, service } = serviceFor([
      {
        organization_id: id(2).toUpperCase(),
        group_summary: {
          groupId: id(20).toUpperCase(),
          key: "review_group",
          label: "Review group",
          state: "active",
          revision: "1",
        },
        access_version: "8",
      },
    ]);

    await expect(
      service.createGroup(
        verifiedSession,
        { organizationId: id(2) },
        { key: "review_group", label: "Review group" },
      ),
    ).resolves.toEqual({
      kind: "available",
      value: {
        group: {
          groupId: id(20).toUpperCase(),
          key: "review_group",
          label: "Review group",
          state: "active",
          revision: 1,
        },
        accessVersion: 8,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("create_organization_group_for_administration");
    expect(calls[0]?.values).toEqual([id(20), "review_group", "Review group", id(21)]);
  });

  it("renames a Group with its reviewed revision and a trusted Activity identity", async () => {
    const { calls, service } = serviceFor([
      {
        organization_id: id(2),
        group_summary: {
          groupId: id(8),
          key: "review_group",
          label: "Renamed group",
          state: "active",
          revision: 3n,
        },
        access_version: 8n,
      },
    ]);

    await expect(
      service.renameGroup(
        verifiedSession,
        { organizationId: id(2) },
        { groupId: id(8), expectedGroupRevision: 2, label: "Renamed group" },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { group: { groupId: id(8), revision: 3 }, accessVersion: 8 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("rename_organization_group_for_administration");
    expect(calls[0]?.values).toEqual([id(8), 2, "Renamed group", id(21)]);
  });

  it("retires a Group without caller-selected affected authority", async () => {
    const { calls, service } = serviceFor([
      {
        organization_id: id(2),
        group_summary: {
          groupId: id(8),
          key: "review_group",
          label: "Review group",
          state: "retired",
          revision: "3",
        },
        access_version: "8",
      },
    ]);
    await expect(
      service.retireGroup(
        verifiedSession,
        { organizationId: id(2) },
        { groupId: id(8), expectedGroupRevision: 2 },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { group: { groupId: id(8), state: "retired", revision: 3 }, accessVersion: 8 },
    });
    expect(calls[0]?.values).toEqual([id(8), 2, id(21)]);
  });

  it("removes one exact Group membership and binds the terminal result", async () => {
    const { calls, service } = serviceFor([
      {
        organization_id: id(2),
        membership_summary: {
          membershipId: id(30),
          groupId: id(8),
          organizationAccountId: id(32),
          accountDisplayName: "Member",
          revision: "2",
          startsAt: "2026-09-01T00:00:00.000Z",
          state: "revoked",
          temporalState: "revoked",
        },
        access_version: "8",
      },
    ]);
    await expect(
      service.removeGroupMembership(
        verifiedSession,
        { organizationId: id(2) },
        { membershipId: id(30), expectedMembershipRevision: 1 },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: {
        membership: { membershipId: id(30), state: "revoked", revision: 2 },
        accessVersion: 8,
      },
    });
    expect(calls[0]?.values).toEqual([id(30), 1, id(21)]);
  });

  it("prepares canonical role metadata evidence inside the protected change transaction", async () => {
    const { calls, service } = serviceForSequence([
      [
        {
          organization_id: id(2).toUpperCase(),
          candidate_basis: {
            operation: "revise_metadata_policy",
            organizationId: id(2).toUpperCase(),
            roleId: id(40).toUpperCase(),
            expectedRoleRevision: 1,
            key: "reviewed_role",
            label: "Old label",
            description: "Old description.",
            privilegeClassification: "privileged",
            assignmentPolicy: {
              kind: "activation_required",
              activationPolicy: {
                selection: "existing",
                reference: {
                  activationPolicyId: id(41),
                  revision: 2,
                  fingerprint: `sha256:${"a".repeat(64)}`,
                },
              },
            },
          },
          access_version: "7",
        },
      ],
      [
        {
          organization_id: id(2),
          role_summary: {
            roleId: id(40),
            key: "reviewed_role",
            label: "New label",
            roleKind: "custom",
            lifecycle: "active",
            liveRevision: 2,
            privilegeClassification: "privileged",
            assignmentPolicy: {
              kind: "activation_required",
              maximumActivationDurationSeconds: 3600,
              reasonRequired: true,
              recentAuthentication: { kind: "multi_factor", maximumAgeSeconds: 900 },
              independentApprovalRequired: false,
            },
            source: { kind: "custom" },
            acceptedPermissionCount: 2,
          },
          access_version: "8",
        },
      ],
    ]);

    await expect(
      service.reviseRoleMetadata(
        verifiedSession,
        { organizationId: id(2) },
        {
          roleId: id(40),
          expectedRoleRevision: 1,
          label: "New label",
          description: "New description.",
        },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { role: { roleId: id(40), label: "New label", liveRevision: 2 }, accessVersion: 8 },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.text).toContain(
      "prepare_organization_role_metadata_change_for_administration",
    );
    expect(calls[0]?.values).toEqual([id(40), 1]);
    expect(calls[1]?.text).toContain("revise_organization_role_metadata_for_administration");
    expect(calls[1]?.values.slice(0, 4)).toEqual([id(40), 1, "New label", "New description."]);
    const prepared = JSON.parse(String(calls[1]?.values[4]));
    expect(prepared).toMatchObject({
      contractVersion: "1.0.0",
      candidate: {
        operation: "revise_metadata_policy",
        label: "New label",
        description: "New description.",
        assignmentPolicy: {
          activationPolicy: { reference: { activationPolicyId: id(41), revision: 2 } },
        },
      },
    });
    expect(prepared.roleCandidateFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(calls[1]?.values[5]).toBe(id(21));
  });

  it("retires one role using canonical evidence derived only from the exact command", async () => {
    const { calls, service } = serviceFor([
      {
        organization_id: id(2),
        role_summary: {
          roleId: id(40),
          key: "reviewed_role",
          label: "Reviewed role",
          roleKind: "custom",
          lifecycle: "retired",
          liveRevision: 3,
          privilegeClassification: "privileged",
          assignmentPolicy: { kind: "standing" },
          source: { kind: "custom" },
          acceptedPermissionCount: 2,
        },
        access_version: "8",
      },
    ]);
    await expect(
      service.retireRole(
        verifiedSession,
        { organizationId: id(2) },
        { roleId: id(40), expectedRoleRevision: 2 },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { role: { roleId: id(40), lifecycle: "retired", liveRevision: 3 } },
    });
    expect(calls[0]?.text).toContain("retire_organization_role_for_administration");
    expect(calls[0]?.values[0]).toBe(id(40));
    expect(calls[0]?.values[1]).toBe(2);
    expect(JSON.parse(String(calls[0]?.values[2]))).toMatchObject({
      candidate: { operation: "retire_role", roleId: id(40), expectedRoleRevision: 2 },
    });
    expect(calls[0]?.values[3]).toBe(id(21));
  });

  it("refuses malformed structural commands and mismatched private preparation", async () => {
    const malformed = serviceFor([]);
    await expect(
      malformed.service.retireGroup(
        verifiedSession,
        { organizationId: id(2) },
        { groupId: id(8), expectedGroupRevision: 0 },
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    await expect(
      malformed.service.removeGroupMembership(
        verifiedSession,
        { organizationId: id(2) },
        { membershipId: id(30), expectedMembershipRevision: 0 },
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(malformed.calls).toHaveLength(0);

    const mismatched = serviceForSequence([
      [
        {
          organization_id: id(2),
          candidate_basis: {
            operation: "revise_metadata_policy",
            organizationId: id(2),
            roleId: id(99),
            expectedRoleRevision: 1,
            key: "reviewed_role",
            label: "Old label",
            description: "Old description.",
            privilegeClassification: "privileged",
            assignmentPolicy: { kind: "standing" },
          },
          access_version: 7,
        },
      ],
    ]);
    await expect(
      mismatched.service.reviseRoleMetadata(
        verifiedSession,
        { organizationId: id(2) },
        {
          roleId: id(40),
          expectedRoleRevision: 1,
          label: "New label",
          description: "New description.",
        },
      ),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });
    expect(mismatched.calls).toHaveLength(1);
  });

  it("revokes one reviewed role assignment through the protected operation", async () => {
    const { calls, service } = serviceFor([
      {
        organization_id: id(2).toUpperCase(),
        assignment_summary: {
          roleAssignmentId: id(30).toUpperCase(),
          role: { roleId: id(31), key: "reviewer", label: "Reviewer", lifecycle: "retired" },
          assignee: {
            kind: "organization_account",
            organizationAccountId: id(32),
            displayName: "Reviewer",
          },
          assignmentKind: "standing",
          revision: "3",
          startsAt: "2026-09-01T00:00:00.000Z",
          state: "revoked",
          temporalState: "revoked",
        },
        access_version: "8",
      },
    ]);
    await expect(
      service.revokeRoleAssignment(
        verifiedSession,
        { organizationId: id(2) },
        { roleAssignmentId: id(30), expectedAssignmentRevision: 2 },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: {
        assignment: { roleAssignmentId: id(30).toUpperCase(), revision: 3, state: "revoked" },
        accessVersion: 8,
      },
    });
    expect(calls[0]?.text).toContain("revoke_organization_role_assignment_for_administration");
    expect(calls[0]?.values).toEqual([id(30), 2, id(21)]);
  });

  it("refuses malformed or mismatched role-assignment revocation evidence", async () => {
    const malformed = serviceFor([]);
    await expect(
      malformed.service.revokeRoleAssignment(
        verifiedSession,
        { organizationId: id(2) },
        { roleAssignmentId: id(30), expectedAssignmentRevision: 0 },
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(malformed.calls).toHaveLength(0);
    const mismatched = serviceFor([
      {
        organization_id: id(2),
        assignment_summary: {
          roleAssignmentId: id(99),
          role: { roleId: id(31), key: "reviewer", label: "Reviewer", lifecycle: "active" },
          assignee: {
            kind: "organization_account",
            organizationAccountId: id(32),
            displayName: "Reviewer",
          },
          assignmentKind: "standing",
          revision: 3,
          startsAt: "2026-09-01T00:00:00.000Z",
          state: "revoked",
          temporalState: "revoked",
        },
        access_version: 8,
      },
    ]).service;
    await expect(
      mismatched.revokeRoleAssignment(
        verifiedSession,
        { organizationId: id(2) },
        { roleAssignmentId: id(30), expectedAssignmentRevision: 2 },
      ),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });
  });

  it("refuses malformed commands and mismatched changed Group evidence", async () => {
    const malformed = serviceFor([]);
    await expect(
      malformed.service.createGroup(
        verifiedSession,
        { organizationId: id(2) },
        { key: "Invalid Key", label: "Review group" },
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(malformed.calls).toHaveLength(0);

    const mismatched = serviceFor([
      {
        organization_id: id(2),
        group_summary: {
          groupId: id(99),
          key: "review_group",
          label: "Review group",
          state: "active",
          revision: 1,
        },
        access_version: 8,
      },
    ]).service;
    await expect(
      mismatched.createGroup(
        verifiedSession,
        { organizationId: id(2) },
        { key: "review_group", label: "Review group" },
      ),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });
  });

  it("lists one bounded sanitized Group page", async () => {
    const { calls, service } = serviceFor([
      {
        organization_id: id(2).toUpperCase(),
        groups: [
          {
            groupId: id(8),
            key: "review_group",
            label: "Review group",
            state: "active",
            revision: "2",
          },
        ],
        next_after_group_id: id(8),
        access_version: 7n,
      },
    ]);

    await expect(
      service.listGroups(verifiedSession, { organizationId: id(2) }, { pageSize: 25 }),
    ).resolves.toEqual({
      kind: "available",
      value: {
        groups: [
          {
            groupId: id(8),
            key: "review_group",
            label: "Review group",
            state: "active",
            revision: 2,
          },
        ],
        nextAfterGroupId: id(8),
        accessVersion: 7,
      },
    });
    expect(calls[0]?.text).toContain("list_organization_groups_for_administration");
    expect(calls[0]?.values).toEqual([null, 25]);
  });

  it("reads exact available and unavailable Group details", async () => {
    const available = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        group_summary: {
          groupId: id(8),
          key: "review_group",
          label: "Review group",
          state: "retired",
          revision: 3,
        },
        access_version: "7",
      },
    ]).service;
    await expect(
      available.readGroup(verifiedSession, { organizationId: id(2) }, { groupId: id(8) }),
    ).resolves.toMatchObject({
      kind: "available",
      value: { outcome: "available", accessVersion: 7 },
    });

    const unavailable = serviceFor([
      {
        organization_id: id(2),
        outcome: "unavailable",
        group_summary: null,
        access_version: 7,
      },
    ]).service;
    await expect(
      unavailable.readGroup(verifiedSession, { organizationId: id(2) }, { groupId: id(99) }),
    ).resolves.toEqual({
      kind: "available",
      value: { outcome: "unavailable", accessVersion: 7 },
    });
  });

  it("refuses malformed commands and mismatched database scope evidence", async () => {
    const malformed = serviceFor([]);
    await expect(
      malformed.service.listGroups(verifiedSession, { organizationId: id(2) }, { pageSize: 101 }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(malformed.calls).toHaveLength(0);

    const mismatched = serviceFor([
      {
        organization_id: id(99),
        groups: [],
        next_after_group_id: null,
        access_version: 7,
      },
    ]).service;
    await expect(
      mismatched.listGroups(verifiedSession, { organizationId: id(2) }, { pageSize: 10 }),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });
  });

  it("lists one bounded membership page and binds its Group and Access scope", async () => {
    const { calls, service } = serviceFor([
      {
        organization_id: id(2).toUpperCase(),
        group_id: id(8).toUpperCase(),
        memberships: [
          {
            membershipId: id(9),
            groupId: id(8),
            organizationAccountId: id(10),
            accountDisplayName: "Neutral member",
            revision: "2",
            startsAt: "2026-09-06T00:00:00.000Z",
            state: "live",
            temporalState: "active",
          },
        ],
        next_after_membership_id: id(9),
        access_version: 7n,
      },
    ]);

    await expect(
      service.listGroupMemberships(
        verifiedSession,
        { organizationId: id(2) },
        { groupId: id(8), pageSize: 20 },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: {
        groupId: id(8).toUpperCase(),
        nextAfterMembershipId: id(9),
        accessVersion: 7,
        memberships: [{ membershipId: id(9), revision: 2, temporalState: "active" }],
      },
    });
    expect(calls[0]?.text).toContain("list_organization_group_memberships_for_administration");
    expect(calls[0]?.values).toEqual([id(8), null, 20]);
  });

  it("reads exact available and unavailable membership details", async () => {
    const membership = {
      membershipId: id(9),
      groupId: id(8),
      organizationAccountId: id(10),
      accountDisplayName: "Neutral member",
      revision: 3n,
      startsAt: "2026-09-06T00:00:00.000Z",
      expiresAt: "2026-09-07T00:00:00.000Z",
      state: "revoked",
      temporalState: "revoked",
    };
    const available = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        membership_summary: membership,
        access_version: "7",
      },
    ]).service;
    await expect(
      available.readGroupMembership(
        verifiedSession,
        { organizationId: id(2) },
        { membershipId: id(9) },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { outcome: "available", membership: { revision: 3 }, accessVersion: 7 },
    });

    const unavailable = serviceFor([
      {
        organization_id: id(2),
        outcome: "unavailable",
        membership_summary: null,
        access_version: 7,
      },
    ]).service;
    await expect(
      unavailable.readGroupMembership(
        verifiedSession,
        { organizationId: id(2) },
        { membershipId: id(99) },
      ),
    ).resolves.toEqual({
      kind: "available",
      value: { outcome: "unavailable", accessVersion: 7 },
    });
  });

  it("refuses malformed membership commands and mismatched Group evidence", async () => {
    const malformed = serviceFor([]);
    await expect(
      malformed.service.listGroupMemberships(
        verifiedSession,
        { organizationId: id(2) },
        { groupId: id(8), pageSize: 101 },
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(malformed.calls).toHaveLength(0);

    const mismatched = serviceFor([
      {
        organization_id: id(2),
        group_id: id(99),
        memberships: [],
        next_after_membership_id: null,
        access_version: 7,
      },
    ]).service;
    await expect(
      mismatched.listGroupMemberships(
        verifiedSession,
        { organizationId: id(2) },
        { groupId: id(8), pageSize: 10 },
      ),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });
  });

  it("lists a bounded safe permission page with its complete contextual cursor", async () => {
    const reference = {
      applicationRootId: id(30),
      ownerKind: "module" as const,
      ownerId: id(31),
      permissionId: id(32),
    };
    const permission = {
      reference,
      key: "review.records.read",
      label: "Read review records",
      description: "Read review records in the selected application.",
      recordTypeId: id(33),
      action: { actionKind: "read" },
      administrative: false,
    };
    const { calls, service } = serviceFor([
      {
        organization_id: id(2).toUpperCase(),
        permissions: [permission],
        next_after_application_root_id: id(30).toUpperCase(),
        next_after_owner_kind: "module",
        next_after_owner_id: id(31).toUpperCase(),
        next_after_permission_id: id(32).toUpperCase(),
        access_version: "7",
      },
    ]);

    await expect(
      service.listPermissions(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 10, after: reference },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { permissions: [permission], nextAfter: { ownerKind: "module" }, accessVersion: 7 },
    });
    expect(calls[0]?.text).toContain("list_organization_permissions_for_administration");
    expect(calls[0]?.values).toEqual([id(30), "module", id(31), id(32), 10]);
  });

  it("reads an exact permission and binds its contextual identity", async () => {
    const reference = {
      ownerKind: "platform" as const,
      ownerId: id(40),
      permissionId: id(41),
    };
    const permission = {
      reference: {
        ownerKind: "platform",
        ownerId: id(40).toUpperCase(),
        permissionId: id(41).toUpperCase(),
      },
      key: "platform.records.read",
      label: "Read records",
      description: "Read records.",
      action: { actionKind: "read" },
      administrative: true,
    };
    const { calls, service } = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        permission_summary: permission,
        access_version: 7n,
      },
    ]);

    await expect(
      service.readPermission(verifiedSession, { organizationId: id(2) }, { reference }),
    ).resolves.toMatchObject({
      kind: "available",
      value: { outcome: "available", permission, accessVersion: 7 },
    });
    expect(calls[0]?.text).toContain("read_organization_permission_for_administration");
    expect(calls[0]?.values).toEqual([null, "platform", id(40), id(41)]);
  });

  it("refuses malformed permission commands and mismatched permission evidence", async () => {
    const malformed = serviceFor([]);
    await expect(
      malformed.service.listPermissions(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 101 },
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(malformed.calls).toHaveLength(0);

    const reference = {
      applicationRootId: id(30),
      ownerKind: "module" as const,
      ownerId: id(31),
      permissionId: id(32),
    };
    const mismatched = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        permission_summary: {
          reference: { ...reference, permissionId: id(99) },
          key: "review.records.read",
          label: "Read review records",
          description: "Read review records in the selected application.",
          action: { actionKind: "read" },
          administrative: false,
        },
        access_version: 7,
      },
    ]).service;
    await expect(
      mismatched.readPermission(verifiedSession, { organizationId: id(2) }, { reference }),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });

    const incompleteCursor = serviceFor([
      {
        organization_id: id(2),
        permissions: [],
        next_after_application_root_id: null,
        next_after_owner_kind: "platform",
        next_after_owner_id: null,
        next_after_permission_id: id(41),
        access_version: 7,
      },
    ]).service;
    await expect(
      incompleteCursor.listPermissions(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 10 },
      ),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });
  });

  it("lists current local roles without treating accepted configuration as effective access", async () => {
    const role = {
      roleId: id(50),
      key: "review_operator",
      label: "Review operator",
      roleKind: "application",
      lifecycle: "acceptance_required",
      liveRevision: 3,
      privilegeClassification: "privileged",
      assignmentPolicy: {
        kind: "activation_required",
        maximumActivationDurationSeconds: 3600,
        reasonRequired: true,
        recentAuthentication: { kind: "multi_factor", maximumAgeSeconds: 900 },
        independentApprovalRequired: true,
      },
      source: { kind: "application", applicationRootId: id(51), sourceRoleId: id(52) },
      acceptedPermissionCount: 1,
    };
    const { calls, service } = serviceFor([
      {
        organization_id: id(2).toUpperCase(),
        roles: [role],
        next_after_role_id: id(50).toUpperCase(),
        access_version: "7",
      },
    ]);

    await expect(
      service.listRoles(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 10, afterRoleId: id(49) },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { roles: [role], nextAfterRoleId: id(50).toUpperCase(), accessVersion: 7 },
    });
    expect(calls[0]?.text).toContain("list_organization_roles_for_administration");
    expect(calls[0]?.values).toEqual([id(49), 10]);
  });

  it("reads one exact local role and binds its accepted snapshot", async () => {
    const role = {
      roleId: id(50).toUpperCase(),
      key: "review_operator",
      label: "Review operator",
      description: "Operate reviewed records.",
      roleKind: "custom",
      lifecycle: "retired",
      liveRevision: 4,
      privilegeClassification: "standard",
      assignmentPolicy: { kind: "standing" },
      source: { kind: "custom" },
      acceptedPermissionCount: 1,
      acceptedPermissions: [
        {
          reference: { ownerKind: "platform", ownerId: id(53), permissionId: id(54) },
          key: "platform.records.read",
          label: "Read records",
          description: "Read records.",
          action: { actionKind: "read" },
          administrative: false,
        },
      ],
    };
    const { calls, service } = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        role_summary: role,
        access_version: 7n,
      },
    ]);

    await expect(
      service.readRole(verifiedSession, { organizationId: id(2) }, { roleId: id(50) }),
    ).resolves.toMatchObject({ kind: "available", value: { role, accessVersion: 7 } });
    expect(calls[0]?.text).toContain("read_organization_role_for_administration");
    expect(calls[0]?.values).toEqual([id(50)]);
  });

  it("lists and reads exact registered application role templates separately", async () => {
    const reference = { applicationRootId: id(60), sourceRoleId: id(61) };
    const template = {
      reference,
      key: "review_operator",
      label: "Review operator",
      permissionSelectionKind: "exact",
      publishedPermissionKeys: ["review.records.read"],
    };
    const listed = serviceFor([
      {
        organization_id: id(2),
        templates: [template],
        next_after_application_root_id: id(60).toUpperCase(),
        next_after_source_role_id: id(61).toUpperCase(),
        access_version: 7,
      },
    ]);
    await expect(
      listed.service.listApplicationRoleTemplates(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 10, after: reference },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { templates: [template], nextAfter: { sourceRoleId: id(61).toUpperCase() } },
    });
    expect(listed.calls[0]?.text).toContain("list_application_role_templates_for_administration");
    expect(listed.calls[0]?.values).toEqual([id(60), id(61), 10]);

    const read = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        template_summary: {
          ...template,
          reference: {
            applicationRootId: id(60).toUpperCase(),
            sourceRoleId: id(61).toUpperCase(),
          },
        },
        access_version: 7,
      },
    ]);
    await expect(
      read.service.readApplicationRoleTemplate(
        verifiedSession,
        { organizationId: id(2) },
        { reference },
      ),
    ).resolves.toMatchObject({ kind: "available", value: { outcome: "available" } });
    expect(read.calls[0]?.values).toEqual([id(60), id(61)]);
  });

  it("refuses malformed role commands, mismatched identities and partial template cursors", async () => {
    const malformed = serviceFor([]);
    await expect(
      malformed.service.listRoles(verifiedSession, { organizationId: id(2) }, { pageSize: 101 }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(malformed.calls).toHaveLength(0);

    const mismatchedRole = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        role_summary: {
          roleId: id(99),
          key: "review_operator",
          label: "Review operator",
          description: "Operate reviewed records.",
          roleKind: "custom",
          lifecycle: "active",
          liveRevision: 1,
          privilegeClassification: "standard",
          assignmentPolicy: { kind: "standing" },
          source: { kind: "custom" },
          acceptedPermissionCount: 0,
          acceptedPermissions: [],
        },
        access_version: 7,
      },
    ]).service;
    await expect(
      mismatchedRole.readRole(verifiedSession, { organizationId: id(2) }, { roleId: id(50) }),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });

    const partialCursor = serviceFor([
      {
        organization_id: id(2),
        templates: [],
        next_after_application_root_id: id(60),
        next_after_source_role_id: null,
        access_version: 7,
      },
    ]).service;
    await expect(
      partialCursor.listApplicationRoleTemplates(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 10 },
      ),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });
  });

  it("lists role assignments through the bounded protected ledger query", async () => {
    const assignment = {
      roleAssignmentId: id(70),
      role: {
        roleId: id(71),
        key: "review_operator",
        label: "Review operator",
        lifecycle: "unavailable",
      },
      assignee: {
        kind: "organization_account",
        organizationAccountId: id(72),
        displayName: "Neutral assignee",
      },
      assignmentKind: "eligible",
      revision: "2",
      startsAt: "2026-09-06T00:00:00.000Z",
      expiresAt: "2026-10-06T00:00:00.000Z",
      state: "live",
      temporalState: "expired",
    };
    const { calls, service } = serviceFor([
      {
        organization_id: id(2).toUpperCase(),
        assignments: [assignment],
        next_after_role_assignment_id: id(70).toUpperCase(),
        access_version: "7",
      },
    ]);

    await expect(
      service.listRoleAssignments(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 10, afterRoleAssignmentId: id(69) },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: {
        assignments: [{ roleAssignmentId: id(70), revision: 2 }],
        nextAfterRoleAssignmentId: id(70).toUpperCase(),
        accessVersion: 7,
      },
    });
    expect(calls[0]?.text).toContain("list_organization_role_assignments_for_administration");
    expect(calls[0]?.values).toEqual([id(69), 10]);
  });

  it("reads one exact role assignment and refuses mismatched result identity", async () => {
    const summary = {
      roleAssignmentId: id(70).toUpperCase(),
      role: {
        roleId: id(71),
        key: "review_operator",
        label: "Review operator",
        lifecycle: "active",
      },
      assignee: {
        kind: "group",
        groupId: id(73),
        key: "reviewers",
        label: "Reviewers",
        state: "retired",
      },
      assignmentKind: "standing",
      revision: 2n,
      startsAt: "2026-09-06T00:00:00.000Z",
      state: "revoked",
      temporalState: "revoked",
    };
    const read = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        assignment_summary: summary,
        access_version: 7,
      },
    ]);
    await expect(
      read.service.readRoleAssignment(
        verifiedSession,
        { organizationId: id(2) },
        { roleAssignmentId: id(70) },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { assignment: { revision: 2, assignee: { state: "retired" } } },
    });
    expect(read.calls[0]?.values).toEqual([id(70)]);

    const mismatched = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        assignment_summary: { ...summary, roleAssignmentId: id(99) },
        access_version: 7,
      },
    ]).service;
    await expect(
      mismatched.readRoleAssignment(
        verifiedSession,
        { organizationId: id(2) },
        { roleAssignmentId: id(70) },
      ),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });
  });

  it("lists and reads delegation authority with only stripped exact scope", async () => {
    const delegation = {
      delegationAuthorityId: id(80),
      holder: {
        kind: "group",
        groupId: id(73),
        key: "reviewers",
        label: "Reviewers",
        state: "retired",
      },
      scope: {
        kind: "bounded",
        permissions: [
          {
            applicationRootId: id(81),
            ownerKind: "module",
            ownerId: id(82),
            permissionId: id(83),
          },
        ],
      },
      revision: "3",
      startsAt: "2026-09-06T00:00:00.000Z",
      state: "live",
      temporalState: "active",
    };
    const listed = serviceFor([
      {
        organization_id: id(2),
        delegations: [delegation],
        next_after_delegation_authority_id: id(80),
        access_version: 7,
      },
    ]);
    await expect(
      listed.service.listDelegationAuthorities(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 10, afterDelegationAuthorityId: id(79) },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { delegations: [{ revision: 3, scope: delegation.scope }] },
    });
    expect(listed.calls[0]?.values).toEqual([id(79), 10]);

    const read = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        delegation_summary: { ...delegation, scope: { kind: "organization_catalogue" } },
        access_version: 7n,
      },
    ]);
    await expect(
      read.service.readDelegationAuthority(
        verifiedSession,
        { organizationId: id(2) },
        { delegationAuthorityId: id(80) },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: { delegation: { scope: { kind: "organization_catalogue" } } },
    });
    expect(read.calls[0]?.text).toContain(
      "read_organization_delegation_authority_for_administration",
    );
  });

  it("refuses malformed ledger commands and mismatched delegation identity", async () => {
    const malformed = serviceFor([]);
    await expect(
      malformed.service.listRoleAssignments(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 101 },
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    await expect(
      malformed.service.listDelegationAuthorities(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 10, afterDelegationAuthorityId: "invalid" },
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(malformed.calls).toHaveLength(0);

    const mismatched = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        delegation_summary: {
          delegationAuthorityId: id(99),
          holder: {
            kind: "organization_account",
            organizationAccountId: id(72),
            displayName: "Neutral holder",
          },
          scope: { kind: "organization_catalogue" },
          revision: 1,
          startsAt: "2026-09-06T00:00:00.000Z",
          state: "live",
          temporalState: "active",
        },
        access_version: 7,
      },
    ]).service;
    await expect(
      mismatched.readDelegationAuthority(
        verifiedSession,
        { organizationId: id(2) },
        { delegationAuthorityId: id(80) },
      ),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });
  });

  it("revokes one reviewed delegation and binds the terminal result", async () => {
    const { calls, service } = serviceFor([
      {
        organization_id: id(2),
        delegation_summary: {
          delegationAuthorityId: id(80),
          holder: {
            kind: "organization_account",
            organizationAccountId: id(72),
            displayName: "Holder",
          },
          scope: { kind: "organization_catalogue" },
          revision: "4",
          startsAt: "2026-09-06T00:00:00.000Z",
          state: "revoked",
          temporalState: "revoked",
        },
        access_version: "8",
      },
    ]);
    await expect(
      service.revokeDelegationAuthority(
        verifiedSession,
        { organizationId: id(2) },
        {
          delegationAuthorityId: id(80),
          expectedDelegationRevision: 3,
        },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: {
        delegation: { delegationAuthorityId: id(80), revision: 4, state: "revoked" },
        accessVersion: 8,
      },
    });
    expect(calls[0]?.text).toContain("revoke_organization_delegation_authority_for_administration");
    expect(calls[0]?.values).toEqual([id(80), 3, id(21)]);
  });

  it("lists retained role activations through the protected assignment ledger", async () => {
    const activation = {
      roleActivationId: id(90),
      beneficiary: {
        organizationAccountId: id(72),
        displayName: "Neutral beneficiary",
      },
      role: {
        roleId: id(71),
        key: "review_operator",
        label: "Review operator",
        lifecycle: "unavailable",
      },
      revision: "2",
      historicalRoleRevision: "1",
      eligibilitySourceKind: "group",
      activatedAt: "2026-09-06T00:00:00.000Z",
      expiresAt: "2026-09-06T01:00:00.000Z",
      state: "live",
      temporalState: "expired",
    };
    const { calls, service } = serviceFor([
      {
        organization_id: id(2).toUpperCase(),
        activations: [activation],
        next_after_role_activation_id: id(90).toUpperCase(),
        access_version: "7",
      },
    ]);

    await expect(
      service.listRoleActivations(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 10, afterRoleActivationId: id(89) },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: {
        activations: [{ roleActivationId: id(90), revision: 2, historicalRoleRevision: 1 }],
        nextAfterRoleActivationId: id(90).toUpperCase(),
        accessVersion: 7,
      },
    });
    expect(calls[0]?.text).toContain("list_organization_role_activations_for_administration");
    expect(calls[0]?.values).toEqual([id(89), 10]);
  });

  it("deactivates one reviewed activation and binds the terminal result", async () => {
    const { calls, service } = serviceFor([
      {
        organization_id: id(2),
        activation_summary: {
          roleActivationId: id(90),
          beneficiary: { organizationAccountId: id(72), displayName: "Beneficiary" },
          role: {
            roleId: id(71),
            key: "review_operator",
            label: "Review operator",
            lifecycle: "active",
          },
          revision: "3",
          historicalRoleRevision: "1",
          eligibilitySourceKind: "direct",
          activatedAt: "2026-09-06T00:00:00.000Z",
          expiresAt: "2026-09-06T02:00:00.000Z",
          state: "revoked",
          temporalState: "revoked",
        },
        access_version: "8",
      },
    ]);
    await expect(
      service.deactivateRoleActivation(
        verifiedSession,
        { organizationId: id(2) },
        {
          roleActivationId: id(90),
          expectedActivationRevision: 2,
        },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: {
        activation: { roleActivationId: id(90), revision: 3, state: "revoked" },
        accessVersion: 8,
      },
    });
    expect(calls[0]?.text).toContain("deactivate_organization_role_activation_for_administration");
    expect(calls[0]?.values).toEqual([id(90), 2, id(21)]);
  });

  it("reads exact activation provenance and rejects mismatched or malformed requests", async () => {
    const detail = {
      roleActivationId: id(90).toUpperCase(),
      beneficiary: {
        organizationAccountId: id(72),
        displayName: "Neutral beneficiary",
      },
      role: {
        roleId: id(71),
        key: "review_operator",
        label: "Review operator",
        lifecycle: "retired",
      },
      revision: 2n,
      historicalRoleRevision: "1",
      eligibilitySource: {
        kind: "group",
        eligibilityAssignment: { roleAssignmentId: id(70), revision: "3" },
        originatingMembership: { membershipId: id(73), revision: 4n },
      },
      policyAtActivation: {
        maximumActivationDurationSeconds: "3600",
        reasonRequired: true,
        recentAuthentication: { kind: "multi_factor", maximumAgeSeconds: 900 },
        independentApprovalRequired: false,
      },
      activatedAt: "2026-09-06T00:00:00.000Z",
      expiresAt: "2026-09-06T01:00:00.000Z",
      state: "revoked",
      temporalState: "revoked",
    };
    const read = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        activation_summary: detail,
        access_version: 7,
      },
    ]);
    await expect(
      read.service.readRoleActivation(
        verifiedSession,
        { organizationId: id(2) },
        { roleActivationId: id(90) },
      ),
    ).resolves.toMatchObject({
      kind: "available",
      value: {
        activation: {
          revision: 2,
          historicalRoleRevision: 1,
          eligibilitySource: {
            eligibilityAssignment: { revision: 3 },
            originatingMembership: { revision: 4 },
          },
          policyAtActivation: { maximumActivationDurationSeconds: 3600 },
        },
      },
    });
    expect(read.calls[0]?.values).toEqual([id(90)]);

    const malformed = serviceFor([]);
    await expect(
      malformed.service.listRoleActivations(
        verifiedSession,
        { organizationId: id(2) },
        { pageSize: 101 },
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(malformed.calls).toHaveLength(0);

    const mismatched = serviceFor([
      {
        organization_id: id(2),
        outcome: "available",
        activation_summary: { ...detail, roleActivationId: id(99) },
        access_version: 7,
      },
    ]).service;
    await expect(
      mismatched.readRoleActivation(
        verifiedSession,
        { organizationId: id(2) },
        { roleActivationId: id(90) },
      ),
    ).resolves.toEqual({ kind: "temporarily_unavailable" });
  });
});
