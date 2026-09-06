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
});
