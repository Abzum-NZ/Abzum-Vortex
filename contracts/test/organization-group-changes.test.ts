import {
  organizationGroupChangeCommandSchema,
  organizationGroupChangeResultSchema,
} from "../src/organization-group-changes";
import { describe, expect, it } from "vitest";

const id = (suffix: number): string =>
  `a0000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T00:${String(minute).padStart(2, "0")}:00.000Z`;

const create = () => ({
  operation: "create_group" as const,
  organizationId: id(1),
  groupId: id(2),
  key: "review_group",
  label: "Review Group",
  changedBy: id(3),
  correlationId: id(4),
});

const createdResult = () => ({
  outcome: "changed" as const,
  operation: "create_group" as const,
  group: {
    groupId: id(2),
    organizationId: id(1),
    key: "review_group",
    label: "Review Group",
    state: "active" as const,
    revision: 1,
    createdByActorId: id(3),
    createdAt: instant(1),
    changedByActorId: id(3),
    changedAt: instant(1),
    changeCorrelationId: id(4),
  },
  accessVersion: 2,
  correlationId: id(4),
});

describe("organization Group change contracts", () => {
  it("accepts the three exact change commands", () => {
    expect(organizationGroupChangeCommandSchema.safeParse(create()).success).toBe(true);
    expect(
      organizationGroupChangeCommandSchema.safeParse({
        operation: "revise_group_label",
        organizationId: id(1),
        groupId: id(2),
        expectedGroupRevision: 1,
        label: "Renamed Group",
        changedBy: id(3),
        correlationId: id(5),
      }).success,
    ).toBe(true);
    expect(
      organizationGroupChangeCommandSchema.safeParse({
        operation: "retire_group",
        organizationId: id(1),
        groupId: id(2),
        expectedGroupRevision: 2,
        changedBy: id(3),
        correlationId: id(6),
      }).success,
    ).toBe(true);
  });

  it.each([
    ["unknown operation", { ...create(), operation: "restore_group" }],
    ["extraneous create revision", { ...create(), expectedGroupRevision: 1 }],
    ["nil Group", { ...create(), groupId: "00000000-0000-0000-0000-000000000000" }],
    ["invalid key", { ...create(), key: "Review Group" }],
    ["blank label", { ...create(), label: " " }],
    [
      "missing label revision",
      {
        operation: "revise_group_label",
        organizationId: id(1),
        groupId: id(2),
        expectedGroupRevision: 1,
        changedBy: id(3),
        correlationId: id(5),
      },
    ],
    [
      "unsafe revision",
      {
        operation: "retire_group",
        organizationId: id(1),
        groupId: id(2),
        expectedGroupRevision: Number.MAX_SAFE_INTEGER + 1,
        changedBy: id(3),
        correlationId: id(6),
      },
    ],
    [
      "retirement label",
      {
        operation: "retire_group",
        organizationId: id(1),
        groupId: id(2),
        expectedGroupRevision: 2,
        label: "Unexpected",
        changedBy: id(3),
        correlationId: id(6),
      },
    ],
    ["caller timestamp", { ...create(), changedAt: instant(2) }],
    ["membership payload", { ...create(), membershipIds: [id(8)] }],
    ["authority flag", { ...create(), authorized: true }],
  ])("refuses %s", (_name, candidate) => {
    expect(organizationGroupChangeCommandSchema.safeParse(candidate).success).toBe(false);
  });

  it("accepts only complete operation-coherent results", () => {
    expect(organizationGroupChangeResultSchema.safeParse(createdResult()).success).toBe(true);
    expect(
      organizationGroupChangeResultSchema.safeParse({
        ...createdResult(),
        group: { ...createdResult().group, createdAt: "2026-09-06T12:01:00+12:00" },
      }).success,
    ).toBe(true);
    expect(
      organizationGroupChangeResultSchema.safeParse({
        ...createdResult(),
        group: { ...createdResult().group, createdAt: instant(2) },
      }).success,
    ).toBe(false);
    expect(
      organizationGroupChangeResultSchema.safeParse({
        ...createdResult(),
        correlationId: id(9),
      }).success,
    ).toBe(false);
  });

  it("requires active label successors and terminal retirement successors", () => {
    const revised = {
      ...createdResult(),
      operation: "revise_group_label",
      group: { ...createdResult().group, revision: 2, label: "Renamed Group" },
    };
    expect(organizationGroupChangeResultSchema.safeParse(revised).success).toBe(true);
    expect(
      organizationGroupChangeResultSchema.safeParse({
        ...revised,
        group: { ...revised.group, state: "retired" },
      }).success,
    ).toBe(false);

    const retired = {
      ...createdResult(),
      operation: "retire_group",
      group: { ...createdResult().group, revision: 2, state: "retired" },
    };
    expect(organizationGroupChangeResultSchema.safeParse(retired).success).toBe(true);
    expect(
      organizationGroupChangeResultSchema.safeParse({
        ...retired,
        group: { ...retired.group, state: "active" },
      }).success,
    ).toBe(false);
    expect(
      organizationGroupChangeResultSchema.safeParse({ ...retired, accessVersion: 0 }).success,
    ).toBe(false);
  });
});
