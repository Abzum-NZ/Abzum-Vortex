import { sessionContextSchema, type SessionContext } from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import { describe, expect, it } from "vitest";
import { createDatabaseDefinitionConsumerReadRepository } from "../src/definition-consumer-read-repository";

const context = (): SessionContext =>
  sessionContextSchema.parse({
    callerKind: "system",
    tenantId: "10000000-0000-4000-8000-000000000001",
    organizationId: "20000000-0000-4000-8000-000000000001",
    systemActorId: "30000000-0000-4000-8000-000000000001",
    sessionId: "40000000-0000-4000-8000-000000000001",
    authenticationStrength: "service",
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    accessVersion: 1,
    correlationId: "50000000-0000-4000-8000-000000000001",
  });

const rootId = "60000000-0000-4000-8000-000000000001";

const runnerWith = (rows: readonly DatabaseRow[]) => {
  const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
  const transaction: RequestDatabaseTransaction = {
    query: async <ResultRow extends DatabaseRow>(
      strings: TemplateStringsArray,
      ...values: readonly DatabaseValue[]
    ) => {
      calls.push({ text: strings.join("$value"), values });
      return rows as readonly ResultRow[];
    },
  };
  return { calls, transaction };
};

describe("Definition consumer-read database repository", () => {
  it("uses one statement and maps current to a null revision", async () => {
    const evidence = { kind: "module", private: "evidence" };
    const { calls, transaction } = runnerWith([{ consumer_release: evidence }]);
    const repository = createDatabaseDefinitionConsumerReadRepository(transaction);

    await expect(
      repository.read(context(), {
        kind: "module",
        rootId,
        selector: { selection: "current" },
      }),
    ).resolves.toEqual(evidence);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_definition.read_consumer_release");
    expect(calls[0]?.values).toEqual(["module", rootId, null]);
  });

  it("passes an exact revision without following a pointer", async () => {
    const { calls, transaction } = runnerWith([{ consumer_release: {} }]);
    const repository = createDatabaseDefinitionConsumerReadRepository(transaction);
    await repository.read(context(), {
      kind: "module",
      rootId,
      selector: { selection: "revision", releaseRevision: 7 },
    });
    expect(calls[0]?.values).toEqual(["module", rootId, 7]);
  });

  it("maps database absence to undefined and refuses an invalid row count", async () => {
    const absent = createDatabaseDefinitionConsumerReadRepository(
      runnerWith([{ consumer_release: null }]).transaction,
    );
    await expect(
      absent.read(context(), {
        kind: "module",
        rootId,
        selector: { selection: "current" },
      }),
    ).resolves.toBeUndefined();

    const invalid = createDatabaseDefinitionConsumerReadRepository(runnerWith([]).transaction);
    await expect(
      invalid.read(context(), {
        kind: "module",
        rootId,
        selector: { selection: "current" },
      }),
    ).rejects.toThrow("DEFINITION_READ_STORAGE_INVALID");
  });
});
