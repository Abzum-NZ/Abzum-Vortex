import {
  definitionResolutionSnapshotSchema,
  definitionSourceDocumentSchema,
  sessionContextSchema,
  type DefinitionResolutionSnapshot,
  type SessionContext,
} from "../../contracts/src/index";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "../../db/src/index";
import {
  compileDefinition,
  createDatabaseDefinitionPublicationRepository,
  createDefinitionPublicationService,
  extractSourceIdentityRequirements,
  fingerprintCanonicalValue,
  type DefinitionPublicationCatalogue,
} from "../../runtime/definition/src/index";
import postgres, { type Row, type TransactionSql } from "postgres";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.VORTEX_TEST_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const id = (value: number) => `a2570000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const tenantId = id(1);
const organizationId = id(2);
const actorId = id(3);
const rootId = id(4);
const correlationId = id(5);
const publishedAt = "2026-09-14T00:00:00.000Z";
const existingReleaseCount = 10_001;

const releasedSource = definitionSourceDocumentSchema.parse({
  source_contract_version: "1.0.0",
  kind: "module",
  root_alias: "bounded_history_module",
  key: "example.bounded_history",
  body: {
    name: "Bounded history proof",
    description: "The immutable content shared by the existing release history.",
    dependencies: [],
    record_types: [
      {
        id: "record_item",
        storage_contract_id: "storage_item",
        key: "item",
        name: "Item",
        plural_name: "Items",
        storage_scope: "organisation_shared",
        ownership_mode: "none",
        title_field: "title",
        standard_actions: ["read"],
        custom_actions: [],
        fields: [
          {
            id: "field_title",
            key: "title",
            type: "text",
            label: "Title",
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
    permissions: [
      {
        id: "permission_read",
        key: "example.bounded_history.item.read",
        label: "Read items",
        description: "Read bounded-history proof items.",
        record_type: "item",
        action_kind: "read",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: ["title"], changeable_fields: [] },
      },
    ],
    actions: [],
    events: [],
    rules: [],
    sharing_conditions: [],
    extension_points: [],
  },
});

const draftSource = definitionSourceDocumentSchema.parse({
  ...releasedSource,
  body: {
    ...releasedSource.body,
    description: "The next valid release after ten thousand and one existing releases.",
  },
});
const identityRequirements = extractSourceIdentityRequirements(draftSource);
const draftSourceFingerprint = fingerprintCanonicalValue(draftSource);

const context = (): SessionContext =>
  sessionContextSchema.parse({
    callerKind: "system",
    tenantId,
    organizationId,
    systemActorId: actorId,
    sessionId: id(6),
    authenticationStrength: "service",
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    accessVersion: 1,
    correlationId,
  });

const catalogue: DefinitionPublicationCatalogue = {
  listConnectionTypeReleases: async () => [],
  readConnectionTypeRelease: async () => undefined,
  readPlatformThemeRelease: async () => undefined,
  readPlatformBlockReleaseV2: async () => undefined,
  readPlatformThemeReleaseV2: async () => undefined,
  readApplicationCompositionCatalogueSnapshotV2: async () => undefined,
};

type HistoryPageObservation = Readonly<{
  phase: string;
  requestedAnchor: number;
  requestedAfter: number | null;
  requestedPageSize: number;
  returnedAnchor: number;
  returnedEntries: number;
  returnedNextAfter: number | null;
}>;

const requestTransaction = (
  transaction: TransactionSql,
  phase: () => string,
  observe: (page: HistoryPageObservation) => void,
): RequestDatabaseTransaction => ({
  query: async <ResultRow extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ) => {
    const rows = (await transaction<ResultRow[] & Row[]>(
      strings,
      ...values,
    )) as readonly ResultRow[];
    if (strings.join("$value").includes("read_publication_history_page")) {
      const page = rows[0]?.publication_history_page as
        | {
            anchorReleaseRevision: number;
            entries: readonly unknown[];
            nextAfterReleaseRevision: number | null;
          }
        | undefined;
      if (page === undefined) throw new Error("Publication-history proof page missing");
      observe({
        phase: phase(),
        requestedAnchor: Number(values[1]),
        requestedAfter: values[2] === null ? null : Number(values[2]),
        requestedPageSize: Number(values[3]),
        returnedAnchor: Number(page.anchorReleaseRevision),
        returnedEntries: page.entries.length,
        returnedNextAfter:
          page.nextAfterReleaseRevision === null ? null : Number(page.nextAfterReleaseRevision),
      });
    }
    return rows;
  },
});

const expectHistoryTraversal = (
  observations: readonly HistoryPageObservation[],
  phase: string,
  anchor: number,
): void => {
  const pages = observations.filter((page) => page.phase === phase);
  const expectedPageCount = Math.ceil(anchor / 100);
  expect(pages).toHaveLength(expectedPageCount);
  expect(pages.every((page) => page.requestedPageSize === 100)).toBe(true);
  expect(pages.every((page) => page.returnedEntries >= 1 && page.returnedEntries <= 100)).toBe(
    true,
  );
  expect(pages.every((page) => page.requestedAnchor === anchor)).toBe(true);
  expect(pages.every((page) => page.returnedAnchor === anchor)).toBe(true);
  for (const [index, page] of pages.entries()) {
    const expectedAfter = index === 0 ? null : index * 100;
    expect(page.requestedAfter).toBe(expectedAfter);
    expect(page.returnedEntries).toBe(index === expectedPageCount - 1 ? anchor - index * 100 : 100);
    expect(page.returnedNextAfter).toBe(index === expectedPageCount - 1 ? null : (index + 1) * 100);
  }
};

const rollbackProof = new Error("ROLLBACK_BOUNDED_DEFINITION_PUBLICATION_PROOF");

describeDatabase("bounded Definition publication PostgreSQL proof", () => {
  it("streams 10,001 existing releases and appends the valid 10,002nd release", async () => {
    const sql = postgres(databaseUrl!, { max: 1, prepare: false });
    try {
      try {
        await sql.begin(async (transaction) => {
          await transaction`insert into vortex_identity.tenants (
            tenant_id, short_name, display_name, state, created_at, created_by,
            state_changed_at, revision
          ) values (
            ${tenantId}, 'bounded_publication', 'Bounded publication', 'active',
            pg_catalog.statement_timestamp(), ${actorId}, pg_catalog.statement_timestamp(), 1
          )`;
          await transaction`insert into vortex_identity.organizations (
            organization_id, tenant_id, parent_organization_id, short_name, display_name,
            state, created_at, created_by, state_changed_at, revision
          ) values (
            ${organizationId}, ${tenantId}, null, 'bounded_publication', 'Bounded publication',
            'active', pg_catalog.statement_timestamp(), ${actorId},
            pg_catalog.statement_timestamp(), 1
          )`;
          await transaction`insert into vortex_definition.roots (
            root_id, organization_id, kind, key, created_at, created_by
          ) values (
            ${rootId}::uuid, ${organizationId}::uuid, 'module', ${draftSource.key},
            ${publishedAt}::timestamptz, ${actorId}::uuid
          )`;
          await transaction`insert into vortex_definition.drafts (
            root_id, draft_revision, draft_source, identity_requirements,
            source_contract_version, source_fingerprint, updated_at, updated_by
          ) values (
            ${rootId}::uuid, ${existingReleaseCount + 1}::bigint,
            ${JSON.stringify(draftSource)}::text::jsonb,
            ${JSON.stringify(identityRequirements)}::text::jsonb,
            '1.0.0', ${draftSourceFingerprint}, ${publishedAt}::timestamptz, ${actorId}::uuid
          )`;
          await transaction`select vortex_definition.record_source_identities(
            ${rootId}::uuid, ${JSON.stringify(identityRequirements)}::text::jsonb,
            ${actorId}::uuid, ${publishedAt}::timestamptz
          )`;

          const identityRows = await transaction<
            {
              definition_key: string;
              scope: string;
              kind: DefinitionResolutionSnapshot["identities"][number]["kind"];
              component_owner: string;
              alias: string;
              identifier: string;
            }[]
          >`select root.key as definition_key, alias.scope, alias.kind,
              alias.component_owner, alias.alias, alias.identity_id::text as identifier
            from vortex_definition.source_identity_aliases as alias
            join vortex_definition.roots as root on root.root_id = alias.root_id
            where alias.root_id = ${rootId}::uuid
            order by alias.scope, alias.kind, alias.alias`;
          const identities = identityRows.map((row) => ({
            definitionKey: row.definition_key,
            scope: row.scope,
            kind: row.kind,
            componentOwner: row.component_owner,
            alias: row.alias,
            identifier: row.identifier,
          })) as DefinitionResolutionSnapshot["identities"];

          const resolutionFor = (releaseVersion: string) => {
            const evidence = {
              contractVersion: "1.0.0" as const,
              definitions: [
                {
                  kind: "module" as const,
                  key: releasedSource.key,
                  rootId,
                  exactVersion: releaseVersion,
                },
              ],
              identities,
            };
            return definitionResolutionSnapshotSchema.parse({
              ...evidence,
              fingerprint: fingerprintCanonicalValue(evidence),
            });
          };
          for (let start = 1; start <= existingReleaseCount; start += 100) {
            const rows = Array.from(
              { length: Math.min(100, existingReleaseCount - start + 1) },
              (_, offset) => {
                const revision = start + offset;
                const releaseVersion = revision === 1 ? "1.0.0" : `1.0.${revision - 1}`;
                const authoredSource = definitionSourceDocumentSchema.parse({
                  ...releasedSource,
                  body: {
                    ...releasedSource.body,
                    description: `Immutable bounded-history release ${revision}.`,
                  },
                });
                const resolution = resolutionFor(releaseVersion);
                const output = compileDefinition({
                  source: authoredSource,
                  resolution,
                  draftMetadata: {
                    organizationId,
                    draftRevision: revision,
                    createdAt: publishedAt,
                    createdBy: actorId,
                    updatedAt: publishedAt,
                    updatedBy: actorId,
                  },
                  savedConditionRevisions: [],
                });
                if (output.kind !== "module") throw new Error("Module output required");
                return {
                  root_id: rootId,
                  release_revision: revision,
                  release_version: releaseVersion,
                  authored_source: authoredSource,
                  authored_source_fingerprint: fingerprintCanonicalValue(authoredSource),
                  source_contract_version: "1.0.0",
                  compilation_output: output,
                  resolution_snapshot: resolution,
                  content_fingerprint: output.artifact.contentFingerprint,
                  resolution_fingerprint: resolution.fingerprint,
                  validation_contract_version: "1.0.0",
                  comparison_fingerprint: output.artifact.contentFingerprint,
                  impact_reasons: [],
                  release_note: `Existing release ${revision}`,
                  published_at: publishedAt,
                  published_by: actorId,
                };
              },
            );
            await transaction`insert into vortex_definition.releases (
              root_id, release_revision, release_version, authored_source,
              authored_source_fingerprint, source_contract_version, compilation_output,
              resolution_snapshot, content_fingerprint, resolution_fingerprint,
              validation_contract_version, comparison_fingerprint, impact_reasons,
              release_note, published_at, published_by
            )
            select batch.root_id, batch.release_revision, batch.release_version,
              batch.authored_source, batch.authored_source_fingerprint,
              batch.source_contract_version, batch.compilation_output,
              batch.resolution_snapshot, batch.content_fingerprint,
              batch.resolution_fingerprint, batch.validation_contract_version,
              batch.comparison_fingerprint, batch.impact_reasons,
              batch.release_note, batch.published_at, batch.published_by
            from pg_catalog.jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) as batch(
              root_id uuid,
              release_revision bigint,
              release_version text,
              authored_source jsonb,
              authored_source_fingerprint text,
              source_contract_version text,
              compilation_output jsonb,
              resolution_snapshot jsonb,
              content_fingerprint text,
              resolution_fingerprint text,
              validation_contract_version text,
              comparison_fingerprint text,
              impact_reasons jsonb,
              release_note text,
              published_at timestamptz,
              published_by uuid
            )`;
          }
          await transaction`update vortex_definition.roots
            set current_release_revision = ${existingReleaseCount}::bigint
            where root_id = ${rootId}::uuid`;

          const [oldReleaseBefore] = await transaction<
            {
              content_fingerprint: string;
              resolution_fingerprint: string;
              authored_source_fingerprint: string;
            }[]
          >`select content_fingerprint, resolution_fingerprint, authored_source_fingerprint
            from vortex_definition.releases
            where root_id = ${rootId}::uuid
              and release_revision = ${existingReleaseCount}::bigint`;
          expect(oldReleaseBefore).toBeDefined();

          const proofContext = context();
          await transaction`set local role vortex_runtime`;
          await transaction`select vortex_context.initialize(
            ${JSON.stringify(proofContext)}::text::jsonb
          )`;
          await transaction`set local role vortex_request`;
          let proofPhase = "compact-evidence";
          const pageObservations: HistoryPageObservation[] = [];
          const repository = createDatabaseDefinitionPublicationRepository(
            requestTransaction(
              transaction,
              () => proofPhase,
              (page) => pageObservations.push(page),
            ),
          );
          const service = createDefinitionPublicationService(repository, catalogue);
          const candidateBefore = await repository.read(proofContext, (reader) =>
            reader.readCandidate(rootId),
          );
          if (candidateBefore === undefined) throw new Error("Publication candidate required");
          expect(candidateBefore.historyEvidence).toMatchObject({
            kind: "module",
            definitionKey: draftSource.key,
            rootId,
            releaseCount: existingReleaseCount,
            anchorReleaseRevision: existingReleaseCount,
            validationContractVersions: ["1.0.0"],
            latestRelease: {
              publication: {
                revision: existingReleaseCount,
                releaseVersion: "1.0.10000",
                contentFingerprint: oldReleaseBefore!.content_fingerprint,
              },
            },
          });
          expect(candidateBefore.historyEvidence).not.toHaveProperty("history");
          expect(JSON.stringify(candidateBefore.historyEvidence).length).toBeLessThan(100_000);
          expectHistoryTraversal(pageObservations, proofPhase, existingReleaseCount);

          proofPhase = "prepare";
          const prepared = await service.prepare(proofContext, {
            rootId,
            expectedDraftRevision: existingReleaseCount + 1,
          });
          expect(prepared.confirmation).toMatchObject({
            assignedVersion: "1.0.10001",
            impact: "patch",
          });
          expectHistoryTraversal(pageObservations, proofPhase, existingReleaseCount);

          proofPhase = "confirmation";
          const result = await service.publish(proofContext, {
            confirmation: prepared.confirmation,
            releaseNote: "Valid release after the former lifetime limit",
          });
          expect(result).toMatchObject({
            releaseRevision: 10_002,
            releaseVersion: "1.0.10001",
          });
          expectHistoryTraversal(pageObservations, proofPhase, existingReleaseCount);

          proofPhase = "after-append";
          const candidateAfter = await repository.read(proofContext, (reader) =>
            reader.readCandidate(rootId),
          );
          if (candidateAfter === undefined) throw new Error("Published candidate required");
          expect(candidateAfter.historyEvidence).toMatchObject({
            releaseCount: existingReleaseCount + 1,
            anchorReleaseRevision: existingReleaseCount + 1,
            latestRelease: {
              publication: {
                revision: existingReleaseCount + 1,
                releaseVersion: "1.0.10001",
              },
            },
          });
          expect(candidateAfter.historyEvidence).not.toHaveProperty("history");
          expect(candidateAfter.identities).toEqual(candidateBefore.identities);
          expectHistoryTraversal(pageObservations, proofPhase, existingReleaseCount + 1);

          await transaction`reset role`;
          const [facts] = await transaction<
            {
              release_count: number;
              current_release_revision: number;
              distinct_authored_sources: number;
              distinct_authored_source_fingerprints: number;
              distinct_content_fingerprints: number;
              distinct_compilation_outputs: number;
            }[]
          >`select count(release.release_revision)::integer as release_count,
              root.current_release_revision::integer,
              count(distinct release.authored_source)::integer as distinct_authored_sources,
              count(distinct release.authored_source_fingerprint)::integer
                as distinct_authored_source_fingerprints,
              count(distinct release.content_fingerprint)::integer as distinct_content_fingerprints,
              count(distinct release.compilation_output)::integer as distinct_compilation_outputs
            from vortex_definition.roots as root
            join vortex_definition.releases as release on release.root_id = root.root_id
            where root.root_id = ${rootId}::uuid
            group by root.current_release_revision`;
          expect(facts).toMatchObject({
            release_count: 10_002,
            current_release_revision: 10_002,
            distinct_authored_sources: 10_002,
            distinct_authored_source_fingerprints: 10_002,
            distinct_content_fingerprints: 10_002,
            distinct_compilation_outputs: 10_002,
          });
          const [oldReleaseAfter] = await transaction<
            {
              content_fingerprint: string;
              resolution_fingerprint: string;
              authored_source_fingerprint: string;
            }[]
          >`select content_fingerprint, resolution_fingerprint, authored_source_fingerprint
            from vortex_definition.releases
            where root_id = ${rootId}::uuid
              and release_revision = ${existingReleaseCount}::bigint`;
          expect(oldReleaseAfter).toEqual(oldReleaseBefore);
          const identityRowsAfter = await transaction<
            {
              definition_key: string;
              scope: string;
              kind: DefinitionResolutionSnapshot["identities"][number]["kind"];
              component_owner: string;
              alias: string;
              identifier: string;
            }[]
          >`select root.key as definition_key, alias.scope, alias.kind,
              alias.component_owner, alias.alias, alias.identity_id::text as identifier
            from vortex_definition.source_identity_aliases as alias
            join vortex_definition.roots as root on root.root_id = alias.root_id
            where alias.root_id = ${rootId}::uuid
            order by alias.scope, alias.kind, alias.alias`;
          expect(identityRowsAfter).toEqual(identityRows);
          throw rollbackProof;
        });
      } catch (error) {
        if (error !== rollbackProof) throw error;
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 180_000);
});
