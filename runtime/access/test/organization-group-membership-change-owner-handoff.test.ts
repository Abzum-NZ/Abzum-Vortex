import type {
  OrganizationGroupMembershipChangeCommand,
  OrganizationGroupMembershipChangeResult,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import * as shippingAccess from "../src/index";
import { describe, expect, it } from "vitest";
import {
  OrganizationGroupMembershipChangeHandoffError,
  createOrganizationGroupMembershipChangeOwnerHandoff,
} from "./helpers/organization-group-membership-change-owner-handoff";

const id = (suffix: number): string =>
  `a2000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T02:${String(minute).padStart(2, "0")}:00.000Z`;

const addCommand = (): OrganizationGroupMembershipChangeCommand => ({
  operation: "add_membership",
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

const addRow = (): DatabaseRow => ({
  outcome: "changed",
  operation: "add_membership",
  membership: liveMembership(),
  closed_predecessor: null,
  access_version: 2n,
  correlation_id: id(6),
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

describe("owner-only organization Group-membership handoff contract proof", () => {
  it("keeps the owner handoff out of the shipping Access surface", () => {
    const exports = Object.keys(shippingAccess);
    expect(exports).not.toContain("createOrganizationGroupMembershipChangeOwnerHandoff");
    expect(exports).not.toContain("OrganizationGroupMembershipChangeHandoffError");
    expect(exports).not.toContain("organizationGroupMembershipChangeHandoffErrorCodes");
  });

  it("uses one coordinated add call and binds the exact membership grant", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationGroupMembershipChangeOwnerHandoff(
      transactionFor(() => [addRow()], calls),
    );
    await expect(handoff.change(addCommand())).resolves.toEqual({
      outcome: "changed",
      operation: "add_membership",
      membership: liveMembership(),
      accessVersion: 2,
      correlationId: id(6),
    } satisfies OrganizationGroupMembershipChangeResult);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain(
      "vortex_access.coordinate_organization_group_membership_change",
    );
    expect(calls[0]?.values).toEqual([
      "add_membership",
      id(1),
      id(2),
      null,
      id(3),
      id(4),
      instant(1),
      instant(20),
      null,
      id(5),
      id(6),
    ]);
  });

  it("uses narrow remove and restore calls and binds their successor evidence", async () => {
    const removeCalls: QueryCall[] = [];
    const removed = {
      ...liveMembership(),
      revision: 2,
      state: "revoked" as const,
      changedByActorId: id(7),
      changedAt: instant(3),
      changeCorrelationId: id(8),
      revokedByActorId: id(7),
      revokedAt: instant(3),
      revocationCorrelationId: id(8),
    };
    const remove = createOrganizationGroupMembershipChangeOwnerHandoff(
      transactionFor(
        () => [
          {
            outcome: "changed",
            operation: "remove_membership",
            membership: removed,
            closed_predecessor: null,
            access_version: "3",
            correlation_id: id(8),
          },
        ],
        removeCalls,
      ),
    );
    await expect(
      remove.change({
        operation: "remove_membership",
        organizationId: id(1),
        membershipId: id(2),
        expectedMembershipRevision: 1,
        changedBy: id(7),
        correlationId: id(8),
      }),
    ).resolves.toMatchObject({ operation: "remove_membership", membership: removed });
    expect(removeCalls[0]?.values).toEqual([
      "remove_membership",
      id(1),
      id(2),
      1,
      null,
      null,
      null,
      null,
      null,
      id(7),
      id(8),
    ]);

    const restoreCalls: QueryCall[] = [];
    const restored = {
      ...liveMembership(),
      revision: 3,
      changedByActorId: id(9),
      changedAt: instant(4),
      changeCorrelationId: id(10),
    };
    const restore = createOrganizationGroupMembershipChangeOwnerHandoff(
      transactionFor(
        () => [
          {
            outcome: "changed",
            operation: "restore_membership",
            membership: restored,
            closed_predecessor: null,
            access_version: 4,
            correlation_id: id(10),
          },
        ],
        restoreCalls,
      ),
    );
    await expect(
      restore.change({
        operation: "restore_membership",
        organizationId: id(1),
        membershipId: id(2),
        expectedMembershipRevision: 2,
        changedBy: id(9),
        correlationId: id(10),
      }),
    ).resolves.toMatchObject({ operation: "restore_membership", membership: restored });
    expect(restoreCalls[0]?.values).toEqual([
      "restore_membership",
      id(1),
      id(2),
      2,
      null,
      null,
      null,
      null,
      null,
      id(9),
      id(10),
    ]);
  });

  it("binds renewal to the old identity and exact replacement window", async () => {
    const calls: QueryCall[] = [];
    const changedAt = instant(40);
    const closed = {
      ...liveMembership(),
      revision: 2,
      state: "revoked" as const,
      changedByActorId: id(9),
      changedAt,
      changeCorrelationId: id(10),
      revokedByActorId: id(9),
      revokedAt: changedAt,
      revocationCorrelationId: id(10),
    };
    const replacement = {
      ...liveMembership(),
      membershipId: id(11),
      startsAt: instant(21),
      expiresAt: undefined,
      grantedByActorId: id(9),
      grantedAt: changedAt,
      grantCorrelationId: id(10),
      changedByActorId: id(9),
      changedAt,
      changeCorrelationId: id(10),
    };
    const handoff = createOrganizationGroupMembershipChangeOwnerHandoff(
      transactionFor(
        () => [
          {
            outcome: "changed",
            operation: "renew_membership",
            membership: replacement,
            closed_predecessor: closed,
            access_version: 5n,
            correlation_id: id(10),
          },
        ],
        calls,
      ),
    );
    await expect(
      handoff.change({
        operation: "renew_membership",
        organizationId: id(1),
        membershipId: id(2),
        expectedMembershipRevision: 1,
        replacementMembershipId: id(11),
        startsAt: instant(21),
        changedBy: id(9),
        correlationId: id(10),
      }),
    ).resolves.toMatchObject({
      operation: "renew_membership",
      membership: replacement,
      closedPredecessor: closed,
    });
    expect(calls[0]?.values).toEqual([
      "renew_membership",
      id(1),
      id(2),
      1,
      null,
      null,
      instant(21),
      null,
      id(11),
      id(9),
      id(10),
    ]);
  });

  it("accepts semantic UUID/timestamp equivalence and refuses true substitutions", async () => {
    const equivalent = {
      ...addCommand(),
      organizationId: id(1).toUpperCase(),
      membershipId: id(2).toUpperCase(),
      groupId: id(3).toUpperCase(),
      organizationAccountId: id(4).toUpperCase(),
      changedBy: id(5).toUpperCase(),
      correlationId: id(6).toUpperCase(),
      startsAt: "2026-09-06T13:01:00+11:00",
      expiresAt: "2026-09-06T13:20:00+11:00",
    } satisfies OrganizationGroupMembershipChangeCommand;
    const accepted = createOrganizationGroupMembershipChangeOwnerHandoff(
      transactionFor(() => [addRow()]),
    );
    await expect(accepted.change(equivalent)).resolves.toMatchObject({ outcome: "changed" });

    const refused = createOrganizationGroupMembershipChangeOwnerHandoff(
      transactionFor(() => [
        { ...addRow(), membership: { ...liveMembership(), organizationAccountId: id(99) } },
      ]),
    );
    await expect(refused.change(addCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_STORAGE_RESULT",
    });
  });

  it.each([
    ["operation", { operation: "restore_membership" }],
    ["membership identity", { membership: { ...liveMembership(), membershipId: id(99) } }],
    ["Group", { membership: { ...liveMembership(), groupId: id(99) } }],
    ["account", { membership: { ...liveMembership(), organizationAccountId: id(99) } }],
    ["window", { membership: { ...liveMembership(), startsAt: instant(2) } }],
    ["actor", { membership: { ...liveMembership(), changedByActorId: id(99) } }],
    ["correlation", { correlation_id: id(99) }],
    ["closed predecessor", { closed_predecessor: { ...liveMembership() } }],
  ])("refuses an add result with substituted %s", async (_name, override) => {
    const handoff = createOrganizationGroupMembershipChangeOwnerHandoff(
      transactionFor(() => [{ ...addRow(), ...override }]),
    );
    await expect(handoff.change(addCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_STORAGE_RESULT",
    });
  });

  it("refuses malformed commands and result cardinality before returning facts", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationGroupMembershipChangeOwnerHandoff(
      transactionFor(() => [], calls),
    );
    await expect(handoff.change({ ...addCommand(), expiresAt: instant(1) })).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_COMMAND",
    });
    expect(calls).toHaveLength(0);
    await expect(handoff.change(addCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_STORAGE_RESULT",
    });
    const multiple = createOrganizationGroupMembershipChangeOwnerHandoff(
      transactionFor(() => [addRow(), addRow()]),
    );
    await expect(multiple.change(addCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_STORAGE_RESULT",
    });
  });

  it.each([
    ["22023", "INVALID_ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_COMMAND"],
    ["42501", "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_SCOPE_UNAVAILABLE"],
    ["22003", "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_VERSION_EXHAUSTED"],
    ["23503", "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_STALE_OR_UNAVAILABLE"],
    ["23505", "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_STALE_OR_UNAVAILABLE"],
    ["23514", "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_STALE_OR_UNAVAILABLE"],
    ["40001", "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_STALE_OR_UNAVAILABLE"],
    ["55000", "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_STALE_OR_UNAVAILABLE"],
    ["XX000", "ORGANIZATION_GROUP_MEMBERSHIP_CHANGE_FAILED"],
  ])("maps SQLSTATE %s without exposing storage detail", async (databaseCode, expectedCode) => {
    const handoff = createOrganizationGroupMembershipChangeOwnerHandoff({
      query: async () => {
        throw { code: databaseCode, message: "sensitive database detail" };
      },
    });
    await expect(handoff.change(addCommand())).rejects.toEqual(
      new OrganizationGroupMembershipChangeHandoffError(
        expectedCode as ConstructorParameters<
          typeof OrganizationGroupMembershipChangeHandoffError
        >[0],
      ),
    );
  });
});
