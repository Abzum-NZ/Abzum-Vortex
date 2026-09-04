import { sessionContextSchema, type SessionContext } from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import { describe, expect, it } from "vitest";
import { createDatabaseDefinitionHistoryRepository } from "../src/definition-history-repository";

const context = (): SessionContext =>
  sessionContextSchema.parse({
    callerKind: "system",
    tenantId: "20000000-0000-4000-a000-000000000001",
    organizationId: "20000000-0000-4000-a000-000000000002",
    systemActorId: "20000000-0000-4000-a000-000000000003",
    sessionId: "20000000-0000-4000-a000-000000000004",
    authenticationStrength: "service",
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    accessVersion: 1,
    correlationId: "20000000-0000-4000-a000-000000000005",
  });

const rootId = "20000000-0000-4000-a000-000000000006";

const runnerWith = (responses: readonly (readonly DatabaseRow[])[]) => {
  const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
  let response = 0;
  const transaction: RequestDatabaseTransaction = {
    query: async <ResultRow extends DatabaseRow>(
      strings: TemplateStringsArray,
      ...values: readonly DatabaseValue[]
    ) => {
      calls.push({ text: strings.join("$value"), values });
      return (responses[response++] ?? []) as readonly ResultRow[];
    },
  };
  return { calls, transaction };
};

describe("Definition history database repository", () => {
  it("uses one metadata history statement with the null first-page cursor", async () => {
    const { calls, transaction } = runnerWith([[{ release_history: { safe: "metadata" } }]]);
    const repository = createDatabaseDefinitionHistoryRepository(transaction);
    await expect(
      repository.list(context(), { kind: "module", rootId, pageSize: 20 }),
    ).resolves.toEqual({ safe: "metadata" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_definition.list_release_history");
    expect(calls[0]?.values).toEqual(["module", rootId, 20, null]);
  });

  it("passes an exact revision without traversing history", async () => {
    const { calls, transaction } = runnerWith([[{ release_history_entry: { safe: "metadata" } }]]);
    const repository = createDatabaseDefinitionHistoryRepository(transaction);
    await repository.readMetadata(context(), { kind: "module", rootId, releaseRevision: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_definition.read_release_history_entry");
    expect(calls[0]?.values).toEqual(["module", rootId, 7]);
  });

  it("reads, verifies, and conditionally restores in one request transaction", async () => {
    const evidence = { selected: "immutable" };
    const { calls, transaction } = runnerWith([
      [{ restore_evidence: evidence }],
      [{ restored_draft: { restored: "draft" } }],
    ]);
    const repository = createDatabaseDefinitionHistoryRepository(transaction);
    const verify = async (candidate: unknown) => {
      expect(candidate).toEqual(evidence);
      return { sourceFingerprint: `sha256:${"a".repeat(64)}`, identityRequirements: [] };
    };
    await expect(
      repository.restore(
        context(),
        { kind: "module", rootId, targetReleaseRevision: 2, expectedDraftRevision: 4 },
        verify,
      ),
    ).resolves.toEqual({ outcome: "restored", draft: { restored: "draft" } });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.text).toContain("vortex_definition.read_restore_release_evidence");
    expect(calls[1]?.text).toContain("vortex_definition.restore_release_draft");
    expect(calls[1]?.values).toEqual(["module", rootId, 2, 4, `sha256:${"a".repeat(64)}`, "[]"]);
  });

  it("does not verify or mutate an unknown immutable release and maps a zero mutation to stale", async () => {
    const absent = createDatabaseDefinitionHistoryRepository(
      runnerWith([[{ restore_evidence: null }]]).transaction,
    );
    const verify = async () => {
      throw new Error("Verification must not run");
    };
    await expect(
      absent.restore(
        context(),
        { kind: "module", rootId, targetReleaseRevision: 1, expectedDraftRevision: 1 },
        verify,
      ),
    ).resolves.toEqual({ outcome: "not_found" });

    const stale = createDatabaseDefinitionHistoryRepository(
      runnerWith([[{ restore_evidence: { selected: "immutable" } }], [{ restored_draft: null }]])
        .transaction,
    );
    await expect(
      stale.restore(
        context(),
        { kind: "module", rootId, targetReleaseRevision: 1, expectedDraftRevision: 1 },
        async () => ({ sourceFingerprint: `sha256:${"b".repeat(64)}`, identityRequirements: [] }),
      ),
    ).resolves.toEqual({ outcome: "stale" });
  });
});
