import {
  organizationRoleAssignmentChangeCommandSchema,
  organizationRoleAssignmentChangeResultSchema,
} from "../src/organization-role-assignment-changes";
import { describe, expect, it } from "vitest";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T00:${String(minute).padStart(2, "0")}:00.000Z`;

const grant = () => ({
  operation: "grant" as const,
  organizationId: id(1),
  roleAssignmentId: id(2),
  roleId: id(3),
  expectedRoleRevision: 7,
  assignee: { kind: "organization_account" as const, organizationAccountId: id(4) },
  assignmentKind: "standing" as const,
  startsAt: instant(1),
  expiresAt: instant(20),
  changedBy: id(5),
  correlationId: id(6),
});

const result = () => ({
  outcome: "changed" as const,
  operation: "grant" as const,
  assignment: {
    roleAssignmentId: id(2),
    organizationId: id(1),
    roleId: id(3),
    assignee: { kind: "organization_account" as const, organizationAccountId: id(4) },
    assignmentKind: "standing" as const,
    revision: 1,
    startsAt: instant(1),
    expiresAt: instant(20),
    state: "live" as const,
    grantedByActorId: id(5),
    grantedAt: instant(2),
    grantCorrelationId: id(6),
    changedByActorId: id(5),
    changedAt: instant(2),
    changeCorrelationId: id(6),
  },
  accessVersion: 9,
  correlationId: id(6),
});

describe("organization role-assignment change contracts", () => {
  it.each([
    [
      "account standing",
      { kind: "organization_account", organizationAccountId: id(4) },
      "standing",
    ],
    [
      "account eligible",
      { kind: "organization_account", organizationAccountId: id(4) },
      "eligible",
    ],
    ["Group standing", { kind: "group", groupId: id(7) }, "standing"],
    ["Group eligible", { kind: "group", groupId: id(7) }, "eligible"],
  ] as const)("accepts an exact %s grant", (_name, assignee, assignmentKind) => {
    expect(
      organizationRoleAssignmentChangeCommandSchema.safeParse({
        ...grant(),
        assignee,
        assignmentKind,
      }).success,
    ).toBe(true);
  });

  it("accepts scheduled and permanent fixed windows", () => {
    expect(
      organizationRoleAssignmentChangeCommandSchema.safeParse({
        ...grant(),
        startsAt: instant(30),
        expiresAt: instant(40),
      }).success,
    ).toBe(true);
    const permanent = grant();
    delete (permanent as Partial<typeof permanent>).expiresAt;
    expect(organizationRoleAssignmentChangeCommandSchema.safeParse(permanent).success).toBe(true);
  });

  it("accepts only the narrow revision-checked revoke command", () => {
    const revoke = {
      operation: "revoke",
      organizationId: id(1),
      roleAssignmentId: id(2),
      expectedAssignmentRevision: 3,
      changedBy: id(5),
      correlationId: id(6),
    };
    expect(organizationRoleAssignmentChangeCommandSchema.safeParse(revoke).success).toBe(true);
    expect(
      organizationRoleAssignmentChangeCommandSchema.safeParse({ ...revoke, roleId: id(3) }).success,
    ).toBe(false);
    expect(
      organizationRoleAssignmentChangeCommandSchema.safeParse({
        ...revoke,
        expectedRoleRevision: 3,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["missing role review", { ...grant(), expectedRoleRevision: undefined }],
    ["unsafe role review", { ...grant(), expectedRoleRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ["zero role review", { ...grant(), expectedRoleRevision: 0 }],
    ["unknown kind", { ...grant(), assignmentKind: "temporary" }],
    [
      "mixed assignee",
      { ...grant(), assignee: { kind: "group", groupId: id(7), organizationAccountId: id(4) } },
    ],
    [
      "global identity",
      { ...grant(), assignee: { kind: "organization_account", identityId: id(4) } },
    ],
    ["caller application scope", { ...grant(), applicationRootId: id(8) }],
    ["database timestamp", { ...grant(), grantedAt: instant(2) }],
    ["reversed window", { ...grant(), startsAt: instant(20), expiresAt: instant(1) }],
    ["non-finite start", { ...grant(), startsAt: "+infinity" }],
    ["nil assignment", { ...grant(), roleAssignmentId: "00000000-0000-0000-0000-000000000000" }],
  ])("refuses %s", (_name, candidate) => {
    expect(organizationRoleAssignmentChangeCommandSchema.safeParse(candidate).success).toBe(false);
  });

  it("requires a complete strict stored-assignment result", () => {
    expect(organizationRoleAssignmentChangeResultSchema.safeParse(result()).success).toBe(true);
    expect(
      organizationRoleAssignmentChangeResultSchema.safeParse({
        ...result(),
        assignment: {
          ...result().assignment,
          grantedAt: "2026-09-06T12:02:00+12:00",
        },
      }).success,
    ).toBe(true);
    expect(
      organizationRoleAssignmentChangeResultSchema.safeParse({
        ...result(),
        assignment: { ...result().assignment, grantedAt: instant(3) },
      }).success,
    ).toBe(false);
    expect(
      organizationRoleAssignmentChangeResultSchema.safeParse({
        ...result(),
        effectiveState: "active",
      }).success,
    ).toBe(false);
    expect(
      organizationRoleAssignmentChangeResultSchema.safeParse({
        ...result(),
        assignment: { ...result().assignment, revision: 0 },
      }).success,
    ).toBe(false);
    expect(
      organizationRoleAssignmentChangeResultSchema.safeParse({
        ...result(),
        outcome: "unchanged",
      }).success,
    ).toBe(false);
  });

  it("accepts a coherent terminal revocation result and refuses partial evidence", () => {
    const revoked = {
      ...result(),
      operation: "revoke",
      correlationId: id(10),
      assignment: {
        ...result().assignment,
        revision: 2,
        state: "revoked",
        changedByActorId: id(9),
        changedAt: instant(10),
        changeCorrelationId: id(10),
        revokedByActorId: id(9),
        revokedAt: instant(10),
        revocationCorrelationId: id(10),
      },
    };
    expect(organizationRoleAssignmentChangeResultSchema.safeParse(revoked).success).toBe(true);
    expect(
      organizationRoleAssignmentChangeResultSchema.safeParse({
        ...revoked,
        assignment: {
          ...revoked.assignment,
          revokedAt: "2026-09-06T12:10:00+12:00",
        },
      }).success,
    ).toBe(true);
    expect(
      organizationRoleAssignmentChangeResultSchema.safeParse({
        ...revoked,
        assignment: { ...revoked.assignment, revokedAt: instant(11) },
      }).success,
    ).toBe(false);
    expect(
      organizationRoleAssignmentChangeResultSchema.safeParse({
        ...revoked,
        assignment: { ...revoked.assignment, revocationCorrelationId: undefined },
      }).success,
    ).toBe(false);
  });
});
