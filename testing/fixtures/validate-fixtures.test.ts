import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  definitionResolutionSnapshotSchema,
  definitionSourceDocumentSchema,
  fieldTypeKeys,
  workflowNodeTypeKeys,
} from "@vortex/contracts";
import { compileDefinitionSet } from "@vortex/definition/compiler";

const root = path.resolve("testing/fixtures");
const read = (relative: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const manifest = read("fixture-set.json") as {
  files: string[];
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
const sources = definitionFiles.map((file) => definitionSourceDocumentSchema.parse(read(file)));
const resolution = definitionResolutionSnapshotSchema.parse(
  read("definition-resolution-snapshot.json"),
);
const draftMetadata = {
  organizationId: "10000000-0000-4000-a000-000000000001",
  draftRevision: 1,
  createdAt: "2026-09-01T00:00:00+00:00",
  createdBy: "10000000-0000-4000-a000-000000000002",
  updatedAt: "2026-09-01T00:00:00+00:00",
  updatedBy: "10000000-0000-4000-a000-000000000002",
} as const;
const savedConditionRevisions = [
  {
    definitionKey: "vortex.service_desk.cases",
    alias: "share_case_priority",
    revision: 1,
  },
] as const;

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
    const actual = visit("").filter((file) => file !== "fixture-set.json").sort();
    expect([...manifest.files].sort()).toEqual(actual);
    expect(new Set(manifest.files).size).toBe(manifest.files.length);
  });

  it("parses, compiles and publishes all thirteen definitions through shipping code", () => {
    expect(sources).toHaveLength(13);
    const outputs = compileDefinitionSet(
      sources.map((source) => ({
        source,
        resolution,
        ...(source.kind === "connection_type" ? {} : { draftMetadata }),
        ...(source.kind === "module" ? { savedConditionRevisions } : {}),
      })),
      {
        publishedHistories: sources
          .filter((source) => source.kind === "module" || source.kind === "application")
          .map((source) => ({ kind: source.kind, definitionKey: source.key, history: [] })),
        activeDependants: [],
      },
    );
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
      sources
        .filter((source) => source.kind === "module")
        .map((module) => [module.key, module]),
    );
    const applications = new Map(
      sources
        .filter((source) => source.kind === "application")
        .map((application) => [application.key, application]),
    );
    const scenario = read("scenarios/cross-application-sharing.json") as {
      body: { inter_application_grant: { module: string; record_type: string; source_application: string; recipient_application: string } };
    };

    for (const item of manifest.requiredCrossApplicationCases) {
      const module = modules.get(item.module);
      expect(module, `module ${item.module} exists`).toBeDefined();
      expect(module!.body.record_types.some((record) => record.key === item.record_type)).toBe(true);

      const applicationKeys = item.applications ?? [item.source_application!, item.recipient_application!];
      for (const applicationKey of applicationKeys) {
        const application = applications.get(applicationKey);
        expect(application, `application ${applicationKey} exists`).toBeDefined();
        expect(application!.body.module_bindings.some((binding) => binding.module === item.module)).toBe(true);
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

    const assertions = new Map(body.assertions.map((assertion: Record<string, unknown>) => [assertion.id, assertion]));
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
      expect(mapping.storage_contract_id).toBe(record.storage_contract_id);
      expect(mapping.storage_scope).toBe(record.storage_scope);
      expect(mapping.table).toMatch(/^record_data\.rt_srt_[a-z0-9_]+$/);
      expect(mapping.table.length).toBeLessThanOrEqual(63);
      const columns = new Set<string>();
      for (const field of record.fields) {
        const column = `f_${field.id}`;
        expect(column).toMatch(/^[a-z][a-z0-9_]*$/);
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
      organisation_shared: ["organisation_id"],
      application_contained: ["organisation_id", "application_root_id"],
    });
    expect(body.system_columns).toEqual([
      "organisation_id", "module_root_id", "record_type_id", "storage_contract_id", "record_id",
      "application_root_id", "definition_revision", "owner_organisation_account_id", "owner_team_id", "lifecycle_state",
      "concurrency_number", "created_at", "created_by", "updated_at", "updated_by", "deleted_at",
      "deleted_by", "removal_due_at",
    ]);
    const mappings = new Map(body.tables.map((mapping: any) => [mapping.record_type, mapping]));
    const roots = new Map(
      body.application_roots.map((entry: any) => [entry.application_root_id, entry]),
    );
    const applications = new Set(
      sources.filter((source) => source.kind === "application").map((source) => source.key),
    );
    expect(new Set(body.application_roots.map((entry: any) => entry.application_root_id)).size).toBe(
      body.application_roots.length,
    );
    for (const applicationRoot of body.application_roots) {
      expect(applications.has(applicationRoot.application_definition)).toBe(true);
    }
    for (const row of body.row_examples) {
      const record = recordTypes.get(row.record_type)!;
      expect(row.physical_table).toBe(mappings.get(row.record_type)?.table);
      if (record.storage_scope === "organisation_shared") expect(row.application_root_id).toBeNull();
      else {
        expect(roots.has(row.application_root_id)).toBe(true);
        expect((roots.get(row.application_root_id) as any).organisation_id).toBe(row.organisation_id);
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
      (mapping: any) => mapping.storage_contract_id === body.fork_example.source_storage_contract_id,
    );
    expect(sourceMapping?.table).toBe(body.fork_example.source_table);
    expect(body.assertions).toHaveLength(9);
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
