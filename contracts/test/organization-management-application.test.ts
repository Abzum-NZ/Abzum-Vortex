import {
  organizationManagementApplicationRequirementChangeCommandSchema,
  organizationManagementApplicationRequirementChangeResultSchema,
  organizationManagementApplicationRequirementSchema,
} from "../src/organization-management-application";
import { organizationStewardshipRequirementSchema } from "../src/organization-stewardship";
import { describe, expect, it } from "vitest";

const id = (prefix: string, suffix: number): string =>
  `${prefix}3000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T05:${String(minute).padStart(2, "0")}:00.000Z`;

const command = (
  operation:
    | "activate_management_application_requirement"
    | "replace_management_application_requirement" = "activate_management_application_requirement",
) => ({
  operation,
  organizationId: id("a", 1),
  expectedRequirementRevision: 1,
  applicationRootId: id("b", 2),
  roleId: id("c", 3),
  expectedRoleRevision: 4,
  changedBy: id("d", 5),
  correlationId: id("e", 6),
});

const requirement = () => ({
  organizationId: id("a", 1),
  revision: 2,
  originalOrganizationAccountId: id("f", 7),
  originalRoleId: id("a", 8),
  originalRoleAssignmentId: id("b", 9),
  originalDelegationAuthorityId: id("c", 10),
  adoptedByActorId: id("d", 11),
  adoptedAt: instant(1),
  adoptionCorrelationId: id("e", 12),
  managementApplicationRootId: id("b", 2),
  managementRoleId: id("c", 3),
  requiredRoleRevision: 4,
  changedByActorId: id("d", 5),
  changedAt: instant(2),
  changeCorrelationId: id("e", 6),
});

describe("organization management-application requirement contracts", () => {
  it("accepts exactly the two changed-only revision-bound commands", () => {
    expect(
      organizationManagementApplicationRequirementChangeCommandSchema.safeParse(
        command("activate_management_application_requirement"),
      ).success,
    ).toBe(true);
    expect(
      organizationManagementApplicationRequirementChangeCommandSchema.safeParse(
        command("replace_management_application_requirement"),
      ).success,
    ).toBe(true);
    for (const operation of ["clear_management_application_requirement", "unchanged"])
      expect(
        organizationManagementApplicationRequirementChangeCommandSchema.safeParse({
          ...command(),
          operation,
        }).success,
      ).toBe(false);
  });

  it("requires every exact target and current revision without extra authority fields", () => {
    for (const field of [
      "organizationId",
      "expectedRequirementRevision",
      "applicationRootId",
      "roleId",
      "expectedRoleRevision",
      "changedBy",
      "correlationId",
    ] as const) {
      const candidate = { ...command() } as Record<string, unknown>;
      delete candidate[field];
      expect(
        organizationManagementApplicationRequirementChangeCommandSchema.safeParse(candidate)
          .success,
      ).toBe(false);
    }
    for (const unexpected of [
      { expectedAccessVersion: 2 },
      { permissions: [] },
      { assignmentId: id("f", 20) },
      { fingerprint: `sha256:${"a".repeat(64)}` },
      { approved: true },
    ])
      expect(
        organizationManagementApplicationRequirementChangeCommandSchema.safeParse({
          ...command(),
          ...unexpected,
        }).success,
      ).toBe(false);
  });

  it("rejects nil and unsafe command identities or revisions", () => {
    for (const override of [
      { applicationRootId: "00000000-0000-0000-0000-000000000000" },
      { roleId: "00000000-0000-0000-0000-000000000000" },
      { expectedRequirementRevision: Number.MAX_SAFE_INTEGER + 1 },
      { expectedRoleRevision: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(
        organizationManagementApplicationRequirementChangeCommandSchema.safeParse({
          ...command(),
          ...override,
        }).success,
      ).toBe(false);
  });

  it("accepts the complete extended requirement without changing the D1 shape", () => {
    expect(organizationManagementApplicationRequirementSchema.parse(requirement())).toEqual(
      requirement(),
    );
    expect(organizationStewardshipRequirementSchema.safeParse(requirement()).success).toBe(false);
    const withoutBinding = { ...requirement() } as Record<string, unknown>;
    delete withoutBinding.managementApplicationRootId;
    expect(
      organizationManagementApplicationRequirementSchema.safeParse(withoutBinding).success,
    ).toBe(false);
  });

  it("requires the binding to follow D1 and use safe exact evidence", () => {
    for (const override of [
      { revision: 1 },
      { requiredRoleRevision: Number.MAX_SAFE_INTEGER + 1 },
      { managementApplicationRootId: "00000000-0000-0000-0000-000000000000" },
      { managementRoleId: "00000000-0000-0000-0000-000000000000" },
      { permissionIds: [id("f", 21)] },
    ])
      expect(
        organizationManagementApplicationRequirementSchema.safeParse({
          ...requirement(),
          ...override,
        }).success,
      ).toBe(false);
  });

  it("accepts only changed results with exact current correlation evidence", () => {
    expect(
      organizationManagementApplicationRequirementChangeResultSchema.safeParse({
        outcome: "changed",
        operation: "activate_management_application_requirement",
        requirement: requirement(),
        accessVersion: 9,
        correlationId: id("e", 6).toUpperCase(),
      }).success,
    ).toBe(true);
    for (const override of [
      { outcome: "unchanged" },
      { correlationId: id("f", 30) },
      { accessVersion: Number.MAX_SAFE_INTEGER + 1 },
      { receiptId: id("f", 31) },
    ])
      expect(
        organizationManagementApplicationRequirementChangeResultSchema.safeParse({
          outcome: "changed",
          operation: "activate_management_application_requirement",
          requirement: requirement(),
          accessVersion: 9,
          correlationId: id("e", 6),
          ...override,
        }).success,
      ).toBe(false);
  });
});
