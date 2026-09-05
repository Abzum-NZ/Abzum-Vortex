import type {
  OrganizationGroupChangeCommand,
  OrganizationGroupChangeResult,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import * as shippingAccess from "../src/index";
import { describe, expect, it } from "vitest";
import {
  OrganizationGroupChangeHandoffError,
  createOrganizationGroupChangeOwnerHandoff,
} from "./helpers/organization-group-change-owner-handoff";

const id = (suffix: number): string =>
  `a0000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const instant = (minute: number): string =>
  `2026-09-06T00:${String(minute).padStart(2, "0")}:00.000Z`;

const createCommand = (): OrganizationGroupChangeCommand => ({
  operation: "create_group",
  organizationId: id(1),
  groupId: id(2),
  key: "review_group",
  label: "Review Group",
  changedBy: id(3),
  correlationId: id(4),
});

const createdRow = (): DatabaseRow => ({
  outcome: "changed",
  operation: "create_group",
  organization_id: id(1),
  group_id: id(2),
  group_key: "review_group",
  label: "Review Group",
  state: "active",
  revision: "1",
  created_by_actor_id: id(3),
  created_at: new Date(instant(1)),
  changed_by_actor_id: id(3),
  changed_at: new Date(instant(1)),
  change_correlation_id: id(4),
  access_version: 2n,
  correlation_id: id(4),
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

describe("owner-only organization Group-change handoff contract proof", () => {
  it("keeps the owner handoff out of the shipping Access surface", () => {
    const exports = Object.keys(shippingAccess);
    expect(exports).not.toContain("createOrganizationGroupChangeOwnerHandoff");
    expect(exports).not.toContain("OrganizationGroupChangeHandoffError");
    expect(exports).not.toContain("organizationGroupChangeHandoffErrorCodes");
  });

  it("uses one coordinated create call and binds the complete stored Group", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationGroupChangeOwnerHandoff(
      transactionFor(() => [createdRow()], calls),
    );
    await expect(handoff.change(createCommand())).resolves.toEqual({
      outcome: "changed",
      operation: "create_group",
      group: {
        organizationId: id(1),
        groupId: id(2),
        key: "review_group",
        label: "Review Group",
        state: "active",
        revision: 1,
        createdByActorId: id(3),
        createdAt: instant(1),
        changedByActorId: id(3),
        changedAt: instant(1),
        changeCorrelationId: id(4),
      },
      accessVersion: 2,
      correlationId: id(4),
    } satisfies OrganizationGroupChangeResult);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_access.coordinate_organization_group_change");
    expect(calls[0]?.text).not.toContain("read_organization_group");
    expect(calls[0]?.values).toEqual([
      "create_group",
      id(1),
      id(2),
      null,
      "review_group",
      "Review Group",
      id(3),
      id(4),
    ]);
  });

  it("uses narrow label-revision and retirement argument shapes", async () => {
    const revisedCalls: QueryCall[] = [];
    const revised = createOrganizationGroupChangeOwnerHandoff(
      transactionFor(
        () => [
          {
            ...createdRow(),
            operation: "revise_group_label",
            label: "Renamed Group",
            revision: "2",
            change_correlation_id: id(5),
            correlation_id: id(5),
            access_version: "3",
          },
        ],
        revisedCalls,
      ),
    );
    await expect(
      revised.change({
        operation: "revise_group_label",
        organizationId: id(1),
        groupId: id(2),
        expectedGroupRevision: 1,
        label: "Renamed Group",
        changedBy: id(3),
        correlationId: id(5),
      }),
    ).resolves.toMatchObject({ operation: "revise_group_label", accessVersion: 3 });
    expect(revisedCalls[0]?.values).toEqual([
      "revise_group_label",
      id(1),
      id(2),
      1,
      null,
      "Renamed Group",
      id(3),
      id(5),
    ]);

    const retiredCalls: QueryCall[] = [];
    const retired = createOrganizationGroupChangeOwnerHandoff(
      transactionFor(
        () => [
          {
            ...createdRow(),
            operation: "retire_group",
            state: "retired",
            revision: 3n,
            change_correlation_id: id(6),
            correlation_id: id(6),
            access_version: 4n,
          },
        ],
        retiredCalls,
      ),
    );
    await expect(
      retired.change({
        operation: "retire_group",
        organizationId: id(1),
        groupId: id(2),
        expectedGroupRevision: 2,
        changedBy: id(3),
        correlationId: id(6),
      }),
    ).resolves.toMatchObject({ operation: "retire_group", accessVersion: 4 });
    expect(retiredCalls[0]?.values).toEqual([
      "retire_group",
      id(1),
      id(2),
      2,
      null,
      null,
      id(3),
      id(6),
    ]);
  });

  it("compares UUID identities case-insensitively but refuses a true mismatch", async () => {
    const uppercase = {
      ...createCommand(),
      organizationId: id(1).toUpperCase(),
      groupId: id(2).toUpperCase(),
      changedBy: id(3).toUpperCase(),
      correlationId: id(4).toUpperCase(),
    } satisfies OrganizationGroupChangeCommand;
    const accepted = createOrganizationGroupChangeOwnerHandoff(
      transactionFor(() => [createdRow()]),
    );
    await expect(accepted.change(uppercase)).resolves.toMatchObject({ outcome: "changed" });

    const mismatched = createOrganizationGroupChangeOwnerHandoff(
      transactionFor(() => [{ ...createdRow(), group_id: id(99) }]),
    );
    await expect(mismatched.change(createCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_GROUP_CHANGE_STORAGE_RESULT",
    });
  });

  it.each([
    ["operation", { operation: "revise_group_label" }],
    ["organization", { organization_id: id(99) }],
    ["Group", { group_id: id(99) }],
    ["key", { group_key: "other_group" }],
    ["label", { label: "Other Group" }],
    ["state", { state: "retired" }],
    ["revision", { revision: "2" }],
    ["creation actor", { created_by_actor_id: id(99), changed_by_actor_id: id(99) }],
    ["change actor", { changed_by_actor_id: id(99) }],
    ["change correlation", { change_correlation_id: id(99) }],
    ["outer correlation", { correlation_id: id(99) }],
  ])("refuses a valid-shaped create result with the wrong %s", async (_name, override) => {
    const handoff = createOrganizationGroupChangeOwnerHandoff(
      transactionFor(() => [{ ...createdRow(), ...override }]),
    );
    await expect(handoff.change(createCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_GROUP_CHANGE_STORAGE_RESULT",
    });
  });

  it("refuses malformed commands and malformed row cardinality before returning facts", async () => {
    const calls: QueryCall[] = [];
    const handoff = createOrganizationGroupChangeOwnerHandoff(transactionFor(() => [], calls));
    await expect(
      handoff.change({ ...createCommand(), key: "Invalid Key" } as OrganizationGroupChangeCommand),
    ).rejects.toMatchObject({ code: "INVALID_ORGANIZATION_GROUP_CHANGE_COMMAND" });
    expect(calls).toHaveLength(0);
    await expect(handoff.change(createCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_GROUP_CHANGE_STORAGE_RESULT",
    });

    const multiple = createOrganizationGroupChangeOwnerHandoff(
      transactionFor(() => [createdRow(), createdRow()]),
    );
    await expect(multiple.change(createCommand())).rejects.toMatchObject({
      code: "INVALID_ORGANIZATION_GROUP_CHANGE_STORAGE_RESULT",
    });
  });

  it.each([
    ["22023", "INVALID_ORGANIZATION_GROUP_CHANGE_COMMAND"],
    ["42501", "ORGANIZATION_GROUP_CHANGE_SCOPE_UNAVAILABLE"],
    ["22003", "ORGANIZATION_GROUP_CHANGE_VERSION_EXHAUSTED"],
    ["23503", "ORGANIZATION_GROUP_CHANGE_STALE_OR_UNAVAILABLE"],
    ["23505", "ORGANIZATION_GROUP_CHANGE_STALE_OR_UNAVAILABLE"],
    ["23514", "ORGANIZATION_GROUP_CHANGE_STALE_OR_UNAVAILABLE"],
    ["40001", "ORGANIZATION_GROUP_CHANGE_STALE_OR_UNAVAILABLE"],
    ["55000", "ORGANIZATION_GROUP_CHANGE_STALE_OR_UNAVAILABLE"],
    ["XX000", "ORGANIZATION_GROUP_CHANGE_FAILED"],
  ])("maps SQLSTATE %s without exposing storage detail", async (databaseCode, expectedCode) => {
    const handoff = createOrganizationGroupChangeOwnerHandoff({
      query: async () => {
        throw { code: databaseCode, message: "sensitive database detail" };
      },
    });
    await expect(handoff.change(createCommand())).rejects.toEqual(
      new OrganizationGroupChangeHandoffError(
        expectedCode as ConstructorParameters<typeof OrganizationGroupChangeHandoffError>[0],
      ),
    );
  });
});
