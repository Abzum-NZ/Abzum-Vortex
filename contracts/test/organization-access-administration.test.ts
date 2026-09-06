import { describe, expect, it } from "vitest";
import {
  listOrganizationAdministrationGroupsCommandSchema,
  listOrganizationAdministrationGroupsResultSchema,
  listOrganizationAdministrationMembershipsCommandSchema,
  listOrganizationAdministrationMembershipsResultSchema,
  organizationAdministrationGroupSchema,
  organizationAdministrationMembershipSchema,
  readOrganizationAdministrationGroupResultSchema,
  readOrganizationAdministrationMembershipResultSchema,
} from "../src/organization-access-administration";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const group = {
  groupId: id(1),
  key: "review_group",
  label: "Review group",
  state: "active" as const,
  revision: 2,
};

const membership = {
  membershipId: id(10),
  groupId: id(1),
  organizationAccountId: id(11),
  accountDisplayName: "Neutral member",
  revision: 2,
  startsAt: "2026-09-06T00:00:00.000Z",
  expiresAt: "2026-10-06T00:00:00.000Z",
  state: "live" as const,
  temporalState: "active" as const,
};

describe("organization Access administration contracts", () => {
  it("accepts a bounded Group page and exact detail outcomes", () => {
    expect(
      listOrganizationAdministrationGroupsCommandSchema.parse({
        pageSize: 25,
        afterGroupId: id(2).toUpperCase(),
      }),
    ).toMatchObject({ pageSize: 25 });
    expect(
      listOrganizationAdministrationGroupsResultSchema.parse({
        groups: [group],
        nextAfterGroupId: id(3),
        accessVersion: 7,
      }),
    ).toMatchObject({ groups: [group], accessVersion: 7 });
    expect(
      readOrganizationAdministrationGroupResultSchema.parse({
        outcome: "available",
        group,
        accessVersion: 7,
      }),
    ).toMatchObject({ outcome: "available", group });
    expect(
      readOrganizationAdministrationGroupResultSchema.parse({
        outcome: "unavailable",
        accessVersion: 7,
      }),
    ).toEqual({ outcome: "unavailable", accessVersion: 7 });
  });

  it("refuses unbounded pages, unsafe revisions and leaked stored evidence", () => {
    for (const candidate of [
      { pageSize: 0 },
      { pageSize: 101 },
      { pageSize: 10, extra: true },
      { pageSize: 10, afterGroupId: "not-a-uuid" },
    ])
      expect(listOrganizationAdministrationGroupsCommandSchema.safeParse(candidate).success).toBe(
        false,
      );

    expect(
      organizationAdministrationGroupSchema.safeParse({
        ...group,
        revision: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      organizationAdministrationGroupSchema.safeParse({
        ...group,
        changedByActorId: id(4),
        changeCorrelationId: id(5),
      }).success,
    ).toBe(false);
  });

  it("keeps available and unavailable detail shapes closed", () => {
    expect(
      readOrganizationAdministrationGroupResultSchema.safeParse({
        outcome: "available",
        accessVersion: 7,
      }).success,
    ).toBe(false);
    expect(
      readOrganizationAdministrationGroupResultSchema.safeParse({
        outcome: "unavailable",
        group,
        accessVersion: 7,
      }).success,
    ).toBe(false);
  });

  it("accepts bounded Group membership pages and exact detail outcomes", () => {
    expect(
      listOrganizationAdministrationMembershipsCommandSchema.parse({
        groupId: id(1),
        pageSize: 25,
        afterMembershipId: id(9).toUpperCase(),
      }),
    ).toMatchObject({ groupId: id(1), pageSize: 25 });
    expect(
      listOrganizationAdministrationMembershipsResultSchema.parse({
        groupId: id(1),
        memberships: [membership],
        nextAfterMembershipId: id(10),
        accessVersion: 8,
      }),
    ).toMatchObject({ memberships: [membership], accessVersion: 8 });
    expect(
      readOrganizationAdministrationMembershipResultSchema.parse({
        outcome: "available",
        membership,
        accessVersion: 8,
      }),
    ).toMatchObject({ outcome: "available", membership });
    expect(
      readOrganizationAdministrationMembershipResultSchema.parse({
        outcome: "unavailable",
        accessVersion: 8,
      }),
    ).toEqual({ outcome: "unavailable", accessVersion: 8 });
  });

  it("keeps membership input, temporal state and safe projection closed", () => {
    for (const candidate of [
      { groupId: id(1), pageSize: 0 },
      { groupId: id(1), pageSize: 101 },
      { groupId: id(1), pageSize: 10, afterMembershipId: "not-a-uuid" },
      { groupId: id(1), pageSize: 10, extra: true },
    ])
      expect(
        listOrganizationAdministrationMembershipsCommandSchema.safeParse(candidate).success,
      ).toBe(false);

    for (const candidate of [
      { ...membership, temporalState: "revoked" },
      { ...membership, state: "revoked" },
      { ...membership, expiresAt: membership.startsAt },
      { ...membership, grantedByActorId: id(12) },
      { ...membership, revision: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(organizationAdministrationMembershipSchema.safeParse(candidate).success).toBe(false);

    expect(
      readOrganizationAdministrationMembershipResultSchema.safeParse({
        outcome: "available",
        accessVersion: 8,
      }).success,
    ).toBe(false);
    expect(
      readOrganizationAdministrationMembershipResultSchema.safeParse({
        outcome: "unavailable",
        membership,
        accessVersion: 8,
      }).success,
    ).toBe(false);
  });
});
