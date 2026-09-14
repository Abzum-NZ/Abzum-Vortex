import {
  applicationDefinitionConsumerReadResultV1Schema,
  definitionResolutionSnapshotSchema,
  definitionResolutionSnapshotV2Schema,
  definitionSourceDocumentSchema,
  eventOccurrenceEnvelopeV2Schema,
  moduleDefinitionConsumerReadResultV2Schema,
  moduleSourceDocumentV2Schema,
  sessionContextSchema,
  type DefinitionResolutionSnapshot,
  type ModuleSourceDocumentV2,
  type SessionContext,
} from "../../contracts/src/index";
import {
  compileDefinition,
  extractSourceIdentityRequirements,
  fingerprintCanonicalValue,
  projectInstalledEventCatalogue,
} from "../../runtime/definition/src/index";
import { validateInstalledEventOccurrence } from "../../runtime/event/src/index";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.VORTEX_TEST_DATABASE_URL;
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const id = (value: number) => `a4850000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const tenantId = id(1);
const organizationId = id(2);
const actorId = id(3);
const identityId = id(4);
const accountId = id(5);
const moduleRootId = id(6);
const applicationRootId = id(7);
const recordTypeId = id(8);
const storageContractId = id(9);
const fieldId = id(10);
const eventId = id(11);
const recordId = id(12);
const occurrenceId = id(13);
const correlationId = id(14);
const standardOccurrenceId = id(15);
const publishedAt = "2026-09-12T00:00:00.000Z";

const moduleSource: ModuleSourceDocumentV2 = moduleSourceDocumentV2Schema.parse({
  source_contract_version: "2.0.0",
  kind: "module",
  root_alias: "module_event_append",
  key: "example.event_append",
  body: {
    name: "Event append proof module",
    description: "Neutral Module compiled for the private Event append proof.",
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
        standard_actions: ["create", "read", "update"],
        custom_actions: [],
        fields: [
          {
            id: "field_title",
            key: "title",
            type: "text",
            label: "Title",
            required: false,
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
    events: [
      {
        id: "event_reviewed",
        key: "example.item.reviewed",
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
  root_alias: "application_event_append",
  key: "example.event_application",
  body: {
    name: "Event append proof",
    description: "Neutral Application bound to the compiled proof Module.",
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
        key: "example.application.open",
        label: "Open application",
        description: "Open the neutral Event proof Application.",
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
        permission: "example.application.open",
        states: ["normal"],
        blocks: [
          {
            id: "placement_content",
            block: "block_content",
            block_release_version: "1.0.0",
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

const sources = [moduleSource, applicationSource] as const;
const rootByKey = new Map([
  [moduleSource.key, moduleRootId],
  [applicationSource.key, applicationRootId],
]);
const fixedIdentityByOwner = new Map([
  ["record_type:record_item", recordTypeId],
  ["storage_contract:storage_item", storageContractId],
  ["field:field_title", fieldId],
  ["event:event_reviewed", eventId],
]);
let nextIdentity = 100;
const identityEntries = new Map<string, DefinitionResolutionSnapshot["identities"][number]>();
for (const source of sources)
  for (const requirement of extractSourceIdentityRequirements(source)) {
    const fixed = fixedIdentityByOwner.get(`${requirement.kind}:${requirement.componentOwner}`);
    const identifier =
      requirement.kind === "root"
        ? rootByKey.get(requirement.definitionKey)!
        : (fixed ?? id(nextIdentity++));
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
  throw new Error("Event append compiler output kind mismatch");

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
  correlationId,
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
  correlationId,
});

const rollbackProof = new Error("ROLLBACK_EVENT_APPEND_PROOF");

describeDatabase("compiled private Event append PostgreSQL proof", () => {
  it("publishes, provisions and appends a runtime-validated V2 occurrence", async () => {
    const sql = postgres(databaseUrl!, { max: 1, prepare: false });
    try {
      try {
        await sql.begin(async (transaction) => {
          await transaction`insert into vortex_identity.tenants (
            tenant_id, short_name, display_name, state, created_at, created_by,
            state_changed_at, revision
          ) values (
            ${tenantId}, 'event_compiled', 'Event compiled', 'active',
            pg_catalog.statement_timestamp(), ${actorId}, pg_catalog.statement_timestamp(), 1
          )`;
          await transaction`insert into vortex_identity.organizations (
            organization_id, tenant_id, short_name, display_name, state, created_at,
            created_by, state_changed_at, revision
          ) values (
            ${organizationId}, ${tenantId}, 'event_compiled', 'Event compiled', 'active',
            pg_catalog.statement_timestamp(), ${actorId}, pg_catalog.statement_timestamp(), 1
          )`;
          await transaction`select * from vortex_identity.ensure_identity_projection(
            ${identityId}::uuid, ${id(90)}::uuid
          )`;
          await transaction`insert into vortex_identity.organization_accounts (
            organization_account_id, organization_id, identity_id, display_name, state,
            activated_at, changed_at, state_changed_at, state_changed_by,
            state_change_correlation_id, revision
          ) values (
            ${accountId}, ${organizationId}, ${identityId}, 'Event actor', 'active',
            pg_catalog.statement_timestamp() - interval '1 minute',
            pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(), ${actorId},
            ${id(91)}, 1
          )`;
          await transaction`select * from vortex_access.initialize_organization_access_version(
            ${organizationId}::uuid, ${actorId}::uuid, ${id(92)}::uuid
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
              sessionId: id(93),
              authenticationStrength: "service",
              issuedAt: new Date(Date.now() - 1_000).toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              accessVersion: 1,
              correlationId,
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
                releaseNote: `Compiled Event proof ${release.definitionKey}.`,
                dependencies: release.dependencyManifest,
              })}::text::jsonb
            )`;
          }
          await transaction`delete from vortex_context.request_contexts
            where backend_pid = pg_catalog.pg_backend_pid()`;

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

          const humanContext = sessionContextSchema.parse({
            callerKind: "human",
            identityAuthorityId: actorId,
            tenantId,
            organizationId,
            organizationAccountId: accountId,
            identityId,
            applicationRootId,
            sessionId: id(94),
            authenticationStrength: "single_factor",
            issuedAt: new Date(Date.now() - 1_000).toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            accessVersion: 1,
            correlationId,
            accessTokenIssuedAt: new Date(Date.now() - 1_000).toISOString(),
            primaryAuthenticatedAt: new Date(Date.now() - 1_000).toISOString(),
          } satisfies SessionContext);
          await transaction`select vortex_context.initialize(
            ${JSON.stringify(humanContext)}::text::jsonb
          )`;
          await transaction`set local role vortex_record_adapter`;
          await transaction.unsafe(
            `insert into record_data.rt_${storageContractId.replaceAll("-", "")} (
              organisation_id, module_root_id, record_type_id, storage_contract_id,
              record_id, application_root_id, definition_revision,
              owner_organisation_account_id, owner_group_id, lifecycle_state,
              concurrency_number, created_at, created_by, updated_at, updated_by,
              f_${fieldId.replaceAll("-", "")}
            ) values ($1,$2,$3,$4,$5,null,1,null,null,'active',1,
              pg_catalog.statement_timestamp(),$6,pg_catalog.statement_timestamp(),$6,$7)`,
            [
              organizationId,
              moduleRootId,
              recordTypeId,
              storageContractId,
              recordId,
              accountId,
              "Ready",
            ],
          );

          const installation = {
            organizationId,
            applicationRootId,
            applicationReleaseRevision: 1,
            moduleBindings: [
              {
                organizationId,
                applicationRootId,
                moduleRootId,
                bindingRevision: 1,
                applicationReleaseRevision: 1,
                moduleReleaseRevision: 1,
                state: "active" as const,
              },
            ],
          };
          const definitions = { application: applicationRelease, modules: [moduleRelease] };
          const catalogue = projectInstalledEventCatalogue({ definitions, installation });
          const descriptor = catalogue.descriptors.find(
            (candidate) => candidate.kind === "declared" && candidate.declarationId === eventId,
          );
          if (descriptor === undefined) throw new Error("Compiled Event descriptor is missing");
          const standardDescriptor = catalogue.descriptors.find(
            (candidate) => candidate.kind === "standard" && candidate.eventKind === "created",
          );
          if (standardDescriptor === undefined)
            throw new Error("Compiled standard Event descriptor is missing");
          const validated = validateInstalledEventOccurrence(
            {
              definitions,
              installation,
            },
            {
              contractVersion: "2.0.0",
              occurrenceId,
              organizationId,
              installation: {
                applicationRootId,
                applicationReleaseRevision: 1,
                moduleBinding: {
                  moduleRootId,
                  moduleReleaseRevision: 1,
                  bindingRevision: 1,
                },
              },
              descriptor,
              definitionRelease: {
                kind: "module",
                rootId: moduleRootId,
                releaseRevision: 1,
                releaseVersion: moduleRelease.releaseVersion,
                contentFingerprint: moduleRelease.contentFingerprint,
                resolutionFingerprint: moduleRelease.resolutionFingerprint,
              },
              recordId,
              occurredAt: new Date().toISOString(),
              actorId: accountId,
              correlationId,
              recordSequence: 1,
              payload: { kind: "declared", carriedValues: { [fieldId]: "Ready" } },
            },
          );
          const validatedStandard = validateInstalledEventOccurrence(
            { definitions, installation },
            {
              contractVersion: "2.0.0",
              occurrenceId: standardOccurrenceId,
              organizationId,
              installation: {
                applicationRootId,
                applicationReleaseRevision: 1,
                moduleBinding: {
                  moduleRootId,
                  moduleReleaseRevision: 1,
                  bindingRevision: 1,
                },
              },
              descriptor: standardDescriptor,
              definitionRelease: {
                kind: "module",
                rootId: moduleRootId,
                releaseRevision: 1,
                releaseVersion: moduleRelease.releaseVersion,
                contentFingerprint: moduleRelease.contentFingerprint,
                resolutionFingerprint: moduleRelease.resolutionFingerprint,
              },
              recordId,
              occurredAt: new Date().toISOString(),
              actorId: accountId,
              correlationId,
              recordSequence: 2,
              payload: { kind: "created" },
            },
          );
          const [row] = await transaction<{ envelopes: unknown }[]>`
            select vortex_event.append_record_occurrences(
              ${storageContractId}::uuid, ${recordId}::uuid,
              ${JSON.stringify([
                {
                  occurrenceId,
                  descriptor: validated.descriptor,
                  payload: validated.payload,
                },
                {
                  occurrenceId: standardOccurrenceId,
                  descriptor: validatedStandard.descriptor,
                  payload: validatedStandard.payload,
                },
              ])}::text::jsonb
            ) as envelopes
          `;
          await transaction`reset role`;
          const envelopes = eventOccurrenceEnvelopeV2Schema.array().parse(row?.envelopes);
          expect(envelopes).toHaveLength(2);
          const [envelope, standardEnvelope] = envelopes;
          if (envelope === undefined || standardEnvelope === undefined)
            throw new Error("Database Event append did not return its complete batch");
          expect(envelope).toMatchObject({
            occurrenceId,
            organizationId,
            actorId: accountId,
            correlationId,
            recordId,
            recordSequence: 1,
          });
          expect(envelope.installation.applicationRootId).toBe(applicationRootId);
          expect(envelope.definitionRelease).toMatchObject({
            kind: "module",
            rootId: moduleRootId,
            releaseRevision: 1,
          });
          expect(standardEnvelope).toMatchObject({
            occurrenceId: standardOccurrenceId,
            descriptor: { kind: "standard", eventKind: "created", recordTypeId },
            payload: { kind: "created" },
            recordSequence: 2,
          });
          const queue = await transaction<
            { message: { contractVersion: string; occurrenceId: string } }[]
          >`
            select message from pgmq.q_vortex_event_occurrences
            where message ->> 'occurrenceId' in (${occurrenceId}, ${standardOccurrenceId})
            order by msg_id
          `;
          expect(queue.map((item) => item.message)).toEqual([
            { contractVersion: "2.0.0", occurrenceId },
            { contractVersion: "2.0.0", occurrenceId: standardOccurrenceId },
          ]);

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
