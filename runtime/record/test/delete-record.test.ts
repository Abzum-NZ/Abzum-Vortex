import {
  recordTypeDefinitionV2Schema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import type {
  DatabaseRow,
  RequestDatabaseTransaction,
  RuntimeDatabaseTransaction,
} from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import {
  createProtectedParentDeleteService,
  type ProtectedParentDeleteServiceDependencies,
} from "../src/delete-record";

vi.mock("server-only", () => ({}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const ids = {
  authority: id(1),
  correlation: id(2),
  identity: id(3),
  session: id(4),
  organization: id(5),
  application: id(6),
  command: id(7),
  recordType: id(8),
  record: id(9),
  activity: id(10),
  occurrence: id(11),
  tenant: id(12),
  account: id(13),
  storage: id(14),
  titleField: id(15),
} as const;

const session: IdentitySession = {
  identityId: ids.identity,
  sessionId: ids.session,
  authenticationStrength: "multi_factor",
  accessTokenIssuedAt: "2026-09-21T00:00:00.000Z",
  accessTokenExpiresAt: "2026-09-21T02:00:00.000Z",
};

const selection: OrganizationSelectionCandidate = {
  organizationId: ids.organization,
  applicationRootId: ids.application,
};

const command = {
  commandId: ids.command,
  recordTypeId: ids.recordType,
  recordId: ids.record,
  expectedConcurrencyNumber: 1,
} as const;

const recordType = recordTypeDefinitionV2Schema.parse({
  recordTypeId: ids.recordType,
  key: "delete_parent",
  singularLabel: "Delete parent",
  pluralLabel: "Delete parents",
  titleFieldId: ids.titleField,
  storageContractId: ids.storage,
  storageScope: "application_contained",
  ownershipMode: "organization_account",
  fields: [
    {
      fieldId: ids.titleField,
      key: "title",
      label: "Title",
      required: true,
      unique: false,
      filterable: true,
      sortable: true,
      personalData: "none",
      publicDisplay: "refused",
      type: "text",
      settings: { maxLength: 100 },
    },
  ],
  relationships: [],
  standardActions: ["read", "update", "soft_delete", "restore"],
  customActionIds: [],
});

const prepared = (
  existingValues: Readonly<Record<string, unknown>> = { [ids.titleField]: "Parent" },
) => ({
  outcome: "prepared",
  correlationId: ids.correlation,
  readableFieldIds: [],
  records: [
    {
      recordKey: "root",
      recordType,
      existingValues,
      relationshipSources: [],
    },
  ],
});

const completed = {
  outcome: "completed",
  recordId: ids.record,
  concurrencyNumber: 2,
  correlationId: ids.correlation,
  replayed: false,
} as const;

type RequestQuery = <Row extends DatabaseRow>(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => Promise<readonly Row[]>;

const transactionHarness = (requestQuery: RequestQuery) => {
  const state = { attempts: 0, committed: 0, rolledBack: 0 };
  const runner: NonNullable<
    ProtectedParentDeleteServiceDependencies["resolvedRequestTransaction"]
  > = async (resolve, operation) => {
    state.attempts += 1;
    const resolved = await resolve({
      query: async <Row extends DatabaseRow>() =>
        [
          {
            tenant_id: ids.tenant,
            organization_id: ids.organization,
            organization_account_id: ids.account,
            application_root_id: ids.application,
            access_version: "1",
          },
        ] as unknown as readonly Row[],
    } satisfies RuntimeDatabaseTransaction);
    try {
      const value = await operation(
        { query: requestQuery } satisfies RequestDatabaseTransaction,
        resolved.scope,
      );
      state.committed += 1;
      return value;
    } catch (error) {
      state.rolledBack += 1;
      throw error;
    }
  };
  return { runner, state };
};

const dependencies = (): ProtectedParentDeleteServiceDependencies => ({
  identityAuthorityId: ids.authority,
  clock: () => new Date("2026-09-21T00:00:00.000Z"),
  correlationId: () => ids.correlation,
  resolvedRequestTransaction: vi.fn(),
});

describe("protected parent delete service", () => {
  it("rejects a command with caller-supplied extra fields before opening a request transaction", async () => {
    const values = dependencies();
    const service = createProtectedParentDeleteService(values);

    await expect(
      service.delete(
        { identityId: id(3), sessionId: id(4) } as never,
        { organizationId: id(5), applicationRootId: id(6) } as never,
        {
          commandId: id(7),
          recordTypeId: id(8),
          recordId: id(9),
          expectedConcurrencyNumber: 1,
          deletedRecordIds: [id(10)],
        },
      ),
    ).resolves.toEqual({ kind: "unavailable" });

    expect(values.resolvedRequestTransaction).not.toHaveBeenCalled();
  });

  it("rejects a command that omits an exact deletion identity", async () => {
    const values = dependencies();
    const service = createProtectedParentDeleteService(values);

    await expect(
      service.delete(
        { identityId: id(3), sessionId: id(4) } as never,
        { organizationId: id(5), applicationRootId: id(6) } as never,
        { commandId: id(7), recordTypeId: id(8), expectedConcurrencyNumber: 1 },
      ),
    ).resolves.toEqual({ kind: "unavailable" });

    expect(values.resolvedRequestTransaction).not.toHaveBeenCalled();
  });

  it("throws a prepared conflict through the transaction boundary, then retries the whole command", async () => {
    let preparations = 0;
    let finalizations = 0;
    const activityId = vi.fn(() => ids.activity);
    const occurrenceId = vi.fn(() => ids.occurrence);
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings) => {
      const sql = strings.join("$value");
      if (sql.includes("prepare_protected_parent_delete")) {
        preparations += 1;
        return [
          {
            result:
              preparations === 1
                ? { outcome: "conflict", correlationId: ids.correlation }
                : prepared(),
          },
        ] as unknown as readonly Row[];
      }
      if (sql.includes("read_current_organization_runtime_settings_for_application"))
        return [] as unknown as readonly Row[];
      if (sql.includes("finalize_protected_parent_delete")) {
        finalizations += 1;
        return [{ result: completed }] as unknown as readonly Row[];
      }
      return [] as unknown as readonly Row[];
    };
    const harness = transactionHarness(requestQuery);
    const service = createProtectedParentDeleteService({
      identityAuthorityId: ids.authority,
      clock: () => new Date("2026-09-21T01:00:00.000Z"),
      correlationId: () => ids.correlation,
      activityId,
      occurrenceId,
      resolvedRequestTransaction: harness.runner,
    });

    await expect(service.delete(session, selection, command)).resolves.toEqual({
      kind: "available",
      value: {
        outcome: "deleted",
        recordId: ids.record,
        concurrencyNumber: 2,
        correlationId: ids.correlation,
        replayed: false,
      },
    });
    expect(harness.state).toEqual({ attempts: 2, committed: 1, rolledBack: 1 });
    expect(preparations).toBe(2);
    expect(finalizations).toBe(1);
    expect(activityId).toHaveBeenCalledTimes(1);
    expect(occurrenceId).toHaveBeenCalledTimes(1);
  });

  it("rolls back a post-prepare evaluator refusal and maps it outside the transaction", async () => {
    let finalizations = 0;
    const occurrenceId = vi.fn(() => ids.occurrence);
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings) => {
      const sql = strings.join("$value");
      if (sql.includes("prepare_protected_parent_delete"))
        return [{ result: prepared({}) }] as unknown as readonly Row[];
      if (sql.includes("read_current_organization_runtime_settings_for_application"))
        return [] as unknown as readonly Row[];
      if (sql.includes("finalize_protected_parent_delete")) finalizations += 1;
      return [] as unknown as readonly Row[];
    };
    const harness = transactionHarness(requestQuery);
    const service = createProtectedParentDeleteService({
      identityAuthorityId: ids.authority,
      clock: () => new Date("2026-09-21T01:00:00.000Z"),
      correlationId: () => ids.correlation,
      activityId: () => ids.activity,
      occurrenceId,
      resolvedRequestTransaction: harness.runner,
    });

    await expect(service.delete(session, selection, command)).resolves.toEqual({
      kind: "unavailable",
    });
    expect(harness.state).toEqual({ attempts: 1, committed: 0, rolledBack: 1 });
    expect(finalizations).toBe(0);
    expect(occurrenceId).not.toHaveBeenCalled();
  });

  it("retries a deadlocked terminal write with the same generated identities", async () => {
    let finalizations = 0;
    const activityId = vi.fn(() => ids.activity);
    const occurrenceId = vi.fn(() => ids.occurrence);
    const finalizedOccurrences: unknown[] = [];
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings, ...values) => {
      const sql = strings.join("$value");
      if (sql.includes("prepare_protected_parent_delete"))
        return [{ result: prepared() }] as unknown as readonly Row[];
      if (sql.includes("read_current_organization_runtime_settings_for_application"))
        return [] as unknown as readonly Row[];
      if (sql.includes("finalize_protected_parent_delete")) {
        finalizations += 1;
        finalizedOccurrences.push(values[5]);
        if (finalizations === 1) throw Object.assign(new Error("deadlock"), { code: "40P01" });
        return [{ result: completed }] as unknown as readonly Row[];
      }
      return [] as unknown as readonly Row[];
    };
    const harness = transactionHarness(requestQuery);
    const service = createProtectedParentDeleteService({
      identityAuthorityId: ids.authority,
      clock: () => new Date("2026-09-21T01:00:00.000Z"),
      correlationId: () => ids.correlation,
      activityId,
      occurrenceId,
      resolvedRequestTransaction: harness.runner,
    });

    await expect(service.delete(session, selection, command)).resolves.toMatchObject({
      kind: "available",
      value: { outcome: "deleted", replayed: false },
    });
    expect(harness.state).toEqual({ attempts: 2, committed: 1, rolledBack: 1 });
    expect(finalizations).toBe(2);
    expect(finalizedOccurrences).toEqual([ids.occurrence, ids.occurrence]);
    expect(activityId).toHaveBeenCalledTimes(1);
    expect(occurrenceId).toHaveBeenCalledTimes(1);
  });

  it("rolls back a terminal database failure without retrying it as a conflict", async () => {
    const requestQuery: RequestQuery = async <Row extends DatabaseRow>(strings) => {
      const sql = strings.join("$value");
      if (sql.includes("prepare_protected_parent_delete"))
        return [{ result: prepared() }] as unknown as readonly Row[];
      if (sql.includes("read_current_organization_runtime_settings_for_application"))
        return [] as unknown as readonly Row[];
      if (sql.includes("finalize_protected_parent_delete"))
        throw Object.assign(new Error("terminal"), { code: "XX000" });
      return [] as unknown as readonly Row[];
    };
    const harness = transactionHarness(requestQuery);
    const service = createProtectedParentDeleteService({
      identityAuthorityId: ids.authority,
      clock: () => new Date("2026-09-21T01:00:00.000Z"),
      correlationId: () => ids.correlation,
      activityId: () => ids.activity,
      occurrenceId: () => ids.occurrence,
      resolvedRequestTransaction: harness.runner,
    });

    await expect(service.delete(session, selection, command)).resolves.toEqual({
      kind: "temporarily_unavailable",
    });
    expect(harness.state).toEqual({ attempts: 1, committed: 0, rolledBack: 1 });
  });
});
