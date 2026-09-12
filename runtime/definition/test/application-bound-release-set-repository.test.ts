import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import { describe, expect, it } from "vitest";
import {
  createDatabaseApplicationBoundReleaseSetRepository,
  createDatabaseSystemApplicationBoundReleaseSetRepository,
} from "../src/application-bound-release-set";

const transactionFor = (rows: readonly DatabaseRow[]) => {
  const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
  const transaction: RequestDatabaseTransaction = {
    query: async <Row extends DatabaseRow>(
      strings: TemplateStringsArray,
      ...values: readonly DatabaseValue[]
    ) => {
      calls.push({ text: strings.join("$value"), values });
      return rows as readonly Row[];
    },
  };
  return { calls, transaction };
};

describe("Application-bound release-set repository", () => {
  it("passes only the exact revision to one fixed context-bound read", async () => {
    const evidence = { correlationId: "private", application: {}, modules: [{}] };
    const { calls, transaction } = transactionFor([{ bound_release_set: evidence }]);
    const repository = createDatabaseApplicationBoundReleaseSetRepository(transaction);
    await expect(repository.read({ applicationReleaseRevision: 7 })).resolves.toEqual(evidence);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_definition.read_application_bound_release_set");
    expect(calls[0]?.values).toEqual([7]);
    expect(calls[0]?.text).not.toContain("application_root_id");
    expect(calls[0]?.text).not.toContain("organization_id");
  });

  it("passes the exact root and revision to one fixed system-context read", async () => {
    const evidence = { correlationId: "private", application: {}, modules: [] };
    const { calls, transaction } = transactionFor([{ bound_release_set: evidence }]);
    const repository = createDatabaseSystemApplicationBoundReleaseSetRepository(transaction);
    await expect(
      repository.read(
        {
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
        },
        {
          applicationRootId: "60000000-0000-4000-8000-000000000001",
          applicationReleaseRevision: 7,
        },
      ),
    ).resolves.toEqual(evidence);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_definition.read_system_application_bound_release_set");
    expect(calls[0]?.values).toEqual(["60000000-0000-4000-8000-000000000001", 7]);
  });

  it("maps absence and refuses ambiguous database rows", async () => {
    await expect(
      createDatabaseApplicationBoundReleaseSetRepository(
        transactionFor([{ bound_release_set: null }]).transaction,
      ).read({ applicationReleaseRevision: 1 }),
    ).resolves.toBeUndefined();
    await expect(
      createDatabaseApplicationBoundReleaseSetRepository(transactionFor([]).transaction).read({
        applicationReleaseRevision: 1,
      }),
    ).rejects.toThrow("APPLICATION_BOUND_RELEASE_SET_STORAGE_INVALID");
  });
});
