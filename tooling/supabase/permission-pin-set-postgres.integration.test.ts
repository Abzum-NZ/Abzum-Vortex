import {
  applicationDefinitionConsumerReadResultV1Schema,
  definitionResolutionSnapshotSchema,
  definitionSourceDocumentSchema,
  moduleDefinitionConsumerReadResultV1Schema,
  sessionContextSchema,
  type DefinitionResolutionSnapshot,
  type DefinitionSourceDocument,
  type SessionContext,
} from "../../contracts/src/index";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "../../db/src/index";
import {
  compileDefinition,
  extractSourceIdentityRequirements,
  fingerprintCanonicalValue,
} from "../../runtime/definition/src/index";
import { createDatabaseInstalledEventCatalogueSource } from "../../runtime/event/src/index";
import postgres, { type Row, type TransactionSql } from "postgres";
import { describe, expect, it } from "vitest";
import {
  createStoredApplicationPermissionSource,
  type StoredApplicationPermissionSourceDependencies,
} from "../../runtime/access/src/index";

const databaseUrl = process.env.VORTEX_TEST_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const id = (value: number) => `a4030000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const tenantId = id(1);
const organizationId = id(2);
const actorId = id(3);
const applicationRootId = id(4);
const directModuleRootId = id(5);
const transitiveModuleRootId = id(6);
const correlationId = id(7);
const identityId = id(8);
const organizationAccountId = id(9);
const unrelatedModuleRootId = id(10);
const publishedAt = "2026-09-12T00:00:00.000Z";
const releaseVersion = "1.0.0";

const moduleSource = (
  key: string,
  rootAlias: string,
  dependency?: Readonly<{ key: string; purpose: string }>,
): DefinitionSourceDocument =>
  definitionSourceDocumentSchema.parse({
    source_contract_version: "1.0.0",
    kind: "module",
    root_alias: rootAlias,
    key,
    body: {
      name: key,
      description: `Neutral ${key} Module used by the protected pin-set proof.`,
      dependencies:
        dependency === undefined
          ? []
          : [
              {
                dependency_key: dependency.purpose,
                module: dependency.key,
                version: { selection: "exact", version: releaseVersion },
              },
            ],
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
          key: `${key}.item.read`,
          label: "Read items",
          description: "Read neutral proof items.",
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

const transitiveSource = moduleSource("example.transitive", "module_transitive");
const directSource = moduleSource("example.direct", "module_direct", {
  key: transitiveSource.key,
  purpose: "transitive",
});
const unrelatedSource = moduleSource("example.unrelated", "module_unrelated");
const applicationSource = definitionSourceDocumentSchema.parse({
  source_contract_version: "1.0.0",
  kind: "application",
  root_alias: "application_pin_set",
  key: "example.application",
  body: {
    name: "Pin-set proof",
    description: "Neutral Application for the protected pin-set proof.",
    icon: "application",
    home_page: "home",
    module_bindings: [
      {
        module: directSource.key,
        version: { selection: "exact", version: releaseVersion },
        purpose: "primary",
      },
    ],
    theme: {
      mode: "application",
      light_and_dark: true,
      tokens: {
        brand: "blue",
        density: "comfortable",
        corners: "medium",
        focus: "high_contrast",
      },
    },
    permissions: [
      {
        id: "permission_open",
        key: "example.application.open",
        label: "Open application",
        description: "Open the neutral proof Application.",
        action_kind: "named",
        named_action: "open",
        administrative: false,
      },
    ],
    roles: [
      {
        id: "role_user",
        key: "user",
        name: "User",
        home_page: "home",
        permissions: ["example.application.open"],
      },
    ],
    navigation: [],
    queries: [],
    block_registrations: [
      {
        id: "block_content",
        release_version: releaseVersion,
        name: "Content",
        icon: "content",
        palette_group: "content",
        settings: [],
        allowed_child_blocks: [],
        phone_behaviour: "full_width",
        resizable_height: true,
        live_update: false,
        public_page: false,
      },
    ],
    pages: [
      {
        id: "page_home",
        key: "home",
        name: "Home",
        type: "dashboard",
        permission: "example.application.open",
        states: ["normal"],
        blocks: [
          {
            id: "placement_content",
            block: "block_content",
            block_release_version: releaseVersion,
            settings: {},
            desktop: { start_column: 1, span: 12, height: 4 },
            phone: { order: 0, behaviour: "full_width" },
            view_permission: "example.application.open",
          },
        ],
        layout: {
          desktop: { columns: 12, component_order: ["placement_content"] },
          phone: { component_order: ["placement_content"] },
        },
      },
    ],
    workflows: [],
    pipelines: [],
    connection_bindings: [],
    interfaces: [],
    actions: [],
    rules: [],
    events: [],
    public_addresses: [],
  },
});

const sources = [transitiveSource, directSource, unrelatedSource, applicationSource] as const;
const rootByKey = new Map([
  [transitiveSource.key, transitiveModuleRootId],
  [directSource.key, directModuleRootId],
  [unrelatedSource.key, unrelatedModuleRootId],
  [applicationSource.key, applicationRootId],
]);
let nextIdentity = 100;
const identityEntries = new Map<string, DefinitionResolutionSnapshot["identities"][number]>();
for (const source of sources)
  for (const requirement of extractSourceIdentityRequirements(source)) {
    const identifier =
      requirement.kind === "root" ? rootByKey.get(requirement.definitionKey)! : id(nextIdentity++);
    for (const alias of requirement.aliases) {
      const subject = [
        requirement.definitionKey,
        requirement.scope,
        requirement.kind,
        requirement.componentOwner ?? "",
        alias,
      ].join(":");
      if (!identityEntries.has(subject))
        identityEntries.set(subject, {
          definitionKey: requirement.definitionKey,
          scope: requirement.scope,
          kind: requirement.kind,
          componentOwner: requirement.componentOwner,
          alias,
          identifier,
        });
    }
  }
const resolutionEvidence = {
  contractVersion: "1.0.0" as const,
  definitions: sources.map((source) => ({
    kind: source.kind,
    key: source.key,
    rootId: rootByKey.get(source.key)!,
    exactVersion: releaseVersion,
  })),
  identities: [...identityEntries.values()],
};
const resolutionSnapshot = definitionResolutionSnapshotSchema.parse({
  ...resolutionEvidence,
  fingerprint: fingerprintCanonicalValue(resolutionEvidence),
});
const compile = (source: DefinitionSourceDocument) =>
  compileDefinition({
    source,
    resolution: resolutionSnapshot,
    draftMetadata: {
      organizationId,
      draftRevision: 1,
      createdAt: publishedAt,
      createdBy: actorId,
      updatedAt: publishedAt,
      updatedBy: actorId,
    },
    savedConditionRevisions: [],
  });
const transitiveOutput = compile(transitiveSource);
const directOutput = compile(directSource);
const unrelatedOutput = compile(unrelatedSource);
const applicationOutput = compile(applicationSource);
if (
  transitiveOutput.kind !== "module" ||
  directOutput.kind !== "module" ||
  unrelatedOutput.kind !== "module" ||
  applicationOutput.kind !== "application"
)
  throw new Error("Pin-set compiler output kind mismatch");

const dependencyOf = (
  target: typeof transitiveOutput | typeof directOutput | typeof unrelatedOutput,
) => ({
  kind: "module" as const,
  key: target.artifact.definitionKey,
  rootId: target.artifact.rootId,
  releaseRevision: 1,
  releaseVersion,
  contentFingerprint: target.artifact.contentFingerprint,
  resolutionFingerprint: target.resolutionFingerprint,
});
const moduleRead = (
  output: typeof transitiveOutput | typeof directOutput | typeof unrelatedOutput,
  dependencyManifest: readonly ReturnType<typeof dependencyOf>[],
) =>
  moduleDefinitionConsumerReadResultV1Schema.parse({
    kind: "module",
    organizationId,
    definitionKey: output.artifact.definitionKey,
    rootId: output.artifact.rootId,
    releaseRevision: 1,
    releaseVersion,
    validationContractVersion: "1.0.0",
    contentFingerprint: output.artifact.contentFingerprint,
    resolutionFingerprint: output.resolutionFingerprint,
    content: output.canonical.content,
    dependencyManifest,
    correlationId,
  });
const transitiveModule = moduleRead(transitiveOutput, []);
const directModule = moduleRead(directOutput, [dependencyOf(transitiveOutput)]);
const unrelatedModule = moduleRead(unrelatedOutput, []);
const application = applicationDefinitionConsumerReadResultV1Schema.parse({
  kind: "application",
  organizationId,
  definitionKey: applicationOutput.artifact.definitionKey,
  rootId: applicationOutput.artifact.rootId,
  releaseRevision: 1,
  releaseVersion,
  validationContractVersion: "1.0.0",
  contentFingerprint: applicationOutput.artifact.contentFingerprint,
  resolutionFingerprint: applicationOutput.resolutionFingerprint,
  content: applicationOutput.canonical.content,
  dependencyManifest: [dependencyOf(directOutput)],
  correlationId,
});
const publicationByRoot = new Map([
  [transitiveModule.rootId, { source: transitiveSource, output: transitiveOutput }],
  [directModule.rootId, { source: directSource, output: directOutput }],
  [unrelatedModule.rootId, { source: unrelatedSource, output: unrelatedOutput }],
  [application.rootId, { source: applicationSource, output: applicationOutput }],
]);

type ResolvedRequestTransaction = NonNullable<
  StoredApplicationPermissionSourceDependencies["resolvedRequestTransaction"]
>;

const requestTransaction = (transaction: TransactionSql): RequestDatabaseTransaction => ({
  query: async <ResultRow extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ) => (await transaction<ResultRow[] & Row[]>(strings, ...values)) as readonly ResultRow[],
});

/** Uses the proof's outer transaction while preserving the production request boundary. */
const resolvedRequestRunner = (transaction: TransactionSql): ResolvedRequestTransaction => {
  return async (resolve, operation) =>
    transaction.savepoint(async (savepoint) => {
      const request = requestTransaction(savepoint);
      const resolved = await resolve(request);
      await request.query`select vortex_context.initialize(
        ${JSON.stringify(resolved.context)}::text::jsonb
      )`;
      await request.query`set local role vortex_request`;
      const result = await operation(request, resolved.scope);
      await request.query`reset role`;
      await request.query`delete from vortex_context.request_contexts
        where backend_pid = pg_catalog.pg_backend_pid()`;
      return result;
    });
};

const rollbackProof = new Error("ROLLBACK_PERMISSION_PIN_SET_PROOF");

describeDatabase("permission pin-set PostgreSQL proof", () => {
  it("reads, registers and composes the exact protected App-to-Module pin set", async () => {
    const systemContext = sessionContextSchema.parse({
      callerKind: "system",
      tenantId,
      organizationId,
      applicationRootId,
      systemActorId: actorId,
      sessionId: id(40),
      authenticationStrength: "service",
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      accessVersion: 1,
      correlationId,
    });
    const sql = postgres(databaseUrl!, { max: 1, prepare: false });
    try {
      try {
        await sql.begin(async (transaction) => {
          await transaction`insert into vortex_identity.tenants (
            tenant_id, short_name, display_name, state, created_at, created_by,
            state_changed_at, revision
          ) values (
            ${tenantId}, 'pin_set_proof', 'Pin set proof', 'active',
            pg_catalog.statement_timestamp(), ${actorId}, pg_catalog.statement_timestamp(), 1
          )`;
          await transaction`insert into vortex_identity.organizations (
            organization_id, tenant_id, parent_organization_id, short_name, display_name,
            state, created_at, created_by, state_changed_at, revision
          ) values (
            ${organizationId}, ${tenantId}, null, 'pin_set_proof', 'Pin set proof',
            'active', pg_catalog.statement_timestamp(), ${actorId},
            pg_catalog.statement_timestamp(), 1
          )`;
          await transaction`select * from vortex_identity.ensure_identity_projection(
            ${identityId}::uuid, ${id(65)}::uuid
          )`;
          await transaction`insert into vortex_identity.organization_accounts (
            organization_account_id, organization_id, identity_id, display_name, state,
            activated_at, changed_at, state_changed_at, state_changed_by,
            state_change_correlation_id, revision
          ) values (
            ${organizationAccountId}::uuid, ${organizationId}::uuid, ${identityId}::uuid,
            'Pin set actor', 'active', pg_catalog.statement_timestamp(),
            pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(), ${actorId}::uuid,
            ${id(66)}::uuid, 1
          )`;
          await transaction`select * from vortex_access.initialize_organization_access_version(
            ${organizationId}::uuid, ${actorId}::uuid, ${correlationId}::uuid
          )`;
          await transaction`select vortex_context.initialize(
            ${JSON.stringify(systemContext)}::text::jsonb
          )`;

          for (const release of [transitiveModule, directModule, unrelatedModule, application]) {
            const publication = publicationByRoot.get(release.rootId);
            if (publication === undefined) throw new Error("Compiled publication is missing");
            const authoredSource = publication.source;
            const authoredSourceFingerprint = fingerprintCanonicalValue(authoredSource);
            const identityRequirements = extractSourceIdentityRequirements(authoredSource);
            await transaction`insert into vortex_definition.roots (
              root_id, organization_id, kind, key, created_at, created_by
            ) values (
              ${release.rootId}::uuid, ${organizationId}::uuid, ${release.kind}::text,
              ${release.definitionKey}::text, pg_catalog.statement_timestamp(), ${actorId}::uuid
            )`;
            await transaction`insert into vortex_definition.drafts (
              root_id, draft_revision, draft_source, identity_requirements,
              source_contract_version, source_fingerprint, updated_at, updated_by
            ) values (
              ${release.rootId}::uuid, ${release.releaseRevision}::bigint,
              ${JSON.stringify(authoredSource)}::text::jsonb,
              ${JSON.stringify(identityRequirements)}::text::jsonb,
              ${release.validationContractVersion}::text, ${authoredSourceFingerprint}::text,
              pg_catalog.statement_timestamp(), ${actorId}::uuid
            )`;
            const appendEvidence = {
              releaseVersion: release.releaseVersion,
              compilationOutput: publication.output,
              resolutionSnapshot,
              contentFingerprint: release.contentFingerprint,
              resolutionFingerprint: release.resolutionFingerprint,
              validationContractVersion: release.validationContractVersion,
              comparisonFingerprint: release.contentFingerprint,
              impactReasons: [],
              releaseNote: `Pin-set proof ${release.definitionKey}.`,
              dependencies: release.dependencyManifest,
            };
            await transaction`select * from vortex_definition.append_release(
              ${release.rootId}::uuid, ${release.releaseRevision}::bigint,
              ${authoredSourceFingerprint}::text,
              ${JSON.stringify(appendEvidence)}::text::jsonb
            )`;
          }
          await transaction`delete from vortex_context.request_contexts
            where backend_pid = pg_catalog.pg_backend_pid()`;

          const runResolved = resolvedRequestRunner(transaction);
          const evidence = await createStoredApplicationPermissionSource({
            systemContext,
            applicationRootId,
            releaseRevision: 1,
            definitionCatalogue: { connectionTypeReleases: [], platformThemeReleases: [] },
            resolvedRequestTransaction: runResolved,
          }).readExact();
          expect(
            evidence.permissionRegistration.entries.map((entry) => [
              entry.ownerKind,
              entry.ownerId,
            ]),
          ).toEqual([
            ["application", applicationRootId],
            ["module", directModuleRootId],
            ["module", transitiveModuleRootId],
          ]);

          await transaction`select * from vortex_access.apply_application_permission_registration_v1_internal(
            'register'::text, null::bigint,
            ${JSON.stringify(evidence.permissionRegistration)}::text::jsonb,
            ${actorId}::uuid, ${correlationId}::uuid
          )`;
          const rows = await transaction<
            { owner_kind: string; owner_id: string; occurrences: number }[]
          >`select owner_kind, owner_id::text, count(*)::integer as occurrences
            from vortex_access.permission_catalogue_entries
            where organization_id = ${organizationId}::uuid
              and application_root_id = ${applicationRootId}::uuid
            group by owner_kind, owner_id
            order by owner_kind, owner_id`;
          expect(rows).toEqual([
            { owner_kind: "application", owner_id: applicationRootId, occurrences: 1 },
            { owner_kind: "module", owner_id: directModuleRootId, occurrences: 1 },
            { owner_kind: "module", owner_id: transitiveModuleRootId, occurrences: 1 },
          ]);

          await transaction`set local role vortex_module_owner`;
          for (const [index, module] of [directModule, transitiveModule].entries())
            await transaction`insert into vortex_module.installation_bindings (
              organization_id, application_root_id, module_root_id, binding_revision,
              application_release_revision, module_release_revision, state,
              content_fingerprint, resolution_fingerprint, generator_contract_version,
              storage_contract_ids
            ) values (
              ${organizationId}::uuid, ${applicationRootId}::uuid, ${module.rootId}::uuid,
              ${index + 1}::bigint, 1, ${module.releaseRevision}::bigint, 'active',
              ${module.contentFingerprint}::text, ${module.resolutionFingerprint}::text,
              '1.0.0', array[${id(70 + index)}::uuid]
            )`;
          await transaction`reset role`;

          const [versionRow] = await transaction<{ current_version: string }[]>`
            select current_version::text
            from vortex_access.organization_access_versions
            where organization_id = ${organizationId}::uuid
          `;
          if (versionRow === undefined) throw new Error("Access version is unavailable");
          const humanContext = sessionContextSchema.parse({
            callerKind: "human",
            identityAuthorityId: actorId,
            tenantId,
            organizationId,
            organizationAccountId,
            identityId,
            applicationRootId,
            sessionId: id(73),
            authenticationStrength: "single_factor",
            issuedAt: new Date(Date.now() - 1_000).toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            accessVersion: Number(versionRow.current_version),
            correlationId: id(74),
            accessTokenIssuedAt: new Date(Date.now() - 1_000).toISOString(),
            primaryAuthenticatedAt: new Date(Date.now() - 1_000).toISOString(),
          } satisfies SessionContext);
          const readEvents = () =>
            runResolved(
              async () => ({ context: humanContext, scope: undefined }),
              async (request) =>
                createDatabaseInstalledEventCatalogueSource(
                  { connectionTypeReleases: [], platformThemeReleases: [] },
                  request,
                ).readCurrent(),
            );
          const eventCatalogue = await readEvents();
          expect(eventCatalogue.moduleBindings.map((binding) => binding.release.rootId)).toEqual([
            directModuleRootId,
            transitiveModuleRootId,
          ]);
          expect(eventCatalogue.descriptors).toHaveLength(14);

          await transaction`set local role vortex_module_owner`;
          await transaction`insert into vortex_module.installation_bindings (
            organization_id, application_root_id, module_root_id, binding_revision,
            application_release_revision, module_release_revision, state,
            content_fingerprint, resolution_fingerprint, generator_contract_version,
            storage_contract_ids
          ) values (
            ${organizationId}::uuid, ${applicationRootId}::uuid,
            ${unrelatedModule.rootId}::uuid, 3, 1,
            ${unrelatedModule.releaseRevision}::bigint, 'active',
            ${unrelatedModule.contentFingerprint}::text,
            ${unrelatedModule.resolutionFingerprint}::text, '1.0.0', array[${id(72)}::uuid]
          )`;
          await transaction`reset role`;
          await expect(readEvents()).rejects.toMatchObject({
            code: "ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE",
          });

          throw rollbackProof;
        });
      } catch (error) {
        if (error !== rollbackProof) throw error;
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  }, 45_000);
});
