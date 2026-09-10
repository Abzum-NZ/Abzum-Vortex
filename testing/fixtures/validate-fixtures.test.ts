import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  definitionResolutionSnapshotSchema,
  definitionResolutionSnapshotV2Schema,
  definitionSourceDocumentSchema,
  fieldTypeKeys,
  moduleSourceDocumentV2Schema,
  moduleSourceDocumentV3Schema,
  publishedModuleDefinitionSchema,
  ruleGraphSchema,
  sourceRuleGraphSchema,
  workflowNodeTypeKeys,
} from "@vortex/contracts";
import { compileDefinitionSet } from "@vortex/definition/compiler";

const root = path.resolve("testing/fixtures");
const read = (relative: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const historicalRoot = path.join(root, "historical/module-v1");
const readHistorical = (relative: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(historicalRoot, relative), "utf8"));
const manifest = read("fixture-set.json") as {
  files: string[];
  ruleGraphFixtures: Array<{ source: string; canonical: string }>;
  ruleGraphModuleFixtures: string[];
  requiredFieldTypes: string[];
  requiredWorkflowNodes: string[];
  requiredCrossApplicationCases: Array<{
    module: string;
    record_type: string;
    applications?: string[];
    source_application?: string;
    recipient_application?: string;
    requires_grant?: boolean;
  }>;
};
const definitionFiles = manifest.files.filter((file) =>
  /^(modules|applications|connection-types)\/.+\.json$/.test(file),
);
const sources = definitionFiles.map((file) => {
  const candidate = read(file);
  return typeof candidate === "object" &&
    candidate !== null &&
    "kind" in candidate &&
    candidate.kind === "module"
    ? moduleSourceDocumentV2Schema.parse(candidate)
    : definitionSourceDocumentSchema.parse(candidate);
});
const resolutionV1 = definitionResolutionSnapshotSchema.parse(
  read("definition-resolution-snapshot.json"),
);
const resolutionV2 = definitionResolutionSnapshotV2Schema.parse(
  read("module-v2-definition-resolution-snapshot.json"),
);
const historicalSources = definitionFiles.map((file) =>
  definitionSourceDocumentSchema.parse(readHistorical(file)),
);
const historicalResolution = definitionResolutionSnapshotSchema.parse(
  readHistorical("definition-resolution-snapshot.json"),
);
const draftMetadata = {
  organizationId: "10000000-0000-4000-a000-000000000001",
  draftRevision: 1,
  createdAt: "2026-09-01T00:00:00+00:00",
  createdBy: "10000000-0000-4000-a000-000000000002",
  updatedAt: "2026-09-01T00:00:00+00:00",
  updatedBy: "10000000-0000-4000-a000-000000000002",
} as const;
const currentDraftMetadata = {
  ...draftMetadata,
  draftRevision: 2,
  publishedRevision: 1,
} as const;
const savedConditionRevisions = (
  source: Extract<
    (typeof sources)[number] | (typeof historicalSources)[number],
    { kind: "module" }
  >,
  resolution: typeof resolutionV1 | typeof resolutionV2,
) =>
  source.body.sharing_conditions.map((condition) => {
    const identity = resolution.identities.find(
      (candidate) =>
        candidate.definitionKey === source.key &&
        candidate.kind === "sharing_condition" &&
        candidate.componentOwner === condition.id,
    );
    if (!identity) throw new Error(`Sharing-condition identity required for ${source.key}`);
    return { conditionId: identity.identifier, revision: 1 };
  });
