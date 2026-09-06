import type {
  OrganizationRoleActivationChangeCommand,
  OrganizationRoleActivationChangeResult,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import * as shippingAccess from "../src/index";
import { describe, expect, it } from "vitest";
import {
  OrganizationRoleActivationChangeHandoffError,
  createOrganizationRoleActivationChangeOwnerHandoff,
} from "./helpers/organization-role-activation-change-owner-handoff";

const id = (suffix: number): string =>
  `af000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T05:${String(minute).padStart(2, "0")}:00.000Z`;

const command = (): OrganizationRoleActivationChangeCommand => ({
  operation: "activate_role",
  organizationId: id(1),
  roleActivationId: id(2),
  organizationAccountId: id(3),
  roleId: id(4),
  expectedRoleRevision: 5,
  requestedDurationSeconds: 900,
  eligibilitySource: {
    kind: "direct",
    eligibilityAssignment: { roleAssignmentId: id(5), revision: 2 },
  },
  changedBy: id(6),
  correlationId: id(7),
});

const activation = () => ({
  roleActivationId: id(2),
  organizationId: id(1),
  organizationAccountId: id(3),
  roleId: id(4),
  revision: 1,
  historicalRoleRevision: 5,
  authorityContinuityRevision: 2,
  policyContinuityRevision: 3,
  activationPolicy: {
    activationPolicyId: id(8),
    revision: 4,
    fingerprint: `sha256:${"b".repeat(64)}`,
  },
  eligibilitySource: {
    kind: "direct" as const,
    eligibilityAssignment: { roleAssignmentId: id(5), revision: 2 },
  },
  state: "live" as const,
  activatedByActorId: id(6),
  activatedAt: instant(1),
  expiresAt: instant(16),
  activationCorrelationId: id(7),
  changedByActorId: id(6),
  changedAt: instant(1),
  changeCorrelationId: id(7),
});

const row = (): DatabaseRow => ({
  outcome: "changed",
  operation: "activate_role",
  activation: activation(),
  access_version: 2n,
  correlation_id: id(7),
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

describe("owner-only organization role-activation handoff contract proof", () => {
  it("keeps the owner handoff out of the shipping Access surface", () => {
    const exports = Object.keys(shippingAccess);
    expect(exports).not.toContain("createOrganizationRoleActivationChangeOwnerHandoff");
    expect(exports).not.toContain("OrganizationRoleActivationChangeHandoffError");
    expect(exports).not.toContain("organizationRoleActivationChangeHandoffErrorCodes");
  });

  it("uses one coordinated activation call and binds exact source evidence", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationRoleActivationChangeOwnerHandoff(
      transactionFor(() => [row()], calls),
    );
    await expect(handoff.change(command())).resolves.toEqual({
      outcome: "changed",
      operation: "activate_role",
      activation: activation(),
      accessVersion: 2,
      correlationId: id(7),
    } satisfies OrganizationRoleActivationChangeResult);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain(
      "vortex_access.coordinate_organization_role_activation_change",
    );
    expect(calls[0]?.values).toEqual([
      "activate_role",
      id(1),
      id(2),
      null,
      id(3),
      id(4),
      5,
      900,
      "direct",
      id(5),
      2,
      null,
      null,
      id(6),
      id(7),
    ]);
  });

  it("binds an exact Group-derived source", async () => {
    const groupCommand = {
      ...command(),
      eligibilitySource: {
        kind: "group" as const,
        eligibilityAssignment: { roleAssignmentId: id(9), revision: 3 },
        originatingMembership: { membershipId: id(10), revision: 4 },
      },
    };
    const groupActivation = {
      ...activation(),
      eligibilitySource: groupCommand.eligibilitySource,
    };
    const handoff = createOrganizationRoleActivationChangeOwnerHandoff(
      transactionFor(() => [{ ...row(), activation: groupActivation }]),
    );
    await expect(handoff.change(groupCommand)).resolves.toMatchObject({
      activation: groupActivation,
    });
  });

  it("binds terminal revocation while leaving original evidence to SQL", async () => {
    const revokedAt = instant(20);
    const revoked = {
      ...activation(),
      revision: 2,
      state: "revoked" as const,
      changedByActorId: id(11),
      changedAt: revokedAt,
      changeCorrelationId: id(12),
      revokedByActorId: id(11),
      revokedAt,
      revocationCorrelationId: id(12),
    };
    const revoke = {
      operation: "revoke_role_activation" as const,
      organizationId: id(1),
      roleActivationId: id(2),
      expectedActivationRevision: 1,
      changedBy: id(11),
      correlationId: id(12),
    };
    const calls: QueryCall[] = [];
    const handoff = createOrganizationRoleActivationChangeOwnerHandoff(
      transactionFor(
        () => [
          {
            outcome: "changed",
            operation: "revoke_role_activation",
            activation: revoked,
            access_version: "3",
            correlation_id: id(12),
          },
        ],
        calls,
      ),
    );
    await expect(handoff.change(revoke)).resolves.toMatchObject({ activation: revoked });
    expect(calls[0]?.values).toEqual([
      "revoke_role_activation",
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
      null,
      id(11),
      id(12),
    ]);
  });

  it("accepts semantic UUID equivalence and refuses real substitutions", async () => {
    const equivalent = {
      ...command(),
      organizationId: id(1).toUpperCase(),
      roleActivationId: id(2).toUpperCase(),
      organizationAccountId: id(3).toUpperCase(),
      roleId: id(4).toUpperCase(),
      changedBy: id(6).toUpperCase(),
      correlationId: id(7).toUpperCase(),
      eligibilitySource: {
        kind: "direct" as const,
        eligibilityAssignment: { roleAssignmentId: id(5).toUpperCase(), revision: 2 },
      },
    };
    const accepted = createOrganizationRoleActivationChangeOwnerHandoff(
      transactionFor(() => [row()]),
    );
    await expect(accepted.change(equivalent)).resolves.toMatchObject({ outcome: "changed" });

    const refused = createOrganizationRoleActivationChangeOwnerHandoff(
      transactionFor(() => [
        { ...row(), activation: { ...activation(), organizationAccountId: id(99) } },
      ]),
    );
    await expect(refused.change(command())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_ACTIVATION_CHANGE_STORAGE_RESULT",
    });
  });

  it.each([
    ["operation", { operation: "revoke_role_activation" }],
    ["activation identity", { activation: { ...activation(), roleActivationId: id(99) } }],
    ["role", { activation: { ...activation(), roleId: id(99) } }],
    ["historical role revision", { activation: { ...activation(), historicalRoleRevision: 4 } }],
    [
      "assignment revision",
      {
        activation: {
          ...activation(),
          eligibilitySource: {
            kind: "direct",
            eligibilityAssignment: { roleAssignmentId: id(5), revision: 3 },
          },
        },
      },
    ],
    ["duration", { activation: { ...activation(), expiresAt: instant(17) } }],
    ["actor", { activation: { ...activation(), changedByActorId: id(99) } }],
    ["correlation", { correlation_id: id(99) }],
  ])("refuses activation storage result with substituted %s", async (_name, override) => {
    const handoff = createOrganizationRoleActivationChangeOwnerHandoff(
      transactionFor(() => [{ ...row(), ...override }]),
    );
    await expect(handoff.change(command())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_ACTIVATION_CHANGE_STORAGE_RESULT",
    });
  });

  it("refuses malformed commands and invalid result cardinality", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationRoleActivationChangeOwnerHandoff(
      transactionFor(() => [], calls),
    );
    await expect(
      handoff.change({ ...command(), requestedDurationSeconds: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_ORGANIZATION_ROLE_ACTIVATION_CHANGE_COMMAND" });
    expect(calls).toHaveLength(0);
    await expect(handoff.change(command())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_ACTIVATION_CHANGE_STORAGE_RESULT",
    });
    const multiple = createOrganizationRoleActivationChangeOwnerHandoff(
      transactionFor(() => [row(), row()]),
    );
    await expect(multiple.change(command())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_ROLE_ACTIVATION_CHANGE_STORAGE_RESULT",
    });
  });

  it.each([
    ["22023", "INVALID_ORGANIZATION_ROLE_ACTIVATION_CHANGE_COMMAND"],
    ["42501", "ORGANIZATION_ROLE_ACTIVATION_CHANGE_SCOPE_UNAVAILABLE"],
    ["22003", "ORGANIZATION_ROLE_ACTIVATION_CHANGE_VERSION_EXHAUSTED"],
    ["23503", "ORGANIZATION_ROLE_ACTIVATION_CHANGE_STALE_OR_UNAVAILABLE"],
    ["23505", "ORGANIZATION_ROLE_ACTIVATION_CHANGE_STALE_OR_UNAVAILABLE"],
    ["23514", "ORGANIZATION_ROLE_ACTIVATION_CHANGE_STALE_OR_UNAVAILABLE"],
    ["40001", "ORGANIZATION_ROLE_ACTIVATION_CHANGE_STALE_OR_UNAVAILABLE"],
    ["55000", "ORGANIZATION_ROLE_ACTIVATION_CHANGE_STALE_OR_UNAVAILABLE"],
    ["XX000", "ORGANIZATION_ROLE_ACTIVATION_CHANGE_FAILED"],
  ])("maps SQLSTATE %s without exposing storage detail", async (databaseCode, expectedCode) => {
    const handoff = createOrganizationRoleActivationChangeOwnerHandoff({
      query: async () => {
        throw { code: databaseCode, message: "sensitive database detail" };
      },
    });
    await expect(handoff.change(command())).rejects.toEqual(
      new OrganizationRoleActivationChangeHandoffError(
        expectedCode as ConstructorParameters<
          typeof OrganizationRoleActivationChangeHandoffError
        >[0],
      ),
    );
  });
});
