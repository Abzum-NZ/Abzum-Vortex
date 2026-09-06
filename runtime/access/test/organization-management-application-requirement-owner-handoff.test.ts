import type {
  OrganizationManagementApplicationRequirementChangeCommand,
  OrganizationManagementApplicationRequirementChangeResult,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import * as shippingAccess from "../src/index";
import { describe, expect, it } from "vitest";
import {
  OrganizationManagementApplicationRequirementHandoffError,
  createOrganizationManagementApplicationRequirementOwnerHandoff,
} from "./helpers/organization-management-application-requirement-owner-handoff";

const id = (prefix: string, suffix: number): string =>
  `${prefix}4000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T06:${String(minute).padStart(2, "0")}:00.000Z`;

const command = (
  operation:
    | "activate_management_application_requirement"
    | "replace_management_application_requirement" = "activate_management_application_requirement",
): OrganizationManagementApplicationRequirementChangeCommand => ({
  operation,
  organizationId: id("a", 1),
  expectedRequirementRevision: operation === "activate_management_application_requirement" ? 1 : 2,
  applicationRootId: id("b", 2),
  roleId: id("c", 3),
  expectedRoleRevision: 4,
  changedBy: id("d", 5),
  correlationId: id("e", 6),
});

const requirement = (revision = 2) => ({
  organizationId: id("a", 1),
  revision,
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

const changedRow = (revision = 2): DatabaseRow => ({
  outcome: "changed",
  operation:
    revision === 2
      ? "activate_management_application_requirement"
      : "replace_management_application_requirement",
  requirement: requirement(revision),
  access_version: revision === 2 ? 9n : "10",
  correlation_id: id("e", 6),
});

type QueryCall = Readonly<{ text: string; values: readonly DatabaseValue[] }>;
const transactionFor = (
  responder: (call: QueryCall) => readonly DatabaseRow[],
  calls: QueryCall[] = [],
): RequestDatabaseTransaction => ({
  query: async <Row extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ) => {
    const call = { text: strings.join("$value"), values };
    calls.push(call);
    return responder(call) as readonly Row[];
  },
});

describe("organization management-application requirement owner handoff", () => {
  it("keeps the test-only owner handoff out of the shipping Access surface", () => {
    const exports = Object.keys(shippingAccess);
    expect(exports).not.toContain("createOrganizationManagementApplicationRequirementOwnerHandoff");
    expect(exports).not.toContain("OrganizationManagementApplicationRequirementHandoffError");
    expect(exports).not.toContain("organizationManagementApplicationRequirementHandoffErrorCodes");
  });

  it.each([
    ["activate_management_application_requirement", 1, 2, 9],
    ["replace_management_application_requirement", 2, 3, 10],
  ] as const)(
    "binds the complete changed-only %s result",
    async (operation, expectedRequirementRevision, resultRevision, accessVersion) => {
      const calls: QueryCall[] = [];
      const selectedCommand = command(operation);
      const handoff = createOrganizationManagementApplicationRequirementOwnerHandoff(
        transactionFor(() => [changedRow(resultRevision)], calls),
      );
      await expect(handoff.change(selectedCommand)).resolves.toEqual({
        outcome: "changed",
        operation,
        requirement: requirement(resultRevision),
        accessVersion,
        correlationId: id("e", 6),
      } satisfies OrganizationManagementApplicationRequirementChangeResult);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.text).toContain(
        "vortex_access.coordinate_organization_management_application_requirement",
      );
      expect(calls[0]?.values).toEqual([
        operation,
        id("a", 1),
        expectedRequirementRevision,
        id("b", 2),
        id("c", 3),
        4,
        id("d", 5),
        id("e", 6),
      ]);
    },
  );

  it("accepts semantic UUID case equivalence", async () => {
    const upper = Object.fromEntries(
      Object.entries(command()).map(([key, value]) => [
        key,
        typeof value === "string" && /^[a-f0-9]{8}-/.test(value) ? value.toUpperCase() : value,
      ]),
    ) as OrganizationManagementApplicationRequirementChangeCommand;
    expect(upper.organizationId).not.toBe(command().organizationId);
    const handoff = createOrganizationManagementApplicationRequirementOwnerHandoff(
      transactionFor(() => [changedRow()]),
    );
    await expect(handoff.change(upper)).resolves.toMatchObject({ outcome: "changed" });
  });

  it.each([
    ["operation", { operation: "replace_management_application_requirement" }],
    ["outcome", { outcome: "unchanged" }],
    ["organization", { requirement: { ...requirement(), organizationId: id("f", 30) } }],
    [
      "application root",
      { requirement: { ...requirement(), managementApplicationRootId: id("f", 31) } },
    ],
    ["role", { requirement: { ...requirement(), managementRoleId: id("f", 32) } }],
    ["required role revision", { requirement: { ...requirement(), requiredRoleRevision: 5 } }],
    ["requirement revision", { requirement: { ...requirement(), revision: 3 } }],
    ["change actor", { requirement: { ...requirement(), changedByActorId: id("f", 33) } }],
    ["change correlation", { requirement: { ...requirement(), changeCorrelationId: id("f", 34) } }],
    ["result correlation", { correlation_id: id("f", 35) }],
  ])("refuses a storage result with substituted %s", async (_name, override) => {
    const handoff = createOrganizationManagementApplicationRequirementOwnerHandoff(
      transactionFor(() => [{ ...changedRow(), ...override }]),
    );
    await expect(handoff.change(command())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_STORAGE_RESULT",
    });
  });

  it("refuses malformed commands before querying", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationManagementApplicationRequirementOwnerHandoff(
      transactionFor(() => [changedRow()], calls),
    );
    await expect(
      handoff.change({
        ...command(),
        expectedAccessVersion: 2,
      } as OrganizationManagementApplicationRequirementChangeCommand),
    ).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_COMMAND",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses invalid result cardinality", async () => {
    const none = createOrganizationManagementApplicationRequirementOwnerHandoff(
      transactionFor(() => []),
    );
    await expect(none.change(command())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_STORAGE_RESULT",
    });
    const multiple = createOrganizationManagementApplicationRequirementOwnerHandoff(
      transactionFor(() => [changedRow(), changedRow()]),
    );
    await expect(multiple.change(command())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_STORAGE_RESULT",
    });
  });

  it.each([
    ["22023", "INVALID_ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_COMMAND"],
    ["42501", "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_SCOPE_UNAVAILABLE"],
    ["22003", "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_VERSION_EXHAUSTED"],
    ["23503", "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_STALE_OR_UNAVAILABLE"],
    ["23505", "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_STALE_OR_UNAVAILABLE"],
    ["23514", "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_STALE_OR_UNAVAILABLE"],
    ["40001", "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_STALE_OR_UNAVAILABLE"],
    ["55000", "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_STALE_OR_UNAVAILABLE"],
    ["XX000", "ORGANIZATION_MANAGEMENT_APPLICATION_REQUIREMENT_FAILED"],
  ])("maps SQLSTATE %s without exposing storage detail", async (databaseCode, expectedCode) => {
    const handoff = createOrganizationManagementApplicationRequirementOwnerHandoff({
      query: async () => {
        throw { code: databaseCode, message: "sensitive database detail" };
      },
    });
    await expect(handoff.change(command())).rejects.toEqual(
      new OrganizationManagementApplicationRequirementHandoffError(
        expectedCode as ConstructorParameters<
          typeof OrganizationManagementApplicationRequirementHandoffError
        >[0],
      ),
    );
  });
});
