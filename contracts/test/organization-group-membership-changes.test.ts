import {
  organizationGroupMembershipChangeCommandSchema,
  organizationGroupMembershipChangeResultSchema,
} from "../src/organization-group-membership-changes";
import { describe, expect, it } from "vitest";

const id = (suffix: number): string =>
  `a1000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T01:${String(minute).padStart(2, "0")}:00.000Z`;

const addCommand = () => ({
  operation: "add_membership" as const,
  organizationId: id(1),
  membershipId: id(2),
  groupId: id(3),
  organizationAccountId: id(4),
  startsAt: instant(1),
  expiresAt: instant(20),
  changedBy: id(5),
  correlationId: id(6),
});

const liveMembership = () => ({
  membershipId: id(2),
  organizationId: id(1),
  groupId: id(3),
  organizationAccountId: id(4),
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
});

const revokedMembership = () => ({
  ...liveMembership(),
  revision: 2,
  state: "revoked" as const,
  changedAt: instant(3),
  changeCorrelationId: id(7),
  changedByActorId: id(8),
  revokedByActorId: id(8),
  revokedAt: instant(3),
  revocationCorrelationId: id(7),
});

describe("organization Group-membership change contracts", () => {
  it("accepts the four exact commands", () => {
    expect(organizationGroupMembershipChangeCommandSchema.safeParse(addCommand()).success).toBe(
      true,
    );
    expect(
      organizationGroupMembershipChangeCommandSchema.safeParse({
        operation: "remove_membership",
        organizationId: id(1),
        membershipId: id(2),
        expectedMembershipRevision: 1,
        changedBy: id(8),
        correlationId: id(7),
      }).success,
    ).toBe(true);
    expect(
      organizationGroupMembershipChangeCommandSchema.safeParse({
        operation: "restore_membership",
        organizationId: id(1),
        membershipId: id(2),
        expectedMembershipRevision: 2,
        changedBy: id(9),
        correlationId: id(10),
      }).success,
    ).toBe(true);
    expect(
      organizationGroupMembershipChangeCommandSchema.safeParse({
        operation: "renew_membership",
        organizationId: id(1),
        membershipId: id(2),
        expectedMembershipRevision: 1,
        replacementMembershipId: id(11),
        startsAt: instant(21),
        changedBy: id(9),
        correlationId: id(10),
      }).success,
    ).toBe(true);
  });

  it.each([
    ["unknown operation", { ...addCommand(), operation: "suspend_membership" }],
    ["extraneous expected revision", { ...addCommand(), expectedMembershipRevision: 1 }],
    ["nil membership", { ...addCommand(), membershipId: "00000000-0000-0000-0000-000000000000" }],
    ["reversed window", { ...addCommand(), expiresAt: instant(1) }],
    ["caller timestamp", { ...addCommand(), changedAt: instant(2) }],
    ["caller authority", { ...addCommand(), authorized: true }],
    [
      "unsafe transition revision",
      {
        operation: "remove_membership",
        organizationId: id(1),
        membershipId: id(2),
        expectedMembershipRevision: Number.MAX_SAFE_INTEGER + 1,
        changedBy: id(8),
        correlationId: id(7),
      },
    ],
    [
      "remove window",
      {
        operation: "remove_membership",
        organizationId: id(1),
        membershipId: id(2),
        expectedMembershipRevision: 1,
        startsAt: instant(2),
        changedBy: id(8),
        correlationId: id(7),
      },
    ],
    [
      "same renewal identity",
      {
        operation: "renew_membership",
        organizationId: id(1),
        membershipId: id(2).toUpperCase(),
        expectedMembershipRevision: 1,
        replacementMembershipId: id(2),
        startsAt: instant(21),
        changedBy: id(9),
        correlationId: id(10),
      },
    ],
  ])("refuses %s", (_name, candidate) => {
    expect(organizationGroupMembershipChangeCommandSchema.safeParse(candidate).success).toBe(false);
  });

  it("accepts exact add, remove and restore results", () => {
    expect(
      organizationGroupMembershipChangeResultSchema.safeParse({
        outcome: "changed",
        operation: "add_membership",
        membership: liveMembership(),
        accessVersion: 2,
        correlationId: id(6),
      }).success,
    ).toBe(true);
    expect(
      organizationGroupMembershipChangeResultSchema.safeParse({
        outcome: "changed",
        operation: "remove_membership",
        membership: revokedMembership(),
        accessVersion: 3,
        correlationId: id(7),
      }).success,
    ).toBe(true);
    expect(
      organizationGroupMembershipChangeResultSchema.safeParse({
        outcome: "changed",
        operation: "restore_membership",
        membership: {
          ...liveMembership(),
          revision: 3,
          changedByActorId: id(9),
          changedAt: instant(4),
          changeCorrelationId: id(10),
        },
        accessVersion: 4,
        correlationId: id(10),
      }).success,
    ).toBe(true);
  });

  it("requires one exact closed predecessor and distinct live grant for renewal", () => {
    const renewed = {
      outcome: "changed" as const,
      operation: "renew_membership" as const,
      membership: {
        ...liveMembership(),
        membershipId: id(11),
        startsAt: instant(21),
        expiresAt: undefined,
        grantedByActorId: id(9),
        grantedAt: instant(30),
        grantCorrelationId: id(10),
        changedByActorId: id(9),
        changedAt: instant(30),
        changeCorrelationId: id(10),
      },
      closedPredecessor: {
        ...revokedMembership(),
        changedByActorId: id(9),
        changedAt: instant(31),
        changeCorrelationId: id(10),
        revokedByActorId: id(9),
        revokedAt: instant(31),
        revocationCorrelationId: id(10),
      },
      accessVersion: 5,
      correlationId: id(10),
    };
    expect(organizationGroupMembershipChangeResultSchema.safeParse(renewed).success).toBe(true);
    expect(
      organizationGroupMembershipChangeResultSchema.safeParse({
        ...renewed,
        closedPredecessor: { ...renewed.closedPredecessor, groupId: id(99) },
      }).success,
    ).toBe(false);
    expect(
      organizationGroupMembershipChangeResultSchema.safeParse({
        ...renewed,
        closedPredecessor: {
          ...renewed.closedPredecessor,
          changeCorrelationId: id(99),
        },
      }).success,
    ).toBe(false);
    expect(
      organizationGroupMembershipChangeResultSchema.safeParse({
        ...renewed,
        closedPredecessor: { ...renewed.closedPredecessor, changedAt: instant(29) },
      }).success,
    ).toBe(false);
    expect(
      organizationGroupMembershipChangeResultSchema.safeParse({
        ...renewed,
        closedPredecessor: undefined,
      }).success,
    ).toBe(false);
  });

  it("refuses operation-incoherent result evidence", () => {
    const added = {
      outcome: "changed",
      operation: "add_membership",
      membership: liveMembership(),
      accessVersion: 2,
      correlationId: id(6),
    };
    expect(
      organizationGroupMembershipChangeResultSchema.safeParse({
        ...added,
        membership: { ...liveMembership(), revision: 2 },
      }).success,
    ).toBe(false);
    expect(
      organizationGroupMembershipChangeResultSchema.safeParse({
        ...added,
        closedPredecessor: revokedMembership(),
      }).success,
    ).toBe(false);
    expect(
      organizationGroupMembershipChangeResultSchema.safeParse({
        ...added,
        correlationId: id(99),
      }).success,
    ).toBe(false);
  });
});
