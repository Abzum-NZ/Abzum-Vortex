import {
  createOrganizationInvitationWithAccessIntentCommandSchema,
  createOrganizationInvitationWithAccessIntentResultSchema,
  organizationInvitationAccessAcceptanceResultSchema,
  organizationInvitationAccessIntentCandidateSchema,
} from "../src/organization-invitation-access";
import { describe, expect, it } from "vitest";

const id = (prefix: string, suffix: number): string =>
  `${prefix}5000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T05:${String(minute).padStart(2, "0")}:00.000Z`;

const intent = () => ({
  membershipIntents: [{ membershipId: id("a", 1), groupId: id("b", 2), startsAt: instant(1) }],
  roleAssignmentIntents: [
    {
      roleAssignmentId: id("c", 3),
      roleId: id("d", 4),
      expectedRoleRevision: 2,
      assignmentKind: "standing" as const,
      startsAt: instant(1),
      expiresAt: instant(20),
    },
  ],
});

const account = () => ({
  organizationAccountId: id("e", 5),
  organizationId: id("f", 6),
  identityId: id("a", 7),
  state: "active" as const,
  invitationId: id("b", 8),
  activatedAt: instant(5),
  changedAt: instant(5),
  stateChangedAt: instant(5),
  stateChangedBy: id("c", 9),
  stateChangeCorrelationId: id("d", 10),
  revision: 1,
});

describe("organization invitation access contracts", () => {
  it("accepts a nonempty exact membership and direct-role intent without a beneficiary", () => {
    const parsed = createOrganizationInvitationWithAccessIntentCommandSchema.parse({
      operation: "create_organization_invitation_with_access_intent",
      invitedEmail: "person@example.test",
      expiresAt: instant(30),
      accessIntent: intent(),
    });
    expect(parsed.accessIntent).toEqual(intent());
    expect(JSON.stringify(parsed)).not.toContain("organizationAccountId");
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  it("requires a combined nonempty intent and fixed ordered windows", () => {
    expect(
      organizationInvitationAccessIntentCandidateSchema.safeParse({
        membershipIntents: [],
        roleAssignmentIntents: [],
      }).success,
    ).toBe(false);
    expect(
      organizationInvitationAccessIntentCandidateSchema.safeParse({
        ...intent(),
        membershipIntents: [{ ...intent().membershipIntents[0], expiresAt: instant(1) }],
      }).success,
    ).toBe(false);
  });

  it("requires canonical unique identities and safe reviewed role revisions", () => {
    const duplicate = intent().membershipIntents[0]!;
    expect(
      organizationInvitationAccessIntentCandidateSchema.safeParse({
        ...intent(),
        membershipIntents: [
          duplicate,
          { ...duplicate, membershipId: duplicate.membershipId.toUpperCase() },
        ],
      }).success,
    ).toBe(false);
    expect(
      organizationInvitationAccessIntentCandidateSchema.safeParse({
        ...intent(),
        membershipIntents: [
          intent().membershipIntents[0],
          {
            ...intent().membershipIntents[0],
            membershipId: id("b", 20),
            groupId: intent().membershipIntents[0]!.groupId.toUpperCase(),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      organizationInvitationAccessIntentCandidateSchema.safeParse({
        ...intent(),
        roleAssignmentIntents: [
          {
            ...intent().roleAssignmentIntents[0],
            expectedRoleRevision: Number.MAX_SAFE_INTEGER + 1,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("binds created invitation and immutable intent without copying email or secret", () => {
    const invitation = {
      invitationId: id("b", 8),
      organizationId: id("f", 6),
      invitedEmail: "person@example.test",
      invitedBy: id("e", 5),
      createdAt: instant(1),
      invitedAt: instant(1),
      expiresAt: instant(30),
      changedAt: instant(1),
      revision: 1,
    };
    const accessIntent = {
      organizationId: id("f", 6),
      invitationId: id("b", 8),
      ...intent(),
      intendedByOrganizationAccountId: id("e", 5),
      intendedAt: instant(1),
      intentCorrelationId: id("f", 11),
    };
    expect(
      createOrganizationInvitationWithAccessIntentResultSchema.safeParse({
        invitation,
        accessIntent,
      }).success,
    ).toBe(true);
    expect(
      createOrganizationInvitationWithAccessIntentResultSchema.safeParse({
        invitation,
        accessIntent: { ...accessIntent, invitationId: id("a", 90) },
      }).success,
    ).toBe(false);
  });

  it.each(["accepted", "already_accepted"] as const)(
    "returns %s with exact original linkage and current Access",
    (outcome) => {
      expect(
        organizationInvitationAccessAcceptanceResultSchema.safeParse({
          outcome,
          account: account(),
          invitationId: id("b", 8),
          membershipIds: [id("a", 1)],
          roleAssignmentIds: [id("c", 3)],
          accessVersion: 4,
          correlationId: id("d", 10),
        }).success,
      ).toBe(true);
    },
  );

  it("keeps refusal outcomes closed and prevents empty or mismatched accepted linkage", () => {
    expect(
      organizationInvitationAccessAcceptanceResultSchema.safeParse({ outcome: "unavailable" })
        .success,
    ).toBe(true);
    expect(
      organizationInvitationAccessAcceptanceResultSchema.safeParse({
        outcome: "unavailable",
        invitationId: id("b", 8),
      }).success,
    ).toBe(false);
    expect(
      organizationInvitationAccessAcceptanceResultSchema.safeParse({
        outcome: "accepted",
        account: account(),
        invitationId: id("a", 99),
        membershipIds: [],
        roleAssignmentIds: [],
        accessVersion: 4,
        correlationId: id("d", 10),
      }).success,
    ).toBe(false);
  });

  it("rejects delegation, Group-role assignment and copied authority fields", () => {
    expect(
      organizationInvitationAccessIntentCandidateSchema.safeParse({
        ...intent(),
        delegationAuthorityId: id("e", 12),
      }).success,
    ).toBe(false);
    expect(
      organizationInvitationAccessIntentCandidateSchema.safeParse({
        ...intent(),
        roleAssignmentIntents: [{ ...intent().roleAssignmentIntents[0], groupId: id("f", 13) }],
      }).success,
    ).toBe(false);
  });
});