const historicalOutputs = compileDefinitionSet(
  historicalSources.map((source) => ({
    source,
    resolution: historicalResolution,
    ...(source.kind === "connection_type" ? {} : { draftMetadata }),
    ...(source.kind === "module"
      ? { savedConditionRevisions: savedConditionRevisions(source, historicalResolution) }
      : {}),
  })),
  {
    publishedHistories: historicalSources
      .filter((source) => source.kind === "module" || source.kind === "application")
      .map((source) => ({ kind: source.kind, definitionKey: source.key, history: [] })),
  },
);
const historicalModulePublications = new Map(
  historicalOutputs
    .filter((output) => output.kind === "module")
    .map((output) => [
      output.artifact.definitionKey,
      {
        kind: "module" as const,
        rootId: output.artifact.rootId,
        revision: 1,
        releaseVersion: "1.0.0",
        contentFingerprint: output.artifact.contentFingerprint,
        publishedAt: draftMetadata.createdAt,
        publishedBy: draftMetadata.createdBy,
        validationContractVersion: "1.0.0",
      },
    ]),
);
const historicalPublishedHistories = historicalOutputs
  .filter((output) => output.kind === "module")
  .map((output) => {
    const entry = {
      publication: {
        kind: output.kind,
        rootId: output.artifact.rootId,
        revision: 1,
        releaseVersion: "1.0.0",
        contentFingerprint: output.artifact.contentFingerprint,
        publishedAt: draftMetadata.createdAt,
        publishedBy: draftMetadata.createdBy,
        validationContractVersion: "1.0.0",
      },
      content: output.canonical.content,
      dependencyManifest: output.resolvedDependencies.flatMap((dependency) => {
        if (dependency.kind !== "module") return [];
        const publication = historicalModulePublications.get(dependency.key);
        if (!publication)
          throw new Error(`Historical Module publication required for ${dependency.key}`);
        return [publication];
      }),
      releaseNote: "Historical Module V1 fixture baseline",
    };
    const history = publishedModuleDefinitionSchema.parse(entry);
    return {
      kind: output.kind,
      definitionKey: output.artifact.definitionKey,
      history: [history],
    };
  });

