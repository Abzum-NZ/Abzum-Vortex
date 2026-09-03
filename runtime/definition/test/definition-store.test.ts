import fs from "node:fs";
import path from "node:path";
import {
  createDefinitionRootCommandSchema,
  sessionContextSchema,
  type SessionContext,
  type StoredDefinitionDraft,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { createDefinitionStore } from "../src/definition-store";
import type { DefinitionStoreError } from "../src/definition-store";

const source = JSON.parse(
  fs.readFileSync(
    path.resolve(import.meta.dirname, "../../../testing/fixtures/modules/crm.tags.json"),
    "utf8",
  ),
);
const parsedSource = createDefinitionRootCommandSchema.parse({ source }).source;
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

const row = (revision = 1) => ({
  root_id: "60000000-0000-4000-8000-000000000001",
  organization_id: context().organizationId,
  kind: "module",
  definition_key: source.key,
  draft_revision: String(revision),
  published_revision: null,
  authored_source: source,
  source_contract_version: source.source_contract_version,
  source_fingerprint: fingerprintCanonicalValue(source),
  created_at: new Date("2026-09-04T00:00:00Z"),
  created_by: context().systemActorId,
  updated_at: new Date("2026-09-04T00:00:01Z"),
  updated_by: context().systemActorId,
});

const runnerReturning = (rows: readonly DatabaseRow[]) => {
  const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
  const runner = async <Result>(
    _context: SessionContext,
    operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
  ): Promise<Result> =>
    operation({
      query: async <ResultRow extends DatabaseRow>(
        strings: TemplateStringsArray,
        ...values: readonly DatabaseValue[]
      ) => {
        calls.push({ text: strings.join("$value"), values });
        return rows as readonly ResultRow[];
      },
    });
  return { calls, runner };
};

describe("Definition store", () => {
  it("validates and fingerprints source before creating a database-owned root", async () => {
    const { calls, runner } = runnerReturning([row()]);
    const store = createDefinitionStore(runner);

    await expect(store.createRoot(context(), { source })).resolves.toMatchObject({
      kind: "module",
      key: source.key,
      draftRevision: 1,
      source,
    } satisfies Partial<StoredDefinitionDraft>);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_definition.create_root");
    expect(calls[0]?.values).toEqual([
      "module",
      source.key,
      JSON.stringify(parsedSource),
      fingerprintCanonicalValue(source),
    ]);
  });

  it("passes only the expected revision and service-derived source evidence when saving", async () => {
    const { calls, runner } = runnerReturning([row(2)]);
    const store = createDefinitionStore(runner);

    await expect(
      store.saveDraft(context(), {
        rootId: row().root_id,
        expectedDraftRevision: 1,
        source,
      }),
    ).resolves.toMatchObject({ draftRevision: 2 });
    expect(calls[0]?.text).toContain("vortex_definition.save_draft");
    expect(calls[0]?.values).toEqual([
      row().root_id,
      1,
      JSON.stringify(parsedSource),
      fingerprintCanonicalValue(source),
    ]);
  });

  it("maps a zero-row conditional save to one safe stale-or-missing error", async () => {
    const { runner } = runnerReturning([]);
    const store = createDefinitionStore(runner);

    await expect(
      store.saveDraft(context(), {
        rootId: row().root_id,
        expectedDraftRevision: 1,
        source,
      }),
    ).rejects.toMatchObject({
      name: "DefinitionStoreError",
      code: "DEFINITION_DRAFT_STALE_OR_MISSING",
    } satisfies Partial<DefinitionStoreError>);
  });

  it("refuses malformed commands and invalid source before opening a transaction", async () => {
    const runner = vi.fn();
    const store = createDefinitionStore(runner);

    await expect(store.createRoot(context(), { source: { ...source, body: {} } })).rejects.toThrow(
      "INVALID_DEFINITION_COMMAND",
    );
    expect(runner).not.toHaveBeenCalled();
  });
});
