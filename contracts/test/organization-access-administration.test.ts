import { describe, expect, it } from "vitest";
import {
  listOrganizationAdministrationGroupsCommandSchema,
  listOrganizationAdministrationGroupsResultSchema,
  organizationAdministrationGroupSchema,
  readOrganizationAdministrationGroupResultSchema,
} from "../src/organization-access-administration";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const group = {
  groupId: id(1),
  key: "review_group",
  label: "Review group",
  state: "active" as const,
  revision: 2,
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
});
