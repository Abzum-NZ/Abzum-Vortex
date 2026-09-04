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
import { extractSourceIdentityRequirements } from "../src/source-identities";

const source = {
  source_contract_version: "1.0.0",
  kind: "module",
  root_alias: "module_alpha",
  key: "vortex.example.records",
  body: {
    name: "Example records",
    description: "A neutral definition used only to verify definition storage.",
    dependencies: [],
    record_types: [
      {
        id: "record_alpha",
        storage_contract_id: "storage_alpha",
        key: "entry",
        name: "Entry",
        plural_name: "Entries",
        storage_scope: "organisation_shared",
        ownership_mode: "none",
        title_field: "label",
        standard_actions: ["read"],
        custom_actions: [],
        fields: [
          {
            id: "field_alpha",
            key: "label",
            type: "text",
            label: "Label",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            settings: { max_length: 120 },
          },
        ],
        relationships: [],
      },
    ],
    permissions: [],
    actions: [],
    events: [],
    rules: [],
    extension_points: [],
    sharing_conditions: [],
  },
};
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
      JSON.stringify(extractSourceIdentityRequirements(parsedSource)),
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
      JSON.stringify(extractSourceIdentityRequirements(parsedSource)),
    ]);
  });

  it("returns complete database-owned restore provenance when it is present", async () => {
    const restored = {
      ...row(2),
      restored_from_release_revision: "1",
      restored_from_source_fingerprint: fingerprintCanonicalValue(source),
      restored_by: context().systemActorId,
      restored_at: new Date("2026-09-04T00:00:01Z"),
      restore_correlation_id: context().correlationId,
    };
    const store = createDefinitionStore(runnerReturning([restored]).runner);

    await expect(
      store.saveDraft(context(), {
        rootId: row().root_id,
        expectedDraftRevision: 1,
        source,
      }),
    ).resolves.toMatchObject({
      restoredFromReleaseRevision: 1,
      restoredFromSourceFingerprint: fingerprintCanonicalValue(source),
      restoredBy: context().systemActorId,
      restoreCorrelationId: context().correlationId,
    });
  });

  it("refuses partial or malformed non-null restore provenance instead of dropping it", async () => {
    const invalidRows = [
      { ...row(2), restored_from_release_revision: "not-a-revision" },
      {
        ...row(2),
        restored_from_release_revision: "1",
        restored_from_source_fingerprint: fingerprintCanonicalValue(source),
        restored_by: context().systemActorId,
        restored_at: new Date("2026-09-04T00:00:01Z"),
      },
    ];
    for (const invalid of invalidRows) {
      const store = createDefinitionStore(runnerReturning([invalid]).runner);
      await expect(
        store.saveDraft(context(), {
          rootId: row().root_id,
          expectedDraftRevision: 1,
          source,
        }),
      ).rejects.toMatchObject({ code: "INVALID_DEFINITION_STORAGE_RESULT" });
    }
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

  it.each([
    ["createRoot", "23505", "DEFINITION_ROOT_ALREADY_EXISTS"],
    ["saveDraft", "23505", "DEFINITION_IDENTITY_ALIAS_CONFLICT"],
    ["saveDraft", "40001", "DEFINITION_DRAFT_STALE_OR_MISSING"],
    ["saveDraft", "23503", "DEFINITION_ROOT_MISSING"],
    ["saveDraft", "42501", "DEFINITION_CONTEXT_REFUSED"],
    ["saveDraft", "22023", "DEFINITION_STORAGE_VALIDATION_FAILED"],
    ["saveDraft", "XX000", "DEFINITION_STORAGE_FAILED"],
  ] as const)(
    "maps %s database failure %s to closed error %s",
    async (operation, databaseCode, expectedCode) => {
      const store = createDefinitionStore(async () => {
        throw { code: databaseCode, message: "sensitive database detail" };
      });
      const pending =
        operation === "createRoot"
          ? store.createRoot(context(), { source })
          : store.saveDraft(context(), {
              rootId: row().root_id,
              expectedDraftRevision: 1,
              source,
            });

      await expect(pending).rejects.toMatchObject({
        name: "DefinitionStoreError",
        code: expectedCode,
        message: expectedCode,
      });
    },
  );

  it("maps raw runner failures without exposing their message", async () => {
    const store = createDefinitionStore(async () => {
      throw new Error("sensitive driver detail");
    });

    await expect(store.createRoot(context(), { source })).rejects.toMatchObject({
      name: "DefinitionStoreError",
      code: "DEFINITION_STORAGE_FAILED",
      message: "DEFINITION_STORAGE_FAILED",
    });
  });
});