describe("complete fixture set", () => {
  it("lists every JSON fixture exactly once", () => {
    const visit = (directory: string): string[] =>
      fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
        const relative = path.posix.join(directory, entry.name);
        return entry.isDirectory()
          ? visit(relative)
          : entry.name.endsWith(".json")
            ? [relative]
            : [];
      });
    const actual = visit("")
      .filter((file) => file !== "fixture-set.json" && !file.startsWith("historical/"))
      .sort();
    expect([...manifest.files].sort()).toEqual(actual);
    expect(new Set(manifest.files).size).toBe(manifest.files.length);
  });

  it("classifies and validates every authored/canonical Rule graph fixture pair", () => {
    const classified = [
      ...manifest.ruleGraphModuleFixtures,
      ...manifest.ruleGraphFixtures.flatMap(({ source, canonical }) => [source, canonical]),
    ];
    const graphFiles = manifest.files.filter((file) => file.startsWith("rule-graphs/"));

    expect([...classified].sort()).toEqual([...graphFiles].sort());
    expect(new Set(classified).size).toBe(classified.length);
    for (const file of manifest.ruleGraphModuleFixtures)
      expect(moduleSourceDocumentV3Schema.safeParse(read(file)).success).toBe(true);
    for (const pair of manifest.ruleGraphFixtures) {
      expect(sourceRuleGraphSchema.safeParse(read(pair.source)).success).toBe(true);
      expect(ruleGraphSchema.safeParse(read(pair.canonical)).success).toBe(true);
    }
  });

  it("keeps the current pair-specific snapshots and historical Module V1 baseline explicit", () => {
    expect(resolutionV2.definitions).toEqual(resolutionV1.definitions);
    expect(resolutionV2.identities).toEqual(resolutionV1.identities);
    expect(resolutionV2.fingerprint).not.toBe(resolutionV1.fingerprint);
    expect(
      resolutionV2.definitions
        .filter((definition) => definition.kind === "module")
        .every((definition) => definition.exactVersion === "2.0.0"),
    ).toBe(true);
    expect(
      resolutionV1.definitions
        .filter((definition) => definition.kind === "module")
        .every((definition) => definition.exactVersion === "2.0.0"),
    ).toBe(true);
    expect(
      historicalResolution.definitions
        .filter((definition) => definition.kind === "module")
        .every((definition) => definition.exactVersion === "1.0.0"),
    ).toBe(true);
    expect(
      sources
        .filter((source) => source.kind === "module")
        .every((source) => source.source_contract_version === "2.0.0"),
    ).toBe(true);
    expect(
      historicalSources
        .filter((source) => source.kind === "module")
        .every((source) => source.source_contract_version === "1.0.0"),
    ).toBe(true);
  });

  it("parses, compiles and validates all thirteen definitions through shipping code", () => {
    expect(sources).toHaveLength(13);
    let outputs: ReturnType<typeof compileDefinitionSet>;
    try {
      outputs = compileDefinitionSet(
        sources.map((source) => ({
          source,
          resolution: source.kind === "module" ? resolutionV2 : resolutionV1,
          ...(source.kind === "module"
            ? {
                sourceContractVersion: "2.0.0" as const,
                validationContractVersion: "2.0.0" as const,
              }
            : {}),
          ...(source.kind === "connection_type"
            ? {}
            : { draftMetadata: source.kind === "module" ? currentDraftMetadata : draftMetadata }),
          ...(source.kind === "module"
            ? { savedConditionRevisions: savedConditionRevisions(source, resolutionV2) }
            : {}),
        })),
        {
          publishedHistories: [
            ...historicalPublishedHistories,
            ...sources
              .filter((source) => source.kind === "application")
              .map((source) => ({
                kind: "application" as const,
                definitionKey: source.key,
                history: [],
              })),
          ],
        },
      );
    } catch (error) {
      const detail = error as { message?: string; family?: string; location?: unknown };
      throw new Error(
        `${detail.message ?? "fixture compilation failed"}:${detail.family ?? "unknown"}:${JSON.stringify(detail.location)}`,
      );
    }
    expect(outputs).toHaveLength(13);
    expect(outputs.filter((output) => output.kind === "module")).toHaveLength(8);
    expect(outputs.filter((output) => output.kind === "application")).toHaveLength(2);
    expect(outputs.filter((output) => output.kind === "connection_type")).toHaveLength(3);
  });

  it("exercises every field type and workflow-node type", () => {
    const actualFieldTypes = new Set<string>();
    const actualWorkflowNodes = new Set<string>();
    for (const source of sources) {
      if (source.kind === "module")
        source.body.record_types.forEach((record) =>
          record.fields.forEach((field) => actualFieldTypes.add(field.type)),
        );
      if (source.kind === "application")
        source.body.workflows.forEach((workflow) =>
          workflow.nodes.forEach((node) => actualWorkflowNodes.add(node.type)),
        );
    }
    expect([...actualFieldTypes].sort()).toEqual([...fieldTypeKeys].sort());
    expect([...actualWorkflowNodes].sort()).toEqual([...workflowNodeTypeKeys].sort());
  });

  it("defines complete table columns and an explicit permission-gated choice", () => {
    const moduleSources = sources.filter((source) => source.kind === "module");
    for (const source of moduleSources)
      for (const record of source.body.record_types)
        for (const field of record.fields)
          if (field.type === "table")
            for (const column of field.settings.columns)
              expect(
                column.settings,
                `${source.key}:${record.key}.${field.key}.${column.key}`,
              ).toBeDefined();

    const sla = moduleSources.find((source) => source.key === "vortex.service_desk.sla");
    const workingHours = sla?.body.record_types
      .flatMap((record) => record.fields)
      .find((field) => field.type === "table" && field.key === "working_hours");
    if (!workingHours || workingHours.type !== "table") throw new Error("Working hours required");
    const weekday = workingHours.settings.columns.find((column) => column.key === "day");
    if (!weekday || weekday.type !== "choice") throw new Error("Weekday choice required");
    expect(weekday.settings.options.map((option) => option.label)).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);

    const opportunities = moduleSources.find((source) => source.key === "vortex.crm.opportunities");
    const opportunityFields = opportunities?.body.record_types.find(
      (record) => record.key === "opportunity",
    )?.fields;
    const schedule = opportunityFields?.find((field) => field.key === "payment_schedule");
    if (!schedule || schedule.type !== "table") throw new Error("Payment schedule required");
    expect(schedule.settings.columns.find((column) => column.key === "amount")).toMatchObject({
      type: "money",
      settings: { currency_mode: "fixed", currency: "NZD" },
    });
    const stage = opportunityFields?.find((field) => field.key === "stage");
    if (!stage || stage.type !== "choice") throw new Error("Opportunity stage required");
    expect(stage.settings.options.find((option) => option.value === "won")).toMatchObject({
      label: "Won",
      required_permission: "vortex.crm.opportunities.opportunity.mark_won",
    });
  });

  it("covers the declared page types, list arrangements, and loading states", () => {
    const pages = sources.flatMap((source) =>
      source.kind === "application" ? source.body.pages : [],
    );
    const pageTypes = new Set(pages.map((page) => page.type));
    const arrangements = new Set(
      pages.flatMap((page) => (page.type === "list" ? page.arrangements : [])),
    );

    for (const type of ["list", "detail", "dashboard", "form", "guided_form", "public"]) {
      expect(pageTypes.has(type)).toBe(true);
    }
    for (const arrangement of ["table", "board", "calendar", "summary"]) {
      expect(arrangements.has(arrangement)).toBe(true);
    }
    for (const page of pages) {
      expect(page.states).toContain("loading");
    }
  });

  it("makes every manifest cross-application case structurally possible", () => {
    const modules = new Map(
      sources.filter((source) => source.kind === "module").map((module) => [module.key, module]),
    );
    const applications = new Map(
      sources
        .filter((source) => source.kind === "application")
        .map((application) => [application.key, application]),
    );
    const scenario = read("scenarios/cross-application-sharing.json") as {
      body: {
        inter_application_grant: {
          module: string;
          record_type: string;
          source_application: string;
          recipient_application: string;
        };
      };
    };

    for (const item of manifest.requiredCrossApplicationCases) {
      const module = modules.get(item.module);
      expect(module, `module ${item.module} exists`).toBeDefined();
      expect(module!.body.record_types.some((record) => record.key === item.record_type)).toBe(
        true,
      );

      const applicationKeys = item.applications ?? [
        item.source_application!,
        item.recipient_application!,
      ];
      for (const applicationKey of applicationKeys) {
        const application = applications.get(applicationKey);
        expect(application, `application ${applicationKey} exists`).toBeDefined();
        expect(
          application!.body.module_bindings.some((binding) => binding.module === item.module),
        ).toBe(true);
      }

      if (item.requires_grant) {
        expect(scenario.body.inter_application_grant).toMatchObject({
          module: item.module,
          record_type: item.record_type,
          source_application: item.source_application,
          recipient_application: item.recipient_application,
        });
      }
    }
  });

  it("proves shared Company and Contact identity plus limited collaborative Case access", () => {
    const scenario = read("scenarios/cross-application-sharing.json") as Record<string, any>;
    const body = scenario.body;
    expect(body.applications).toEqual(["vortex.app.crm", "vortex.app.service_desk"]);
    expect(body.same_record_cases).toEqual([
      {
        record_type: "vortex.crm.organisations:company",
        record_id: "company_fixture_1",
        created_in: "vortex.app.crm",
        read_in: ["vortex.app.crm", "vortex.app.service_desk"],
        expected_physical_records: 1,
        grant_required: false,
      },
      {
        record_type: "vortex.crm.people:contact",
        record_id: "contact_fixture_1",
        created_in: "vortex.app.crm",
        read_in: ["vortex.app.crm", "vortex.app.service_desk"],
        expected_physical_records: 1,
        grant_required: false,
      },
    ]);
    expect(body.inter_application_grant).toMatchObject({
      source_application: "vortex.app.service_desk",
      recipient_application: "vortex.app.crm",
      readable_fields: [
        "case_number",
        "subject",
        "status",
        "priority",
        "customer_company",
        "resolved_at",
      ],
      changeable_fields: ["status", "priority"],
      export_allowed: false,
      state: "active",
      expected_physical_records: 1,
    });
    expect(body.inter_application_grant.readable_fields).toEqual([
      "case_number",
      "subject",
      "status",
      "priority",
      "customer_company",
      "resolved_at",
    ]);
    expect(body.inter_application_grant.changeable_fields).toEqual(["status", "priority"]);
    expect(body.inter_application_grant.allowed_actions).toEqual([
      "vortex.service_desk.cases.case.add_public_comment",
    ]);

    const caseModule = sources.find(
      (source) => source.kind === "module" && source.key === body.inter_application_grant.module,
    );
    expect(caseModule?.kind).toBe("module");
    if (caseModule?.kind !== "module") return;
    const caseRecord = caseModule.body.record_types.find(
      (record) => record.key === body.inter_application_grant.record_type,
    );
    expect(caseRecord).toBeDefined();
    const fieldKeys = new Set(caseRecord!.fields.map((field) => field.key));
    for (const field of body.inter_application_grant.readable_fields) {
      expect(fieldKeys.has(field)).toBe(true);
    }
    for (const field of body.inter_application_grant.changeable_fields) {
      expect(body.inter_application_grant.readable_fields).toContain(field);
    }
    const actions = caseModule.body.actions;
    expect(
      actions.find((action) => action.key === body.inter_application_grant.allowed_actions[0])
        ?.shareable,
    ).toBe(true);

    const assertions = new Map(
      body.assertions.map((assertion: Record<string, unknown>) => [assertion.id, assertion]),
    );
    expect(assertions.get("assert_same_company")).toMatchObject({
      when: "both applications read company_fixture_1",
      expect: "same_record_id_and_current_values",
    });
    expect(assertions.get("assert_same_contact")).toMatchObject({
      when: "both applications read contact_fixture_1",
      expect: "same_record_id_and_current_values",
    });

    const limited = assertions.get("assert_limited_case") as Record<string, unknown>;
    expect(limited.expect_fields).toEqual(body.inter_application_grant.readable_fields);
    expect(limited.refuse_fields).toEqual([
      "description",
      "requester",
      "owner",
      "first_response_due_at",
      "resolution_due_at",
      "breached",
      "attachments",
    ]);
    for (const field of limited.refuse_fields as string[]) {
      expect(fieldKeys.has(field)).toBe(true);
      expect(body.inter_application_grant.readable_fields).not.toContain(field);
    }

    expect(assertions.get("assert_collaboration")).toMatchObject({
      when: "CRM changes priority or status or adds a public comment",
      expect: "source_case_saved_once_and_visible_in_both_applications",
    });
    expect(assertions.get("assert_refuse_excess")).toMatchObject({
      when: "CRM changes another field or invokes another action",
      expect: "refused",
    });
    expect(assertions.get("assert_revocation")).toMatchObject({
      when: "grant_fixture_service_case_to_crm is revoked",
      expect: "next_access_check_removes_rendered_values_and_cache_cannot_restore_them",
    });
  });

  it("keeps storage identity separate from display names and scopes rows correctly", () => {
    const storage = read("storage/record-storage-layout.json") as Record<string, any>;
    const body = storage.body;
    const moduleSources = sources.filter((source) => source.kind === "module");
    const recordTypes = new Map(
      moduleSources.flatMap((module) =>
        module.body.record_types.map((record) => [`${module.key}:${record.key}`, record] as const),
      ),
    );
    expect(body.tables).toHaveLength(recordTypes.size);
    expect(new Set(body.tables.map((entry: any) => entry.record_type))).toEqual(
      new Set(recordTypes.keys()),
    );
    expect(new Set(body.tables.map((entry: any) => entry.table)).size).toBe(body.tables.length);
    for (const mapping of body.tables) {
      const record = recordTypes.get(mapping.record_type)!;
      const [definitionKey] = mapping.record_type.split(":");
      const storageIdentity = resolutionV2.identities.find(
        (identity) =>
          identity.definitionKey === definitionKey &&
          identity.kind === "storage_contract" &&
          identity.alias === record.storage_contract_id,
      );
      expect(storageIdentity).toBeDefined();
      expect(mapping.storage_contract_id).toBe(storageIdentity!.identifier);
      expect(mapping.storage_scope).toBe(
        record.storage_scope === "organisation_shared"
          ? "organization_shared"
          : "application_contained",
      );
      expect(mapping.table).toBe(
        `record_data.rt_${storageIdentity!.identifier.replaceAll("-", "")}`,
      );
      expect(mapping.table.length).toBeLessThanOrEqual(63);
      const columns = new Set<string>();
      for (const field of record.fields) {
        const fieldIdentity = resolutionV2.identities.find(
          (identity) =>
            identity.definitionKey === definitionKey &&
            identity.kind === "field" &&
            identity.alias === field.id,
        );
        expect(fieldIdentity).toBeDefined();
        const column = `f_${fieldIdentity!.identifier.replaceAll("-", "")}`;
        expect(column).toMatch(/^f_[a-f0-9]{32}$/);
        expect(column.length).toBeLessThanOrEqual(63);
        expect(columns.has(column)).toBe(false);
        columns.add(column);
      }
    }
    expect(body.owning_service).toBe("record");
    expect(body.physical_schema).toBe("record_data");
    expect(body.allocation_unit).toBe("storage_contract_id");
    expect(body.uses_display_names).toBe(false);
    expect(body.scope_keys).toEqual({
      organization_shared: ["organisation_id"],
      application_contained: ["organisation_id", "application_root_id"],
    });
    expect(body.system_columns).toEqual([
      "organisation_id",
      "module_root_id",
      "record_type_id",
      "storage_contract_id",
      "record_id",
      "application_root_id",
      "definition_revision",
      "owner_organisation_account_id",
      "owner_group_id",
      "lifecycle_state",
      "concurrency_number",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "deleted_at",
      "deleted_by",
      "removal_due_at",
    ]);
    const mappings = new Map(body.tables.map((mapping: any) => [mapping.record_type, mapping]));
    const roots = new Map(
      body.application_roots.map((entry: any) => [entry.application_root_id, entry]),
    );
    const applications = new Set(
      sources.filter((source) => source.kind === "application").map((source) => source.key),
    );
    expect(
      new Set(body.application_roots.map((entry: any) => entry.application_root_id)).size,
    ).toBe(body.application_roots.length);
    for (const applicationRoot of body.application_roots) {
      expect(applications.has(applicationRoot.application_definition)).toBe(true);
    }
    for (const row of body.row_examples) {
      const record = recordTypes.get(row.record_type)!;
      expect(row.physical_table).toBe(mappings.get(row.record_type)?.table);
      if (record.storage_scope === "organisation_shared")
        expect(row.application_root_id).toBeNull();
      else {
        expect(roots.has(row.application_root_id)).toBe(true);
        expect((roots.get(row.application_root_id) as any).organisation_id).toBe(
          row.organisation_id,
        );
      }
    }
    const companies = body.row_examples.filter(
      (row: any) => row.record_type === "vortex.crm.organisations:company",
    );
    expect(new Set(companies.map((row: any) => row.organisation_id)).size).toBe(2);
    expect(new Set(companies.map((row: any) => row.physical_table)).size).toBe(1);
    expect(body.fork_example.source_storage_contract_id).not.toBe(
      body.fork_example.forked_storage_contract_id,
    );
    expect(body.fork_example.source_table).not.toBe(body.fork_example.forked_table);
    const sourceMapping = [...mappings.values()].find(
      (mapping: any) =>
        mapping.storage_contract_id === body.fork_example.source_storage_contract_id,
    );
    expect(sourceMapping?.table).toBe(body.fork_example.source_table);
    expect(body.assertions).toHaveLength(9);
  });

  it("authors exact field policies without implicit authority for future fields", () => {
    let recordPermissions = 0;
    for (const source of sources) {
      if (source.kind !== "module") continue;
      for (const permission of source.body.permissions) {
        if (!permission.record_type) {
          expect(permission.field_policy).toBeUndefined();
          continue;
        }
        recordPermissions++;
        const record = source.body.record_types.find(
          (entry) => entry.key === permission.record_type,
        )!;
        const fields = new Set(record.fields.map((field) => field.key));
        const policy = permission.field_policy;
        expect(policy, permission.key).toBeDefined();
        if (!policy) continue;
        expect(new Set(policy.readable_fields).size).toBe(policy.readable_fields.length);
        expect(new Set(policy.changeable_fields).size).toBe(policy.changeable_fields.length);
        for (const field of policy.readable_fields)
          expect(fields.has(field), permission.key).toBe(true);
        for (const field of policy.changeable_fields) {
          expect(policy.readable_fields, permission.key).toContain(field);
          expect(["reference_number", "calculation", "total"]).not.toContain(
            record.fields.find((entry) => entry.key === field)!.type,
          );
        }
        if (["delete", "restore", "share"].includes(permission.action_kind)) {
          expect(policy).toEqual({ readable_fields: [], changeable_fields: [] });
        }
        if (["read", "export"].includes(permission.action_kind)) {
          expect(policy.changeable_fields).toEqual([]);
        }
      }
    }
    expect(recordPermissions).toBe(94);
  });

  it("preserves native detail and editable-field coverage without exposing sensitive Contact notes", () => {
    for (const source of sources) {
      if (source.kind !== "module") continue;
      for (const record of source.body.record_types) {
        const ordinary = record.fields.filter(
          (field) =>
            !(
              source.key === "vortex.crm.people" &&
              record.key === "contact" &&
              field.key === "notes"
            ),
        );
        for (const action of ["read", "export", "create", "update"]) {
          const permission = source.body.permissions.find(
            (entry) => entry.key === `${source.key}.${record.key}.${action}`,
          );
          if (!permission) continue;
          expect([...permission.field_policy!.readable_fields].sort()).toEqual(
            ordinary.map((field) => field.key).sort(),
          );
          const expectedChanges = ["create", "update"].includes(action)
            ? ordinary
                .filter(
                  (field) => !["reference_number", "calculation", "total"].includes(field.type),
                )
                .map((field) => field.key)
            : [];
          expect([...permission.field_policy!.changeable_fields].sort()).toEqual(
            expectedChanges.sort(),
          );
        }
      }
    }
    const people = sources.find(
      (source) => source.kind === "module" && source.key === "vortex.crm.people",
    );
    if (!people || people.kind !== "module") throw new Error("People fixture required");
    const notes = people.body.permissions.find((entry) =>
      entry.key.endsWith(".view_sensitive_notes"),
    )!;
    expect(notes.action_kind).toBe("read");
    expect(notes.named_action).toBeUndefined();
    expect(notes.field_policy).toEqual({ readable_fields: ["notes"], changeable_fields: [] });
    const desk = sources.find(
      (source) => source.kind === "application" && source.key === "vortex.app.service_desk",
    );
    if (!desk || desk.kind !== "application") throw new Error("Service Desk fixture required");
    for (const role of desk.body.roles) expect(role.permissions).not.toContain(notes.key);
  });

  it("covers named-action subject effects without granting unrelated subject fields", () => {
    const opportunities = sources.find(
      (source) => source.kind === "module" && source.key === "vortex.crm.opportunities",
    );
    if (!opportunities || opportunities.kind !== "module")
      throw new Error("Opportunities fixture required");
    const approval = opportunities.body.permissions.find((entry) =>
      entry.key.endsWith(".approve_discount"),
    )!;
    expect(approval.action_kind).toBe("named");
    expect(approval.named_action).toBe("approve_discount");
    expect(approval.field_policy).toEqual({
      readable_fields: ["value", "discount_percent", "net_value"],
      changeable_fields: [],
    });
    const subjectReads = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.flatMap(subjectReads);
      if (!value || typeof value !== "object") return [];
      const object = value as Record<string, unknown>;
      return [
        ...(object.source === "subject_field" && typeof object.field === "string"
          ? [object.field]
          : []),
        ...Object.values(object).flatMap(subjectReads),
      ];
    };
    for (const source of sources) {
      if (source.kind !== "module") continue;
      for (const action of source.body.actions) {
        const policy = source.body.permissions.find(
          (permission) => permission.key === action.permission,
        )!.field_policy!;
        const changes = action.effects.flatMap((effect) =>
          effect.kind === "set_field" ? [effect.field] : [],
        );
        const relationshipReads = action.effects.flatMap((effect) =>
          effect.kind === "copy_relationships" ? effect.relationships : [],
        );
        const reads = [
          ...new Set([...changes, ...relationshipReads, ...subjectReads(action.effects)]),
        ];
        expect([...policy.readable_fields].sort(), action.key).toEqual(reads.sort());
        expect([...policy.changeable_fields].sort(), action.key).toEqual(
          [...new Set(changes)].sort(),
        );
      }
    }
  });

  it("keeps the approved Case Summary narrower than native Case field access", () => {
    const cases = sources.find(
      (source) => source.kind === "module" && source.key === "vortex.service_desk.cases",
    );
    if (!cases || cases.kind !== "module") throw new Error("Case fixture required");
    const readPolicy = cases.body.permissions.find((entry) =>
      entry.key.endsWith(".case.read"),
    )!.field_policy!;
    const updatePolicy = cases.body.permissions.find((entry) =>
      entry.key.endsWith(".case.update"),
    )!.field_policy!;
    const scenario = read("scenarios/cross-application-sharing.json") as {
      body: { inter_application_grant: { readable_fields: string[]; changeable_fields: string[] } };
    };
    const grant = scenario.body.inter_application_grant;
    expect(
      grant.readable_fields.filter((field) => readPolicy.readable_fields.includes(field)),
    ).toEqual(["case_number", "subject", "status", "priority", "customer_company", "resolved_at"]);
    expect(
      grant.changeable_fields.filter((field) => updatePolicy.changeable_fields.includes(field)),
    ).toEqual(["status", "priority"]);
    expect(grant.readable_fields).not.toContain("description");
    expect(grant.readable_fields).not.toContain("attachments");
  });

  it("contains no retired application name", () => {
    const prohibited = new RegExp("sales" + "[ _-]" + "hub", "i");
    for (const file of ["fixture-set.json", ...manifest.files]) {
      const content = fs.readFileSync(path.join(root, file), "utf8");
      expect(file).not.toMatch(prohibited);
      expect(content).not.toMatch(prohibited);
    }
  });
});
