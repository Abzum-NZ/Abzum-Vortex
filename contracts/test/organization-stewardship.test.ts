import {
  organizationStewardshipAdoptionCommandSchema,
  organizationStewardshipAdoptionResultSchema,
  organizationStewardshipRequirementSchema,
} from "../src/organization-stewardship";
import { describe, expect, it } from "vitest";

const id = (prefix: string, suffix: number): string =>
  `${prefix}1000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T03:${String(minute).padStart(2, "0")}:00.000Z`;

const command = () => ({
  operation: "adopt_organization_stewardship" as const,
  organizationId: id("a", 1),
  organizationAccountId: id("b", 2),
  roleId: id("c", 3),
  roleKey: "organization_steward",
  roleLabel: "Organisation steward",
  roleDescription: "Permanent minimum organisation administration.",
  roleAssignmentId: id("d", 4),
  delegationAuthorityId: id("e", 5),
  changedBy: id("f", 6),
  correlationId: id("a", 7),
});

const requirement = () => ({
  organizationId: id("a", 1),
  revision: 1,
  originalOrganizationAccountId: id("b", 2),
  originalRoleId: id("c", 3),
  originalRoleAssignmentId: id("d", 4),
  originalDelegationAuthorityId: id("e", 5),
  adoptedByActorId: id("f", 6),
  adoptedAt: instant(1),
  adoptionCorrelationId: id("a", 7),
  changedByActorId: id("f", 6),
  changedAt: instant(1),
  changeCorrelationId: id("a", 7),
});

describe("organization stewardship contracts", () => {
  it("accepts only the bounded trusted adoption command", () => {
    expect(organizationStewardshipAdoptionCommandSchema.safeParse(command()).success).toBe(true);
    for (const unexpected of [
      { expectedAccessVersion: 1 },
      { permissions: [] },
      { assignmentPolicy: { kind: "standing" } },
      { ownerBypass: true },
      { identityId: id("f", 8) },
      { startsAt: instant(1) },
    ])
      expect(
        organizationStewardshipAdoptionCommandSchema.safeParse({
          ...command(),
          ...unexpected,
        }).success,
      ).toBe(false);
  });

  it("requires every permanent bootstrap identity and neutral role metadata", () => {
    for (const field of [
      "organizationAccountId",
      "roleId",
      "roleKey",
      "roleLabel",
      "roleDescription",
      "roleAssignmentId",
      "delegationAuthorityId",
    ] as const) {
      const candidate = { ...command() } as Record<string, unknown>;
      delete candidate[field];
      expect(organizationStewardshipAdoptionCommandSchema.safeParse(candidate).success).toBe(false);
    }
    expect(
      organizationStewardshipAdoptionCommandSchema.safeParse({
        ...command(),
        roleId: "00000000-0000-0000-0000-000000000000",
      }).success,
    ).toBe(false);
  });

  it("accepts an exact immutable adoption requirement", () => {
    expect(organizationStewardshipRequirementSchema.parse(requirement())).toEqual(requirement());
    expect(
      organizationStewardshipRequirementSchema.safeParse({
        ...requirement(),
        changedByActorId: requirement().adoptedByActorId.toUpperCase(),
        changeCorrelationId: requirement().adoptionCorrelationId.toUpperCase(),
      }).success,
    ).toBe(true);
  });

  it("allows later requirement change evidence without rewriting adoption provenance", () => {
    expect(
      organizationStewardshipRequirementSchema.safeParse({
        ...requirement(),
        revision: 2,
        changedByActorId: id("b", 20),
        changedAt: instant(5),
        changeCorrelationId: id("c", 21),
      }).success,
    ).toBe(true);
  });

  it("rejects unsafe, backward or malformed requirement evidence", () => {
    expect(
      organizationStewardshipRequirementSchema.safeParse({
        ...requirement(),
        revision: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      organizationStewardshipRequirementSchema.safeParse({
        ...requirement(),
        revision: 2,
        changedAt: instant(0),
      }).success,
    ).toBe(false);
    expect(
      organizationStewardshipRequirementSchema.safeParse({
        ...requirement(),
        currentOwner: true,
      }).success,
    ).toBe(false);
  });

  it("requires exact revision-one adoption evidence for a new marker", () => {
    for (const override of [
      { changedByActorId: id("b", 30) },
      { changeCorrelationId: id("c", 31) },
      { changedAt: instant(2) },
    ])
      expect(
        organizationStewardshipRequirementSchema.safeParse({
          ...requirement(),
          ...override,
        }).success,
      ).toBe(false);
  });

  it("accepts truthful changed and unchanged results", () => {
    expect(
      organizationStewardshipAdoptionResultSchema.safeParse({
        outcome: "changed",
        operation: "adopt_organization_stewardship",
        requirement: requirement(),
        accessVersion: 2,
        correlationId: id("a", 7),
      }).success,
    ).toBe(true);
    expect(
      organizationStewardshipAdoptionResultSchema.safeParse({
        outcome: "unchanged",
        operation: "adopt_organization_stewardship",
        requirement: {
          ...requirement(),
          revision: 2,
          changedByActorId: id("b", 20),
          changedAt: instant(5),
          changeCorrelationId: id("c", 21),
        },
        accessVersion: 9,
        correlationId: id("a", 7),
      }).success,
    ).toBe(true);
  });

  it("rejects a changed result that is not the initial adoption", () => {
    expect(
      organizationStewardshipAdoptionResultSchema.safeParse({
        outcome: "changed",
        operation: "adopt_organization_stewardship",
        requirement: {
          ...requirement(),
          revision: 2,
          changedAt: instant(2),
        },
        accessVersion: 2,
        correlationId: id("a", 7),
      }).success,
    ).toBe(false);
  });

  it("binds every result to the immutable adoption correlation", () => {
    expect(
      organizationStewardshipAdoptionResultSchema.safeParse({
        outcome: "unchanged",
        operation: "adopt_organization_stewardship",
        requirement: requirement(),
        accessVersion: 2,
        correlationId: id("f", 99),
      }).success,
    ).toBe(false);
  });
});
