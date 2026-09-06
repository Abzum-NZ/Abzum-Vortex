import type {
  OrganizationStewardshipAdoptionCommand,
  OrganizationStewardshipAdoptionResult,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import * as shippingAccess from "../src/index";
import { describe, expect, it } from "vitest";
import {
  OrganizationStewardshipHandoffError,
  createOrganizationStewardshipOwnerHandoff,
} from "./helpers/organization-stewardship-owner-handoff";

const id = (prefix: string, suffix: number): string =>
  `${prefix}2000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T04:${String(minute).padStart(2, "0")}:00.000Z`;

const command = (): OrganizationStewardshipAdoptionCommand => ({
  operation: "adopt_organization_stewardship",
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

const changedRow = (): DatabaseRow => ({
  outcome: "changed",
  operation: "adopt_organization_stewardship",
  requirement: requirement(),
  access_version: 2n,
  correlation_id: id("a", 7),
});

const unchangedRow = (): DatabaseRow => ({
  outcome: "unchanged",
  operation: "adopt_organization_stewardship",
  requirement: {
    ...requirement(),
    revision: 2,
    changedByActorId: id("b", 20),
    changedAt: instant(5),
    changeCorrelationId: id("c", 21),
  },
  access_version: "9",
  correlation_id: id("a", 7),
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

describe("trusted organization stewardship adoption handoff contract proof", () => {
  it("keeps the owner-only handoff out of the shipping Access surface", () => {
    const exports = Object.keys(shippingAccess);
    expect(exports).not.toContain("createOrganizationStewardshipOwnerHandoff");
    expect(exports).not.toContain("OrganizationStewardshipHandoffError");
    expect(exports).not.toContain("organizationStewardshipHandoffErrorCodes");
  });

  it("uses one exact scalar adoption call and binds the complete marker", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationStewardshipOwnerHandoff(
      transactionFor(() => [changedRow()], calls),
    );
    await expect(handoff.adopt(command())).resolves.toEqual({
      outcome: "changed",
      operation: "adopt_organization_stewardship",
      requirement: requirement(),
      accessVersion: 2,
      correlationId: id("a", 7),
    } satisfies OrganizationStewardshipAdoptionResult);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_access.coordinate_organization_stewardship_adoption");
    expect(calls[0]?.values).toEqual([
      id("a", 1),
      id("b", 2),
      id("c", 3),
      "organization_steward",
      "Organisation steward",
      "Permanent minimum organisation administration.",
      id("d", 4),
      id("e", 5),
      id("f", 6),
      id("a", 7),
    ]);
  });

  it("accepts unchanged replay after later requirement changes without rebinding role metadata", async () => {
    const replay = {
      ...command(),
      roleKey: "ignored_on_completed_replay",
      roleLabel: "Ignored on completed replay",
      roleDescription: "Creation-only role metadata is not immutable adoption provenance.",
    };
    const handoff = createOrganizationStewardshipOwnerHandoff(
      transactionFor(() => [unchangedRow()]),
    );
    await expect(handoff.adopt(replay)).resolves.toMatchObject({
      outcome: "unchanged",
      accessVersion: 9,
      requirement: {
        revision: 2,
        originalOrganizationAccountId: id("b", 2),
        changeCorrelationId: id("c", 21),
      },
    });
  });

  it("accepts semantic UUID case equivalence", async () => {
    const upper = Object.fromEntries(
      Object.entries(command()).map(([key, value]) => [
        key,
        typeof value === "string" && /^[a-f0-9]{8}-/.test(value) ? value.toUpperCase() : value,
      ]),
    ) as OrganizationStewardshipAdoptionCommand;
    expect(upper.organizationId).not.toBe(command().organizationId);
    const handoff = createOrganizationStewardshipOwnerHandoff(transactionFor(() => [changedRow()]));
    await expect(handoff.adopt(upper)).resolves.toMatchObject({ outcome: "changed" });
  });

  it.each([
    ["operation", { operation: "other" }],
    ["organization", { requirement: { ...requirement(), organizationId: id("f", 90) } }],
    [
      "original account",
      { requirement: { ...requirement(), originalOrganizationAccountId: id("f", 91) } },
    ],
    ["original role", { requirement: { ...requirement(), originalRoleId: id("f", 92) } }],
    [
      "original assignment",
      { requirement: { ...requirement(), originalRoleAssignmentId: id("f", 93) } },
    ],
    [
      "original delegation",
      { requirement: { ...requirement(), originalDelegationAuthorityId: id("f", 94) } },
    ],
    ["adopting actor", { requirement: { ...requirement(), adoptedByActorId: id("f", 95) } }],
    [
      "adoption correlation",
      { requirement: { ...requirement(), adoptionCorrelationId: id("f", 96) } },
    ],
    ["result correlation", { correlation_id: id("f", 97) }],
  ])("refuses a storage result with substituted %s", async (_name, override) => {
    const handoff = createOrganizationStewardshipOwnerHandoff(
      transactionFor(() => [{ ...changedRow(), ...override }]),
    );
    await expect(handoff.adopt(command())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_STEWARDSHIP_ADOPTION_STORAGE_RESULT",
    });
  });

  it("refuses malformed commands before querying", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationStewardshipOwnerHandoff(
      transactionFor(() => [changedRow()], calls),
    );
    await expect(
      handoff.adopt({
        ...command(),
        expectedAccessVersion: 1,
      } as OrganizationStewardshipAdoptionCommand),
    ).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_STEWARDSHIP_ADOPTION_COMMAND",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses invalid result cardinality", async () => {
    const none = createOrganizationStewardshipOwnerHandoff(transactionFor(() => []));
    await expect(none.adopt(command())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_STEWARDSHIP_ADOPTION_STORAGE_RESULT",
    });
    const multiple = createOrganizationStewardshipOwnerHandoff(
      transactionFor(() => [changedRow(), changedRow()]),
    );
    await expect(multiple.adopt(command())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_STEWARDSHIP_ADOPTION_STORAGE_RESULT",
    });
  });

  it.each([
    ["22023", "INVALID_ORGANIZATION_STEWARDSHIP_ADOPTION_COMMAND"],
    ["42501", "ORGANIZATION_STEWARDSHIP_ADOPTION_SCOPE_UNAVAILABLE"],
    ["22003", "ORGANIZATION_STEWARDSHIP_ADOPTION_VERSION_EXHAUSTED"],
    ["23503", "ORGANIZATION_STEWARDSHIP_ADOPTION_STALE_OR_UNAVAILABLE"],
    ["23505", "ORGANIZATION_STEWARDSHIP_ADOPTION_STALE_OR_UNAVAILABLE"],
    ["23514", "ORGANIZATION_STEWARDSHIP_ADOPTION_STALE_OR_UNAVAILABLE"],
    ["40001", "ORGANIZATION_STEWARDSHIP_ADOPTION_STALE_OR_UNAVAILABLE"],
    ["55000", "ORGANIZATION_STEWARDSHIP_ADOPTION_STALE_OR_UNAVAILABLE"],
    ["XX000", "ORGANIZATION_STEWARDSHIP_ADOPTION_FAILED"],
  ])("maps SQLSTATE %s without exposing storage detail", async (databaseCode, expectedCode) => {
    const handoff = createOrganizationStewardshipOwnerHandoff({
      query: async () => {
        throw { code: databaseCode, message: "sensitive database detail" };
      },
    });
    await expect(handoff.adopt(command())).rejects.toEqual(
      new OrganizationStewardshipHandoffError(
        expectedCode as ConstructorParameters<typeof OrganizationStewardshipHandoffError>[0],
      ),
    );
  });
});
