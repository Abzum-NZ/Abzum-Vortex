import {
  applicationDefinitionConsumerReadResultV1Schema,
  definitionResolutionSnapshotSchema,
  definitionResolutionSnapshotV2Schema,
  definitionSourceDocumentSchema,
  moduleDefinitionConsumerReadResultV2Schema,
  moduleSourceDocumentV2Schema,
  sessionContextSchema,
  type DefinitionResolutionSnapshot,
  type IdentitySession,
  type ModuleSourceDocumentV2,
  type SessionContext,
} from "../../contracts/src/index";
import type { DatabaseRow, DatabaseValue } from "../../db/src/index";
import { createResolvedRequestTransactionRunner } from "../../db/src/request-transaction";
import {
  createStoredApplicationPermissionSource,
  type StoredApplicationPermissionSourceDependencies,
} from "../../runtime/access/src/index";
import {
  compileDefinition,
  extractSourceIdentityRequirements,
  fingerprintCanonicalValue,
} from "../../runtime/definition/src/index";
import { createRecordSaveService } from "../../runtime/record/src/index";
import postgres, { type Row, type Sql, type TransactionSql } from "postgres";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.VORTEX_TEST_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const id = (value: number) => `a4470000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const tenantId = id(1);
const organizationId = id(2);
const actorId = id(3);
const identityAuthorityId = id(4);
const identityId = id(5);
const organizationAccountId = id(6);
const moduleRootId = id(7);
const applicationRootId = id(8);
const roleId = id(9);
const roleAssignmentId = id(10);
const fixtureCorrelationId = id(11);
const commandCreateId = id(12);
const commandUpdateId = id(13);
const activityCreateId = id(14);
const activityUpdateId = id(15);
const occurrenceCreateId = id(16);
const occurrenceUpdateId = id(17);
const commandRevokedWriteId = id(29);
const activityReplayId = id(30);
const activityConflictId = id(31);
const activityRevokedReplayId = id(32);
const activityRevokedWriteId = id(33);
const publishedAt = "2026-09-13T00:00:00.000Z";

const moduleSource: ModuleSourceDocumentV2 = moduleSourceDocumentV2Schema.parse({
  source_contract_version: "2.0.0",
  kind: "module",
  root_alias: "module_record_save_proof",
  key: "example.record_save_proof",
  body: {
    name: "Record save proof Module",
    description: "Neutral compiled Module for the real Record save service proof.",
    dependencies: [],
    record_types: [
      {
        id: "record_item",
        storage_contract_id: "storage_item",
        key: "item",
        name: "Item",
        plural_name: "Items",
        storage_scope: "application_contained",
        ownership_mode: "none",
        title_field: "title",
        standard_actions: ["create", "read", "update"],
        custom_actions: ["action_note"],
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
        id: "permission_create",
        key: "example.record_save_proof.item.create",
        label: "Create item",
        description: "Create a neutral proof item.",
        record_type: "item",
        action_kind: "create",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: ["title"], changeable_fields: ["title"] },
      },
      {
        id: "permission_read",
        key: "example.record_save_proof.item.read",
        label: "Read item",
        description: "Read a neutral proof item.",
        record_type: "item",
        action_kind: "read",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: ["title"], changeable_fields: [] },
      },
      {
        id: "permission_update",
        key: "example.record_save_proof.item.update",
        label: "Update item",
        description: "Update a neutral proof item.",
        record_type: "item",
        action_kind: "update",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: ["title"], changeable_fields: ["title"] },
      },
      {
        id: "permission_note",
        key: "example.record_save_proof.item.note",
        label: "Note item",
        description: "Run the unused named proof action.",
        record_type: "item",
        action_kind: "named",
        named_action: "note",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: ["title"], changeable_fields: [] },
      },
    ],
    actions: [
      {
        id: "action_note",
        key: "example.record_save_proof.item.note",
        label: "Note item",
        record_type: "item",
        permission: "example.record_save_proof.item.note",
        shareable: false,
        inputs: [],
        effects: [
          {
            kind: "announce_event",
            event: "example.record_save_proof.item.noted",
          },
        ],
      },
    ],
    events: [
      {
        id: "event_noted",
        key: "example.record_save_proof.item.noted",
        record_type: "item",
        carries: ["title"],
        personal_or_sensitive_values_allowed: false,
      },
    ],
    rules: [],
    sharing_conditions: [],
    extension_points: [],
  },
});

const applicationSource = definitionSourceDocumentSchema.parse({
  source_contract_version: "1.0.0",
  kind: "application",
  root_alias: "application_record_save_proof",
  key: "example.record_save_application",
  body: {
    name: "Record save proof",
    description: "Neutral Application for the real Record save service proof.",
    icon: "application",
    home_page: "home",
    module_bindings: [
      {
        module: moduleSource.key,
        version: { selection: "exact", version: "2.0.0" },
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
        key: "example.record_save_application.open",
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
        permissions: ["example.record_save_application.open"],
      },
    ],
    navigation: [],
    queries: [],
    block_registrations: [
      {
        id: "block_content",
        release_version: "1.0.0",
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
        permission: "example.record_save_application.open",
        states: ["normal"],
        blocks: [
          {
            id: "placement_content",
            block: "block_content",
            block_release_version: "1.0.0",
            settings: {},
            desktop: { start_column: 1, span: 12, height: 4 },
            phone: { order: 0, behaviour: "full_width" },
            view_permission: "example.record_save_application.open",
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

const sources = [moduleSource, applicationSource] as const;
const rootByKey = new Map([
  [moduleSource.key, moduleRootId],
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

const componentId = (kind: string, owner: string): string => {
  const entry = [...identityEntries.values()].find(
    (candidate) => candidate.kind === kind && candidate.componentOwner === owner,
  );
  if (entry === undefined) throw new Error(`Compiled identity missing for ${kind}:${owner}`);
  return entry.identifier;
};

const recordTypeId = componentId("record_type", "record_item");
const storageContractId = componentId("storage_contract", "storage_item");
const fieldId = componentId("field", "field_title");
const applicationRoleId = componentId("role", "role_user");
const homePageId = componentId("page", "page_home");

const resolutionDefinitions = [
  { kind: "module" as const, key: moduleSource.key, rootId: moduleRootId, exactVersion: "2.0.0" },
  {
    kind: "application" as const,
    key: applicationSource.key,
    rootId: applicationRootId,
    exactVersion: "1.0.0",
  },
];
const resolutionEvidence = {
  contractVersion: "1.0.0" as const,
  definitions: resolutionDefinitions,
  identities: [...identityEntries.values()],
};
const resolutionSnapshot = definitionResolutionSnapshotSchema.parse({
  ...resolutionEvidence,
  fingerprint: fingerprintCanonicalValue(resolutionEvidence),
});
const resolutionEvidenceV2 = { ...resolutionEvidence, contractVersion: "2.0.0" as const };
const resolutionSnapshotV2 = definitionResolutionSnapshotV2Schema.parse({
  ...resolutionEvidenceV2,
  fingerprint: fingerprintCanonicalValue(resolutionEvidenceV2),
});
const draftMetadata = {
  organizationId,
  draftRevision: 1,
  createdAt: publishedAt,
  createdBy: actorId,
  updatedAt: publishedAt,
  updatedBy: actorId,
};
const moduleOutput = compileDefinition({
  sourceContractVersion: "2.0.0",
  validationContractVersion: "2.0.0",
  source: moduleSource,
  resolution: resolutionSnapshotV2,
  draftMetadata,
  savedConditionRevisions: [],
});
const applicationOutput = compileDefinition({
  source: applicationSource,
  resolution: resolutionSnapshot,
  draftMetadata,
  savedConditionRevisions: [],
});
if (moduleOutput.kind !== "module" || applicationOutput.kind !== "application")
  throw new Error("Record save compiler output kind mismatch");

const moduleRelease = moduleDefinitionConsumerReadResultV2Schema.parse({
  kind: "module",
  organizationId,
  definitionKey: moduleOutput.artifact.definitionKey,
  rootId: moduleOutput.artifact.rootId,
  releaseRevision: 1,
  releaseVersion: "2.0.0",
  validationContractVersion: "2.0.0",
  contentFingerprint: moduleOutput.artifact.contentFingerprint,
  resolutionFingerprint: moduleOutput.resolutionFingerprint,
  content: moduleOutput.canonical.content,
  dependencyManifest: [],
  correlationId: fixtureCorrelationId,
});
const moduleDependency = {
  kind: "module" as const,
  key: moduleRelease.definitionKey,
  rootId: moduleRelease.rootId,
  releaseRevision: 1,
  releaseVersion: moduleRelease.releaseVersion,
  contentFingerprint: moduleRelease.contentFingerprint,
  resolutionFingerprint: moduleRelease.resolutionFingerprint,
};
const applicationRelease = applicationDefinitionConsumerReadResultV1Schema.parse({
  kind: "application",
  organizationId,
  definitionKey: applicationOutput.artifact.definitionKey,
  rootId: applicationOutput.artifact.rootId,
  releaseRevision: 1,
  releaseVersion: "1.0.0",
  validationContractVersion: "1.0.0",
  contentFingerprint: applicationOutput.artifact.contentFingerprint,
  resolutionFingerprint: applicationOutput.resolutionFingerprint,
  content: applicationOutput.canonical.content,
  dependencyManifest: [moduleDependency],
  correlationId: fixtureCorrelationId,
});

const requestTransaction = (transaction: TransactionSql) => ({
  query: async <ResultRow extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ) => (await transaction<ResultRow[] & Row[]>(strings, ...values)) as readonly ResultRow[],
});

type ResolvedRequestTransaction = NonNullable<
  StoredApplicationPermissionSourceDependencies["resolvedRequestTransaction"]
>;

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

// Fixture-owned recovery for this one proof's exact identifiers. The proof's
// tenant, organisation, identity, account, both Definition roots, its Access
// and Module state, and the Record/queue effects of its own saves may only be
// removed after the organisation still names the proof's tenant and creator and
// both roots are present. An absent fixture is a no-op so this can run before
// setup; a partial or foreign fixture fails loudly instead of being deleted.
const fixtureStorageTable = `record_data.rt_${storageContractId.replaceAll("-", "")}`;

const cleanRecordSaveFixture = async (admin: Sql): Promise<void> => {
  const [state] = await admin.unsafe<
    { present: string; tenant: string; owned: string; roots: string }[]
  >(
    `select
      (select pg_catalog.count(*)::text from vortex_identity.organizations
        where organization_id = $1) as present,
      (select pg_catalog.count(*)::text from vortex_identity.tenants
        where tenant_id = $2) as tenant,
      (select pg_catalog.count(*)::text from vortex_identity.organizations
        where organization_id = $1 and tenant_id = $2 and created_by = $3) as owned,
      (select pg_catalog.count(*)::text from vortex_definition.roots
        where organization_id = $1 and created_by = $3
          and root_id in ($4, $5)) as roots`,
    [organizationId, tenantId, actorId, moduleRootId, applicationRootId],
  );
  if (state === undefined)
    throw new Error("Record save integration fixture verification returned no result");
  if (state.present === "0" && state.tenant === "0" && state.owned === "0" && state.roots === "0")
    return;
  if (state.present !== "1" || state.tenant !== "1" || state.owned !== "1" || state.roots !== "2")
    throw new Error("Record save integration fixture ownership mismatch");

  await admin.unsafe(`
    begin;
    set local session_replication_role = replica;
    set local role vortex_record_owner;
    drop table if exists ${fixtureStorageTable};
    delete from vortex_record.record_reference_counters
      where organization_id = '${organizationId}';
    delete from vortex_record.record_data_versions
      where organization_id = '${organizationId}';
    delete from vortex_record.relationship_edges
      where from_storage_contract_id = '${storageContractId}'
         or to_storage_contract_id = '${storageContractId}';
    delete from vortex_record.relationship_storage_mappings
      where module_root_id = '${moduleRootId}';
    delete from vortex_record.field_storage_mappings
      where storage_contract_id = '${storageContractId}';
    delete from vortex_record.storage_catalogue
      where storage_contract_id = '${storageContractId}';
    delete from vortex_record.release_provisions
      where module_root_id = '${moduleRootId}';
    reset role;
    set local role vortex_record_adapter;
    delete from vortex_record.save_command_receipts
      where organization_id = '${organizationId}';
    reset role;
    delete from pgmq.q_vortex_event_occurrences
      where message ->> 'occurrenceId' in ('${occurrenceCreateId}', '${occurrenceUpdateId}');
    delete from vortex_event.event_outbox
      where organization_id = '${organizationId}';
    set local role vortex_module_owner;
    delete from vortex_module.installation_bindings
      where organization_id = '${organizationId}';
    reset role;
    do $cleanup$
    declare
      target record;
    begin
      for target in
        select column_row.table_schema, column_row.table_name
        from information_schema.columns as column_row
        join information_schema.tables as table_row
          on table_row.table_schema = column_row.table_schema
          and table_row.table_name = column_row.table_name
          and table_row.table_type = 'BASE TABLE'
        where column_row.table_schema in ('vortex_access', 'vortex_activity', 'vortex_identity')
          and column_row.column_name = 'organization_id'
          and column_row.table_name <> 'organizations'
      loop
        execute pg_catalog.format('delete from %I.%I where organization_id = %L',
          target.table_schema, target.table_name, '${organizationId}');
      end loop;
    end
    $cleanup$;
    delete from vortex_definition.release_dependencies
      where root_id in ('${moduleRootId}', '${applicationRootId}');
    delete from vortex_definition.releases
      where root_id in ('${moduleRootId}', '${applicationRootId}');
    delete from vortex_definition.drafts
      where root_id in ('${moduleRootId}', '${applicationRootId}');
    delete from vortex_definition.roots
      where root_id in ('${moduleRootId}', '${applicationRootId}');
    delete from vortex_identity.organization_accounts where organization_id = '${organizationId}';
    delete from vortex_identity.identity_projections where identity_id = '${identityId}';
    delete from vortex_identity.organizations where organization_id = '${organizationId}';
    delete from vortex_identity.tenants where tenant_id = '${tenantId}';
    commit;
  `);
};

describeDatabase("compiled public Record save service PostgreSQL proof", () => {
  it("saves once, replays safely and applies current permission withdrawal", async () => {
    const admin = postgres(databaseUrl!, { max: 1, prepare: false });
    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = "vortex_runtime";
    runtimeUrl.password = "vortex-runtime-local-only";
    const runtime = postgres(runtimeUrl.toString(), { max: 1, prepare: false });
    const operationAt = new Date();
    const session: IdentitySession = {
      identityId,
      sessionId: id(18),
      authenticationStrength: "single_factor",
      accessTokenIssuedAt: new Date(operationAt.valueOf() - 60_000).toISOString(),
      accessTokenExpiresAt: new Date(operationAt.valueOf() + 3_600_000).toISOString(),
      primaryAuthenticatedAt: new Date(operationAt.valueOf() - 60_000).toISOString(),
    };

    let failure: unknown;
    try {
      await cleanRecordSaveFixture(admin);
      await admin.begin(async (transaction) => {
        await transaction`insert into vortex_identity.tenants (
          tenant_id, short_name, display_name, state, created_at, created_by,
          state_changed_at, revision
        ) values (
          ${tenantId}, 'record_save_service', 'Record save service', 'active',
          pg_catalog.statement_timestamp(), ${actorId}, pg_catalog.statement_timestamp(), 1
        )`;
        await transaction`insert into vortex_identity.organizations (
          organization_id, tenant_id, short_name, display_name, state, created_at,
          created_by, state_changed_at, revision
        ) values (
          ${organizationId}, ${tenantId}, 'record_save_service', 'Record save service', 'active',
          pg_catalog.statement_timestamp(), ${actorId}, pg_catalog.statement_timestamp(), 1
        )`;
        await transaction`select * from vortex_identity.ensure_identity_projection(
          ${identityId}::uuid, ${id(19)}::uuid
        )`;
        await transaction`insert into vortex_identity.organization_accounts (
          organization_account_id, organization_id, identity_id, display_name, state,
          activated_at, changed_at, state_changed_at, state_changed_by,
          state_change_correlation_id, revision
        ) values (
          ${organizationAccountId}, ${organizationId}, ${identityId}, 'Record save actor', 'active',
          pg_catalog.statement_timestamp() - interval '1 minute',
          pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(), ${actorId},
          ${id(20)}, 1
        )`;
        await transaction`select * from vortex_access.initialize_organization_access_version(
          ${organizationId}::uuid, ${actorId}::uuid, ${id(21)}::uuid
        )`;

        for (const release of [moduleRelease, applicationRelease]) {
          const source = release.kind === "module" ? moduleSource : applicationSource;
          const output = release.kind === "module" ? moduleOutput : applicationOutput;
          const sourceFingerprint = fingerprintCanonicalValue(source);
          await transaction`insert into vortex_definition.roots (
            root_id, organization_id, kind, key, created_at, created_by
          ) values (
            ${release.rootId}, ${organizationId}, ${release.kind}, ${release.definitionKey},
            pg_catalog.statement_timestamp(), ${actorId}
          )`;
          await transaction`insert into vortex_definition.drafts (
            root_id, draft_revision, draft_source, identity_requirements,
            source_contract_version, source_fingerprint, updated_at, updated_by
          ) values (
            ${release.rootId}, 1, ${JSON.stringify(source)}::text::jsonb,
            ${JSON.stringify(extractSourceIdentityRequirements(source))}::text::jsonb,
            ${release.validationContractVersion}, ${sourceFingerprint},
            pg_catalog.statement_timestamp(), ${actorId}
          )`;
          await transaction`delete from vortex_context.request_contexts
            where backend_pid = pg_catalog.pg_backend_pid()`;
          await transaction`select vortex_context.initialize(${JSON.stringify({
            callerKind: "system",
            tenantId,
            organizationId,
            systemActorId: actorId,
            sessionId: id(22),
            authenticationStrength: "service",
            issuedAt: new Date(operationAt.valueOf() - 60_000).toISOString(),
            expiresAt: new Date(operationAt.valueOf() + 3_600_000).toISOString(),
            accessVersion: 1,
            correlationId: fixtureCorrelationId,
          })}::text::jsonb)`;
          await transaction`select * from vortex_definition.append_release(
            ${release.rootId}, 1, ${sourceFingerprint},
            ${JSON.stringify({
              releaseVersion: release.releaseVersion,
              compilationOutput: output,
              resolutionSnapshot:
                release.kind === "module" ? resolutionSnapshotV2 : resolutionSnapshot,
              contentFingerprint: release.contentFingerprint,
              resolutionFingerprint: release.resolutionFingerprint,
              validationContractVersion: release.validationContractVersion,
              comparisonFingerprint: release.contentFingerprint,
              impactReasons: [],
              releaseNote: `Compiled Record save proof ${release.definitionKey}.`,
              dependencies: release.dependencyManifest,
            })}::text::jsonb
          )`;
        }
        await transaction`delete from vortex_context.request_contexts
          where backend_pid = pg_catalog.pg_backend_pid()`;

        const systemContext = sessionContextSchema.parse({
          callerKind: "system",
          tenantId,
          organizationId,
          applicationRootId,
          systemActorId: actorId,
          sessionId: id(23),
          authenticationStrength: "service",
          issuedAt: new Date(operationAt.valueOf() - 60_000).toISOString(),
          expiresAt: new Date(operationAt.valueOf() + 3_600_000).toISOString(),
          accessVersion: 1,
          correlationId: fixtureCorrelationId,
        } satisfies SessionContext);
        const registration = await createStoredApplicationPermissionSource({
          systemContext,
          applicationRootId,
          releaseRevision: 1,
          definitionCatalogue: { connectionTypeReleases: [], platformThemeReleases: [] },
          resolvedRequestTransaction: resolvedRequestRunner(transaction),
        }).readExact();
        expect(registration.permissionRegistration.entries).toHaveLength(5);
        const registeredPermissionKeys = registration.permissionRegistration.entries.map(
          (entry) => entry.permission.key,
        );
        await transaction`select * from vortex_access.coordinate_application_access_change(
          'register', null::bigint,
          ${JSON.stringify({
            contractVersion: "1.0.0",
            preparationBasis: { kind: "registration_candidate" },
            permissionRegistration: registration.permissionRegistration,
            templates: [
              {
                template: {
                  roleId: applicationRoleId,
                  key: "user",
                  name: "User",
                  homePageId,
                  permissionKeys: registeredPermissionKeys,
                  permissionSelection: { kind: "exact" },
                },
                sourceTemplateFingerprint: fingerprintCanonicalValue({
                  applicationRoleId,
                  registeredPermissionKeys,
                }),
                sourcePermissions: registration.permissionRegistration.entries,
                livePermissions: registration.permissionRegistration.entries,
              },
            ],
            candidateFingerprint: fingerprintCanonicalValue(registration.permissionRegistration),
          })}::text::jsonb,
          ${organizationId}::uuid, ${applicationRootId}::uuid,
          ${actorId}::uuid, ${id(24)}::uuid
        )`;

        const [permissionRow] = await transaction<{ permissions: unknown }[]>`
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'kind', 'exact',
            'applicationRootId', entry.application_root_id,
            'ownerKind', entry.owner_kind,
            'ownerId', entry.owner_id,
            'permissionId', entry.permission_id,
            'acceptedRegistrationRevision', registration.revision,
            'catalogueFingerprint', registration.permission_catalogue_fingerprint,
            'continuityRevision', continuity.continuity_revision,
            'meaningFingerprint', entry.meaning_fingerprint
          ) order by entry.owner_kind collate "C", entry.owner_id::text collate "C",
            entry.permission_id::text collate "C") as permissions
          from vortex_access.permission_registrations as registration
          join vortex_access.permission_catalogue_entries as entry
            on entry.organization_id = registration.organization_id
            and entry.registration_kind = registration.registration_kind
            and entry.registration_owner_id = registration.registration_owner_id
            and entry.registration_revision = registration.revision
          join vortex_access.permission_continuities as continuity
            on continuity.organization_id = entry.organization_id
            and continuity.application_root_id is not distinct from entry.application_root_id
            and continuity.owner_kind = entry.owner_kind
            and continuity.owner_id = entry.owner_id
            and continuity.permission_id = entry.permission_id
          where registration.organization_id = ${organizationId}::uuid
            and registration.registration_kind = 'application'
            and registration.registration_owner_id = ${applicationRootId}::uuid
            and registration.state = 'active'
        `;
        if (!Array.isArray(permissionRow?.permissions))
          throw new Error("Compiled Record permission references are missing");
        await transaction`select * from vortex_access.coordinate_organization_role_change(
          ${JSON.stringify({
            contractVersion: "1.0.0",
            candidate: {
              operation: "create_custom",
              organizationId,
              roleId,
              key: "record_save_operator",
              label: "Record save operator",
              description: "Standing access for the neutral real-service proof.",
              privilegeClassification: "standard",
              assignmentPolicy: { kind: "standing" },
              permissions: permissionRow.permissions,
            },
            roleCandidateFingerprint: fingerprintCanonicalValue({ roleId, revision: 1 }),
          })}::text::jsonb,
          ${actorId}::uuid, ${id(25)}::uuid
        )`;
        await transaction`select * from vortex_access.coordinate_organization_role_assignment_change(
          'grant', ${organizationId}::uuid, ${roleAssignmentId}::uuid, null::bigint,
          ${roleId}::uuid, 1::bigint, 'organization_account',
          ${organizationAccountId}::uuid, null::uuid, 'standing',
          pg_catalog.statement_timestamp() - interval '1 minute', null::timestamptz,
          ${actorId}::uuid, ${id(26)}::uuid
        )`;

        await transaction`set local role vortex_module_owner`;
        await transaction`select * from vortex_record.provision_exact_module_storage(
          ${moduleRootId}::uuid, 1
        )`;
        await transaction`insert into vortex_module.installation_bindings (
          organization_id, application_root_id, module_root_id, binding_revision,
          application_release_revision, module_release_revision, state,
          content_fingerprint, resolution_fingerprint, generator_contract_version,
          storage_contract_ids
        ) values (
          ${organizationId}, ${applicationRootId}, ${moduleRootId}, 1, 1, 1, 'active',
          ${moduleRelease.contentFingerprint}, ${moduleRelease.resolutionFingerprint},
          '1.0.0', array[${storageContractId}::uuid]
        )`;
        await transaction`reset role`;
      });

      const resolvedRequestTransaction = createResolvedRequestTransactionRunner({
        transaction: async <Result>(
          operation: (transaction: {
            query<ResultRow extends DatabaseRow = DatabaseRow>(
              strings: TemplateStringsArray,
              ...values: readonly DatabaseValue[]
            ): Promise<readonly ResultRow[]>;
          }) => Promise<Result>,
        ) =>
          runtime.begin(async (transaction) =>
            operation(requestTransaction(transaction)),
          ) as Promise<Result>,
      });
      const activityIds = [
        activityCreateId,
        activityUpdateId,
        activityReplayId,
        activityConflictId,
        activityRevokedReplayId,
        activityRevokedWriteId,
      ];
      const occurrenceIds = [occurrenceCreateId, occurrenceUpdateId];
      const service = createRecordSaveService({
        identityAuthorityId,
        clock: () => operationAt,
        correlationId: () => id(27),
        activityId: () => {
          const value = activityIds.shift();
          if (value === undefined) throw new Error("Unexpected extra Activity allocation");
          return value;
        },
        occurrenceId: () => {
          const value = occurrenceIds.shift();
          if (value === undefined) throw new Error("Unexpected extra Event allocation");
          return value;
        },
        resolvedRequestTransaction,
      });
      const selection = { organizationId, applicationRootId };
      const createCommand = {
        contractVersion: "2.0.0",
        commandId: commandCreateId,
        operation: "create",
        recordTypeId,
        submittedValues: { [fieldId]: "Created once" },
      };
      const created = await service.save(session, selection, createCommand);
      expect(created).toMatchObject({
        kind: "available",
        value: {
          outcome: "saved",
          concurrencyNumber: 1,
          readableValues: { [fieldId]: "Created once" },
        },
      });
      if (created.kind !== "available" || created.value.outcome !== "saved")
        throw new Error("Real service create did not return its Record");
      const recordId = created.value.recordId;

      const updateCommand = {
        contractVersion: "2.0.0",
        commandId: commandUpdateId,
        operation: "update",
        recordTypeId,
        recordId,
        expectedConcurrencyNumber: 1,
        submittedValues: { [fieldId]: "Updated once" },
      };
      await expect(service.save(session, selection, updateCommand)).resolves.toMatchObject({
        kind: "available",
        value: {
          outcome: "saved",
          recordId,
          concurrencyNumber: 2,
          readableValues: { [fieldId]: "Updated once" },
        },
      });
      await expect(service.save(session, selection, updateCommand)).resolves.toMatchObject({
        kind: "available",
        value: {
          outcome: "saved",
          recordId,
          concurrencyNumber: 2,
          readableValues: { [fieldId]: "Updated once" },
        },
      });
      await expect(
        service.save(session, selection, {
          ...updateCommand,
          submittedValues: { [fieldId]: "Conflicting content" },
        }),
      ).resolves.toMatchObject({
        kind: "available",
        value: { outcome: "refused", error: { code: "conflict" } },
      });

      const storageTable = `record_data.rt_${storageContractId.replaceAll("-", "")}`;
      const fieldColumn = `f_${fieldId.replaceAll("-", "")}`;
      const [evidence] = await admin.unsafe<
        {
          title: string;
          concurrency_number: string;
          receipt_count: string;
          activity_count: string;
          outbox_count: string;
          queue_count: string;
        }[]
      >(
        `select record.${fieldColumn} as title, record.concurrency_number::text,
          (select pg_catalog.count(*)::text from vortex_record.save_command_receipts
           where organization_id = $1) as receipt_count,
          (select pg_catalog.count(*)::text from vortex_activity.organization_activity_entries
           where organization_id = $1 and activity_id in ($3, $4)) as activity_count,
          (select pg_catalog.count(*)::text from vortex_event.event_outbox
           where organization_id = $1) as outbox_count,
          (select pg_catalog.count(*)::text from pgmq.q_vortex_event_occurrences as queued
           join vortex_event.event_outbox as event
             on queued.message ->> 'occurrenceId' = event.occurrence_id::text
           where event.organization_id = $1) as queue_count
         from ${storageTable} as record
         where record.organisation_id = $1 and record.record_id = $2`,
        [organizationId, recordId, activityCreateId, activityUpdateId],
      );
      expect(evidence).toEqual({
        title: "Updated once",
        concurrency_number: "2",
        receipt_count: "2",
        activity_count: "2",
        outbox_count: "2",
        queue_count: "2",
      });
      expect(moduleRelease.content.recordTypes[0]?.customActionIds).toHaveLength(1);
      expect(moduleRelease.content.events).toHaveLength(1);

      const readPersistedState = async () => {
        const [state] = await admin.unsafe<
          {
            title: string;
            concurrency_number: string;
            receipt_count: string;
            outbox_count: string;
            queue_count: string;
          }[]
        >(
          `select record.${fieldColumn} as title, record.concurrency_number::text,
            (select pg_catalog.count(*)::text from vortex_record.save_command_receipts
             where organization_id = $1) as receipt_count,
            (select pg_catalog.count(*)::text from vortex_event.event_outbox
             where organization_id = $1) as outbox_count,
            (select pg_catalog.count(*)::text from pgmq.q_vortex_event_occurrences as queued
             join vortex_event.event_outbox as event
               on queued.message ->> 'occurrenceId' = event.occurrence_id::text
             where event.organization_id = $1) as queue_count
           from ${storageTable} as record
           where record.organisation_id = $1 and record.record_id = $2`,
          [organizationId, recordId],
        );
        if (state === undefined) throw new Error("Persisted Record save state is missing");
        return state;
      };

      await admin`select * from vortex_access.coordinate_organization_role_assignment_change(
        'revoke', ${organizationId}::uuid, ${roleAssignmentId}::uuid, 1::bigint,
        null::uuid, null::bigint, null::text, null::uuid, null::uuid, null::text,
        null::timestamptz, null::timestamptz, ${actorId}::uuid, ${id(28)}::uuid
      )`;
      await expect(service.save(session, selection, updateCommand)).resolves.toEqual({
        kind: "available",
        value: {
          contractVersion: "2.0.0",
          outcome: "refused",
          error: {
            code: "operation_refused",
            messageKey: "errors.operation_refused",
            correlationId: id(27),
          },
        },
      });

      const beforeRevokedWrite = await readPersistedState();
      await expect(
        service.save(session, selection, {
          ...updateCommand,
          commandId: commandRevokedWriteId,
          expectedConcurrencyNumber: 2,
          submittedValues: { [fieldId]: "Changed after revocation" },
        }),
      ).resolves.toEqual({ kind: "unavailable" });
      const afterRevokedWrite = await readPersistedState();
      expect(afterRevokedWrite).toEqual(beforeRevokedWrite);

      expect(activityIds).toEqual([]);
      expect(occurrenceIds).toEqual([]);
    } catch (error) {
      failure = error;
    } finally {
      try {
        await runtime.end({ timeout: 1 });
      } catch (error) {
        if (failure === undefined) failure = error;
      }
      try {
        await cleanRecordSaveFixture(admin);
      } catch (error) {
        if (failure === undefined) failure = error;
      }
      try {
        await admin.end({ timeout: 1 });
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
    if (failure !== undefined) throw failure;
  }, 45_000);
});
