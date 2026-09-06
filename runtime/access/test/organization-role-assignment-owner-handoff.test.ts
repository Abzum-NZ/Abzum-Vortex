import type {
  OrganizationRoleAssignmentChangeCommand,
  OrganizationRoleAssignmentChangeResult,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import * as shippingAccess from "../src/index";
import { describe, expect, it } from "vitest";
import {
  OrganizationRoleAssignmentHandoffError,
  createOrganizationRoleAssignmentOwnerHandoff,
} from "./helpers/organization-role-assignment-owner-handoff";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T00:${String(minute).padStart(2, "0")}:00.000Z`;

const grantCommand = (): OrganizationRoleAssignmentChangeCommand => ({
  operation: "grant",
  organizationId: id(1),
  roleAssignmentId: id(2),
  roleId: id(3),
  expectedRoleRevision: 7,
  assignee: { kind: "organization_account", organizationAccountId: id(4) },
  assignmentKind: "standing",
  startsAt: instant(1),
  expiresAt: instant(20),
  changedBy: id(5),
  correlationId: id(6),
});

const liveRow = (): DatabaseRow => ({
  outcome: "changed",
  operation: "grant",
  organization_id: id(1),
  role_assignment_id: id(2),
  role_id: id(3),
  assignee_kind: "organization_account",
  organization_account_id: id(4),
  group_id: null,
  assignment_kind: "standing",
  revision: "1",
  starts_at: new Date(instant(1)),
  expires_at: new Date(instant(20)),
  state: "live",
  granted_by_actor_id: id(5),
  granted_at: new Date(instant(2)),
  grant_correlation_id: id(6),
  changed_by_actor_id: id(5),
  changed_at: new Date(instant(2)),
  change_correlation_id: id(6),
  revoked_by_actor_id: null,
  revoked_at: null,
  revocation_correlation_id: null,
  access_version: 9n,
  correlation_id: id(6),
});

const revokedRow = (): DatabaseRow => ({
  ...liveRow(),
  operation: "revoke",
  revision: "2",
  state: "revoked",
  changed_by_actor_id: id(7),
  changed_at: new Date(instant(10)),
  change_correlation_id: id(8),
  revoked_by_actor_id: id(7),
  revoked_at: new Date(instant(10)),
  revocation_correlation_id: id(8),
  access_version: "10",
  correlation_id: id(8),
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

describe("owner-only organization role-assignment handoff contract proof", () => {
  it("keeps the owner handoff out of the shipping Access surface", () => {
    const exports = Object.keys(shippingAccess);
    expect(exports).not.toContain("createOrganizationRoleAssignmentOwnerHandoff");
    expect(exports).not.toContain("OrganizationRoleAssignmentHandoffError");
    expect(exports).not.toContain("organizationRoleAssignmentHandoffErrorCodes");
  });

  it("uses one coordinated grant call and binds the complete stored assignment", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationRoleAssignmentOwnerHandoff(
      transactionFor(() => [liveRow()], calls),
    );

    await expect(handoff.change(grantCommand())).resolves.toEqual({
      outcome: "changed",
      operation: "grant",
      assignment: {
        roleAssignmentId: id(2),
        organizationId: id(1),
        roleId: id(3),
        assignee: { kind: "organization_account", organizationAccountId: id(4) },
        assignmentKind: "standing",
        revision: 1,
        startsAt: instant(1),
        expiresAt: instant(20),
        state: "live",
        grantedByActorId: id(5),
        grantedAt: instant(2),
        grantCorrelationId: id(6),
        changedByActorId: id(5),
        changedAt: instant(2),
        changeCorrelationId: id(6),
      },
      accessVersion: 9,
      correlationId: id(6),
    } satisfies OrganizationRoleAssignmentChangeResult);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain(
      "vortex_access.coordinate_organization_role_assignment_change",
    );
    expect(calls[0]?.text).not.toContain("read_organization_role_assignment");
    expect(calls[0]?.values).toEqual([
      "grant",
      id(1),
      id(2),
      null,
      id(3),
      7,
      "organization_account",
      id(4),
      null,
      "standing",
      instant(1),
      instant(20),
      id(5),
      id(6),
    ]);
  });

  it("uses the narrow revoke shape and binds its revision and revocation evidence", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationRoleAssignmentOwnerHandoff(
      transactionFor(() => [revokedRow()], calls),
    );
    await expect(
      handoff.change({
        operation: "revoke",
        organizationId: id(1),
        roleAssignmentId: id(2),
        expectedAssignmentRevision: 1,
        changedBy: id(7),
        correlationId: id(8),
      }),
    ).resolves.toMatchObject({
      operation: "revoke",
      assignment: {
        roleAssignmentId: id(2),
        revision: 2,
        state: "revoked",
        revokedByActorId: id(7),
        revocationCorrelationId: id(8),
      },
      accessVersion: 10,
    });
    expect(calls[0]?.values).toEqual([
      "revoke",
      id(1),
      id(2),
      1,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      id(7),
      id(8),
    ]);
  });

  it("binds equivalent timestamp representations but refuses a genuinely different window", async () => {
    const equivalent = {
      ...grantCommand(),
      startsAt: "2026-09-06T12:01:00+12:00",
      expiresAt: "2026-09-06T12:20:00+12:00",
    };
    const accepted = createOrganizationRoleAssignmentOwnerHandoff(
      transactionFor(() => [liveRow()]),
    );
    await expect(accepted.change(equivalent)).resolves.toMatchObject({ outcome: "changed" });

    const different = createOrganizationRoleAssignmentOwnerHandoff(
      transactionFor(() => [{ ...liveRow(), expires_at: new Date(instant(19)) }]),
    );
    await expect(different.change(grantCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_STORAGE_RESULT",
    });
  });

  it.each([
    ["organization", { organization_id: id(99) }],
    ["assignment", { role_assignment_id: id(99) }],
    ["role", { role_id: id(99) }],
    ["assignee", { organization_account_id: id(99) }],
    ["kind", { assignment_kind: "eligible" }],
    ["revision", { revision: "2" }],
    ["start", { starts_at: instant(3) }],
    ["expiry", { expires_at: null }],
    [
      "state",
      {
        state: "revoked",
        revoked_by_actor_id: id(5),
        revoked_at: instant(2),
        revocation_correlation_id: id(6),
      },
    ],
    ["grant actor", { granted_by_actor_id: id(99) }],
    ["grant correlation", { grant_correlation_id: id(99) }],
    ["change actor", { changed_by_actor_id: id(99) }],
    ["change correlation", { change_correlation_id: id(99) }],
    ["operation", { operation: "revoke" }],
    ["outer correlation", { correlation_id: id(99) }],
  ])("refuses a valid-shaped grant result with the wrong %s", async (_name, override) => {
    const handoff = createOrganizationRoleAssignmentOwnerHandoff(
      transactionFor(() => [{ ...liveRow(), ...override }]),
    );
    await expect(handoff.change(grantCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_STORAGE_RESULT",
    });
  });

  it.each([
    ["revision", { revision: "1" }],
    [
      "state",
      {
        state: "live",
        revoked_by_actor_id: null,
        revoked_at: null,
        revocation_correlation_id: null,
      },
    ],
    ["actor", { revoked_by_actor_id: id(99), changed_by_actor_id: id(99) }],
    ["correlation", { revocation_correlation_id: id(99), change_correlation_id: id(99) }],
  ])("refuses a revoke result with wrong %s binding", async (_name, override) => {
    const handoff = createOrganizationRoleAssignmentOwnerHandoff(
      transactionFor(() => [{ ...revokedRow(), ...override }]),
    );
    await expect(
      handoff.change({
        operation: "revoke",
        organizationId: id(1),
        roleAssignmentId: id(2),
        expectedAssignmentRevision: 1,
        changedBy: id(7),
        correlationId: id(8),
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_STORAGE_RESULT",
    });
  });

  it("refuses malformed commands and malformed row cardinality before returning authority facts", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationRoleAssignmentOwnerHandoff(transactionFor(() => [], calls));
    await expect(
      handoff.change({
        ...grantCommand(),
        expectedRoleRevision: 0,
      } as OrganizationRoleAssignmentChangeCommand),
    ).rejects.toMatchObject({ code: "INVALID_ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_COMMAND" });
    expect(calls).toHaveLength(0);

    await expect(handoff.change(grantCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_STORAGE_RESULT",
    });
    const multiple = createOrganizationRoleAssignmentOwnerHandoff(
      transactionFor(() => [liveRow(), liveRow()]),
    );
    await expect(multiple.change(grantCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_STORAGE_RESULT",
    });
  });

  it.each([
    ["22023", "INVALID_ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_COMMAND"],
    ["42501", "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_SCOPE_UNAVAILABLE"],
    ["22003", "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_VERSION_EXHAUSTED"],
    ["23503", "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_STALE_OR_UNAVAILABLE"],
    ["23505", "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_STALE_OR_UNAVAILABLE"],
    ["23514", "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_STALE_OR_UNAVAILABLE"],
    ["40001", "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_STALE_OR_UNAVAILABLE"],
    ["55000", "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_STALE_OR_UNAVAILABLE"],
    ["XX000", "ORGANIZATION_ROLE_ASSIGNMENT_CHANGE_FAILED"],
  ])("maps SQLSTATE %s without exposing storage detail", async (databaseCode, expectedCode) => {
    const handoff = createOrganizationRoleAssignmentOwnerHandoff({
      query: async () => {
        throw { code: databaseCode, message: "sensitive database detail" };
      },
    });
    await expect(handoff.change(grantCommand())).rejects.toEqual(
      new OrganizationRoleAssignmentHandoffError(
        expectedCode as ConstructorParameters<typeof OrganizationRoleAssignmentHandoffError>[0],
      ),
    );
  });
});
