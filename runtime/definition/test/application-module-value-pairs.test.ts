import fs from "node:fs";
import path from "node:path";
import {
  applicationCompositionCatalogueSnapshotV2Schema,
  applicationSourceDocumentV2Schema,
  definitionCompilationOutputSchema,
  publishedDefinitionHistorySchema,
  definitionResolutionSnapshotSchema,
  definitionResolutionSnapshotV2Schema,
  definitionSourceDocumentSchema,
  moduleSourceDocumentV2Schema,
  sessionContextSchema,
  storedDefinitionDraftSchema,
  type ApplicationSourceDocumentV2,
  type DefinitionCompilationOutput,
  type DefinitionResolutionSnapshot,
  type DefinitionResolutionSnapshotV2,
  type DefinitionSourceDocument,
  type ModuleSourceDocumentV2,
  type PublishDefinitionResult,
  type SessionContext,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { compileDefinitionWithContext } from "../src/compiler";
import { createDefinitionConsumerReadService } from "../src/definition-consumer-read";
import {
  createDefinitionPublicationService,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationCatalogue,
  type DefinitionPublicationReader,
  type DefinitionPublicationRepository,
  type DefinitionPublicationTransaction,
  type DefinitionReleaseAppend,
  type ResolvableConnectionTypeRelease,
  type ResolvableModuleRelease,
} from "../src/definition-publication";
import { extractStoredSourceIdentityRequirements } from "../src/source-identities";
import { compileDefinitionSet, validateDefinitionSet } from "../src/validation";

type JsonObject = Record<string, unknown>;

const fixtureRoot = path.resolve(import.meta.dirname, "../../../testing/fixtures");
const historicalRoot = path.join(fixtureRoot, "historical/module-v1");
const read = (root: string, relative: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));

const currentResolution = definitionResolutionSnapshotV2Schema.parse(
  read(fixtureRoot, "module-v2-definition-resolution-snapshot.json"),
);
const historicalCompanySource = (() => {
  const source = definitionSourceDocumentSchema.parse(
    read(historicalRoot, "modules/crm.organisations.json"),
  );
  if (source.kind !== "module") throw new Error("Historical organisation Module required");
  const created = source.body.events.find(
    (event) => event.key === "vortex.crm.organisations.company.created",
  )!;
  created.carries.push("employee_count");
  const merge = source.body.actions.find(
    (action) => action.key === "vortex.crm.organisations.company.merge",
  )!;
  merge.inputs.push({
    key: "legacy_limit",
    label: "Legacy limit",
    required: true,
    type: "number",
  });
  return definitionSourceDocumentSchema.parse(source);
})();
const historicalPeopleSource = definitionSourceDocumentSchema.parse(
  read(historicalRoot, "modules/crm.people.json"),
);
const historicalWebhookSource = (() => {
  const source = definitionSourceDocumentSchema.parse(
    read(historicalRoot, "connection-types/webhook.json"),
  );
  if (source.kind !== "connection_type") throw new Error("Historical webhook required");
  const shape = source.body.shapes.find((candidate) => candidate.key === "signed_json")!;
  shape.fields = [{ key: "threshold", type: "number", required: true }];
  return definitionSourceDocumentSchema.parse(source);
})();

const organizationId = "10000000-0000-4000-a000-000000000001";
const actorId = "10000000-0000-4000-a000-000000000002";
const recordId = "20000000-0000-4000-8000-000000000001";
const metadata = {
  organizationId,
  draftRevision: 1,
  createdAt: "2026-09-09T00:00:00.000Z",
  createdBy: actorId,
  updatedAt: "2026-09-09T00:00:00.000Z",
  updatedBy: actorId,
} as const;
const exactSourceValue = "9007199254740993.00";
const exactCanonicalValue = "9007199254740993";
const applicationKey = "vortex.app.crm";
const requestContext = (): SessionContext =>
  sessionContextSchema.parse({
    callerKind: "system",
    tenantId: "10000000-0000-4000-8000-000000000010",
    organizationId,
    systemActorId: actorId,
    sessionId: "10000000-0000-4000-8000-000000000011",
    authenticationStrength: "service",
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    accessVersion: 1,
    correlationId: "10000000-0000-4000-8000-000000000012",
  });

const exactSlaSource = (): ModuleSourceDocumentV2 => {
  const source = read(fixtureRoot, "modules/service-desk.sla.json") as {
    body: {
      record_types: Array<{ key: string; fields: JsonObject[] }>;
      actions: JsonObject[];
      events: Array<{ key: string; carries: string[] }>;
    };
  } & JsonObject;
  const serviceLevel = source.body.record_types.find((record) => record.key === "service_level")!;
  const response = serviceLevel.fields.find((field) => field.key === "first_response_minutes")!;
  response.type = "decimal_number";
  response.settings = { digits_before_decimal: 30, decimal_places: 2, minimum: "0.00" };
  response.default = "1.00";
  const resolution = serviceLevel.fields.find((field) => field.key === "resolution_minutes")!;
  resolution.type = "money";
  resolution.settings = { currency_mode: "organisation_default", minimum: "0.00" };
  resolution.default = "12.3400";
  const active = serviceLevel.fields.find((field) => field.key === "active")!;
  active.type = "choice";
  active.settings = {
    options: [
      { value: "active", label: "Active" },
      { value: "paused", label: "Paused" },
    ],
  };
  active.default = "active";
  serviceLevel.fields.push({
    id: "fld_sla_whole_count",
    key: "whole_count",
    label: "Whole count",
    required: false,
    unique: false,
    filterable: true,
    sortable: true,
    personal_data: "none",
    public_display: "refused",
    type: "whole_number",
    settings: { minimum: 0 },
  });
  const action = source.body.actions[0]!;
  action.inputs = [
    {
      key: "exact_limit",
      label: "Exact limit",
      required: true,
      type: "decimal_number",
      validation: { minimum: "0.00" },
    },
    {
      key: "budget",
      label: "Budget",
      required: true,
      type: "money",
      validation: { minimum: "0.00" },
    },
    {
      key: "calendar",
      label: "Calendar",
      required: true,
      type: "record_reference",
      record_types: ["vortex.service_desk.sla:business_calendar"],
    },
    {
      key: "label",
      label: "Label",
      required: true,
      type: "text",
    },
    {
      key: "whole_limit",
      label: "Whole limit",
      required: true,
      type: "number",
    },
  ];
  const firstEffect = (action.effects as JsonObject[])[0]!;
  firstEffect.value = { source: "literal", value: "paused" };
  source.body.actions.push({
    id: "act_sla_format_notes",
    key: "vortex.service_desk.sla.service_level.format_notes",
    label: "Format service-level notes",
    record_type: "service_level",
    permission: "vortex.service_desk.sla.service_level.manage",
    shareable: false,
    inputs: [
      {
        key: "notes",
        label: "Notes",
        required: true,
        type: "formatted_text",
        validation: { allowed_blocks: ["paragraph", "heading", "list", "link"] },
      },
    ],
    effects: [
      {
        kind: "announce_event",
        event: "vortex.service_desk.sla.service_level.changed",
      },
    ],
  });
  const changedEvent = source.body.events.find(
    (event) => event.key === "vortex.service_desk.sla.service_level.changed",
  )!;
  changedEvent.carries.push("calendar");
  return moduleSourceDocumentV2Schema.parse(source);
};

const v1ApplicationPage = () => ({
  id: "page_exact_values",
  key: "exact_values",
  name: "Exact values",
  type: "detail",
  record_type: "vortex.service_desk.sla:service_level",
  permission: "application.crm.open",
  states: ["normal", "failure"],
  blocks: [
    {
      id: "placement_exact_values",
      block: "block_exact_values",
      block_release_version: "1.0.0",
      settings: {},
      desktop: { start_column: 1, span: 12, height: 4 },
      phone: { order: 0, behaviour: "full_width" },
      visibility_condition: {
        field: "vortex.service_desk.sla:service_level.first_response_minutes",
        operator: "greater_than",
        value: exactSourceValue,
      },
      view_permission: "application.crm.open",
    },
  ],
  layout: {
    desktop: { columns: 12, component_order: ["placement_exact_values"] },
    phone: { component_order: ["placement_exact_values"] },
  },
});

const sourceBody = () => ({
  name: "Application value pairs",
  description: "Exercises values owned by bound Module releases.",
  icon: "list-checks",
  home_page: "exact_values",
  module_bindings: [
    {
      module: "vortex.crm.organisations",
      version: { selection: "exact", version: "1.0.0" },
      purpose: "historical_values",
    },
    {
      module: "vortex.crm.people",
      version: { selection: "exact", version: "1.0.0" },
      purpose: "historical_calculation",
    },
    {
      module: "vortex.service_desk.sla",
      version: { selection: "exact", version: "2.0.0" },
      purpose: "exact_values",
    },
  ],
  theme: {
    mode: "application",
    light_and_dark: true,
    tokens: {
      brand: "indigo",
      density: "comfortable",
      corners: "medium",
      focus: "high_contrast",
    },
  },
  permissions: [
    {
      id: "permission_open",
      key: "application.crm.open",
      label: "Open application",
      description: "Open the value-pair test application.",
      action_kind: "named",
      named_action: "open",
      administrative: false,
    },
  ],
  roles: [
    {
      id: "role_reader",
      key: "reader",
      name: "Reader",
      home_page: "exact_values",
      permissions: ["application.crm.open"],
    },
  ],
  navigation: [
    {
      id: "navigation_exact_values",
      type: "page",
      label: "Exact values",
      page: "exact_values",
      permission: "application.crm.open",
    },
  ],
  queries: [
    {
      id: "query_exact_values",
      key: "exact_values",
      record_type: "vortex.service_desk.sla:service_level",
      select: ["name", "first_response_minutes", "resolution_minutes", "calendar"],
      filter: {
        all: [
          {
            field: "first_response_minutes",
            operator: "greater_than",
            value: exactSourceValue,
          },
          {
            field: "resolution_minutes",
            operator: "equals",
            value: { amount: "12.3400", currency: "NZD" },
          },
          {
            field: "calendar",
            operator: "equals",
            value: {
              record_type: "vortex.service_desk.sla:business_calendar",
              record_id: recordId,
            },
          },
        ],
      },
      group_by: [],
      aggregates: [],
      sort: [{ field: "name", direction: "ascending" }],
      page_size: 25,
      relationship_hops: 0,
    },
    {
      id: "query_v1_numbers",
      key: "v1_numbers",
      record_type: "vortex.crm.organisations:company",
      select: ["name", "employee_count"],
      filter: { field: "employee_count", operator: "greater_than", value: 7 },
      group_by: [],
      aggregates: [],
      sort: [{ field: "name", direction: "ascending" }],
      page_size: 25,
      relationship_hops: 0,
    },
  ],
  block_registrations: [
    {
      id: "block_exact_values",
      release_version: "1.0.0",
      name: "Exact values",
      icon: "list-checks",
      palette_group: "content",
      settings: [],
      allowed_child_blocks: [],
      phone_behaviour: "full_width",
      resizable_height: true,
      live_update: true,
      public_page: false,
    },
  ],
  pages: [v1ApplicationPage()],
  workflows: [
    {
      id: "workflow_exact_values",
      key: "exact_values",
      name: "Use exact values",
      trigger: {
        kind: "event",
        event: "vortex.service_desk.sla.service_level.changed",
        record_type: "vortex.service_desk.sla:service_level",
        inputs: [
          {
            key: "calendar",
            type: "record_reference",
            record_types: ["vortex.service_desk.sla:business_calendar"],
            source: { kind: "record_field", field: "calendar" },
          },
        ],
        condition: {
          field: "first_response_minutes",
          operator: "greater_than",
          value: exactSourceValue,
        },
        duplicate_protection: "required",
      },
      run_as: "system_with_source_authority",
      maximum_nesting_depth: 5,
      nodes: [
        { id: "start", type: "start", config: {} },
        {
          id: "condition",
          type: "condition",
          config: {
            field: "vortex.service_desk.sla:service_level.first_response_minutes",
            operator: "greater_than",
            value: exactSourceValue,
          },
        },
        {
          id: "action",
          type: "run_action",
          config: {
            action: "vortex.service_desk.sla.service_level.pause",
            subject: { source: "current_record" },
            inputs: {
              exact_limit: { source: "literal", value: exactSourceValue },
              budget: {
                source: "literal",
                value: { amount: "12.3400", currency: "NZD" },
              },
              calendar: {
                source: "literal",
                value: {
                  record_type: "vortex.service_desk.sla:business_calendar",
                  record_id: recordId,
                },
              },
              label: { source: "literal", value: "Pause" },
              whole_limit: { source: "literal", value: 3 },
            },
          },
        },
        { id: "stop", type: "stop", config: { reason_code: "complete" } },
      ],
      edges: [
        ["start", "condition"],
        ["condition", "action", "matched"],
        ["condition", "stop", "not_matched"],
        ["action", "stop"],
      ],
    },
    {
      id: "workflow_v1_fields_to_v2_inputs",
      key: "v1_fields_to_v2_inputs",
      name: "Use compatible V1 fields in V2 action inputs",
      trigger: {
        kind: "event",
        event: "vortex.crm.organisations.company.created",
        record_type: "vortex.crm.organisations:company",
        inputs: [
          {
            key: "label",
            type: "text",
            source: { kind: "record_field", field: "name" },
          },
          {
            key: "whole_limit",
            type: "whole_number",
            source: { kind: "record_field", field: "employee_count" },
          },
        ],
        condition: null,
        duplicate_protection: "required",
      },
      run_as: "system_with_source_authority",
      maximum_nesting_depth: 5,
      nodes: [
        { id: "start", type: "start", config: {} },
        {
          id: "target",
          type: "create_record",
          config: {
            record_type: "vortex.service_desk.sla:service_level",
            values: {
              name: { source: "literal", value: "Triggered service level" },
              calendar: {
                source: "literal",
                value: {
                  record_type: "vortex.service_desk.sla:business_calendar",
                  record_id: recordId,
                },
              },
              first_response_minutes: { source: "literal", value: exactSourceValue },
              resolution_minutes: {
                source: "literal",
                value: { amount: "12.3400", currency: "NZD" },
              },
              active: { source: "literal", value: "active" },
            },
          },
        },
        {
          id: "action",
          type: "run_action",
          config: {
            action: "vortex.service_desk.sla.service_level.pause",
            subject: { source: "node_output", node: "target", output: "record" },
            inputs: {
              exact_limit: { source: "literal", value: exactSourceValue },
              budget: {
                source: "literal",
                value: { amount: "12.3400", currency: "NZD" },
              },
              calendar: {
                source: "literal",
                value: {
                  record_type: "vortex.service_desk.sla:business_calendar",
                  record_id: recordId,
                },
              },
              label: {
                source: "trigger_input",
                input: "label",
              },
              whole_limit: {
                source: "trigger_input",
                input: "whole_limit",
              },
            },
          },
        },
        { id: "stop", type: "stop", config: { reason_code: "complete" } },
      ],
      edges: [
        ["start", "target"],
        ["target", "action"],
        ["action", "stop"],
      ],
    },
  ],
  pipelines: [
    {
      id: "pipeline_exact_values",
      key: "exact_values",
      name: "Exact values",
      record_type: "vortex.service_desk.sla:service_level",
      stage_field: "active",
      stages: [
        {
          key: "active",
          label: "Active",
          entry_actions: [],
          exit_actions: [],
          entry_workflows: [],
          exit_workflows: [],
        },
        {
          key: "paused",
          label: "Paused",
          entry_actions: [],
          exit_actions: [],
          entry_workflows: [],
          exit_workflows: [],
        },
      ],
      transitions: [
        {
          from: "active",
          to: "paused",
          permission: "application.crm.open",
          gate: {
            field: "first_response_minutes",
            operator: "greater_than",
            value: exactSourceValue,
          },
        },
      ],
      time_targets: [],
    },
  ],
  connection_bindings: [
    {
      id: "connection_webhook",
      connection_type: "vortex.connection.webhook",
      required_operations: ["post_json"],
      key: "webhook",
      version: { selection: "exact", version: "1.0.0" },
    },
  ],
  interfaces: [
    {
      id: "interface_formatted_notes",
      key: "application.crm.formatted_notes",
      version: "1.0.0",
      state: "supported",
      operations: [
        {
          id: "interface_formatted_notes_apply",
          key: "apply_formatted_notes",
          description: "Apply formatted notes through the Module action.",
          input_shape: {
            subject: {
              type: "record_reference",
              required: true,
              target_binding: { kind: "action_subject" },
            },
            notes: {
              type: "formatted_text",
              required: true,
              target_binding: { kind: "action_input", key: "notes" },
            },
          },
          output_shape: {},
          authentication: "organisation_token",
          permission: "application.crm.open",
          visibility: "organisation_private",
          rate_limit_per_minute: 60,
          maximum_request_bytes: 10000,
          duplicate_protection: "not_required",
          target: {
            kind: "action",
            key: "vortex.service_desk.sla.service_level.format_notes",
          },
          error_codes: ["validation_failed"],
          method: "POST",
          path: "/formatted-notes",
        },
      ],
    },
  ],
  actions: [
    {
      id: "action_exact_values",
      key: "application.crm.exact_values",
      label: "Apply exact values",
      record_type: "vortex.service_desk.sla:service_level",
      permission: "application.crm.open",
      sharing: "refused",
      inputs: [],
      precondition: {
        field: "first_response_minutes",
        operator: "greater_than",
        value: exactSourceValue,
      },
      effects: [
        {
          kind: "set_field",
          field: "resolution_minutes",
          value: { source: "literal", value: { amount: "12.3400", currency: "NZD" } },
        },
        {
          kind: "set_field",
          field: "calendar",
          value: {
            source: "literal",
            value: {
              record_type: "vortex.service_desk.sla:business_calendar",
              record_id: recordId,
            },
          },
        },
        {
          kind: "create_record",
          record_type: "vortex.service_desk.sla:service_level",
          values: {
            name: { source: "literal", value: "Premium" },
            calendar: {
              source: "literal",
              value: {
                record_type: "vortex.service_desk.sla:business_calendar",
                record_id: recordId,
              },
            },
            first_response_minutes: { source: "literal", value: exactSourceValue },
            resolution_minutes: {
              source: "literal",
              value: { amount: "15.5000", currency: "NZD" },
            },
            active: { source: "literal", value: "active" },
          },
        },
      ],
    },
    {
      id: "action_v1_input",
      key: "application.crm.v1_input",
      label: "Apply a V1 input",
      record_type: "vortex.crm.organisations:company",
      permission: "application.crm.open",
      sharing: "refused",
      inputs: [
        {
          key: "employee_count",
          label: "Employee count",
          required: true,
          type: "number",
          validation: { minimum: 1, maximum: 1000 },
        },
      ],
      precondition: {
        field: "employee_count",
        operator: "greater_than",
        parameter: "employee_count",
      },
      effects: [
        {
          kind: "set_field",
          field: "employee_count",
          value: { source: "input", input: "employee_count" },
        },
      ],
    },
  ],
  rules: [
    {
      id: "rule_exact_values",
      key: "exact_values",
      record_type: "vortex.service_desk.sla:service_level",
      trigger: "change",
      priority: 100,
      condition: {
        field: "first_response_minutes",
        operator: "greater_than",
        value: exactSourceValue,
      },
      effect: {
        kind: "set_value",
        field: "resolution_minutes",
        value: { amount: "19.9900", currency: "NZD" },
      },
    },
  ],
  events: [],
  public_addresses: [],
});

const applicationV1 = () =>
  definitionSourceDocumentSchema.parse({
    source_contract_version: "1.0.0",
    root_alias: "app_crm",
    key: applicationKey,
    kind: "application",
    body: sourceBody(),
  });

const blockId = "70000000-0000-4000-8000-000000000001";
const themeId = "70000000-0000-4000-8000-000000000002";
const blockFingerprint = `sha256:${"a".repeat(64)}`;
const blockCatalogueFingerprint = `sha256:${"b".repeat(64)}`;
const themeFingerprint = `sha256:${"c".repeat(64)}`;
const themeCatalogueFingerprint = `sha256:${"d".repeat(64)}`;

const applicationV2 = (): ApplicationSourceDocumentV2 => {
  const body = sourceBody();
  const common = structuredClone(body) as JsonObject;
  delete common.block_registrations;
  delete common.pages;
  delete common.theme;
  return applicationSourceDocumentV2Schema.parse({
    source_contract_version: "2.0.0",
    root_alias: "app_crm",
    key: applicationKey,
    kind: "application",
    body: {
      ...common,
      pages: [
        {
          id: "page_exact_values",
          key: "exact_values",
          name: "Exact values",
          type: "detail",
          record_type: "vortex.service_desk.sla:service_level",
          permission: "application.crm.open",
          states: ["normal", "failure"],
          composition: {
            shell_kind: "default",
            main: {
              placements: {
                exact_values: {
                  block: { block_id: blockId, release_version: "1.0.0" },
                  view_permission: "application.crm.open",
                  visibility_condition: {
                    field: "vortex.service_desk.sla:service_level.first_response_minutes",
                    operator: "greater_than",
                    value: exactSourceValue,
                  },
                  settings: {},
                  theme_overrides: {},
                  responsive: {
                    desktop: {
                      visible: true,
                      width: { kind: "fill" },
                      height: { kind: "content" },
                    },
                  },
                  slots: {},
                },
              },
              order: { desktop: ["exact_values"] },
            },
          },
        },
      ],
      platform_block_dependencies: [
        {
          kind: "platform_block",
          block_id: blockId,
          release_version: "1.0.0",
          content_fingerprint: blockFingerprint,
          catalogue_fingerprint: blockCatalogueFingerprint,
        },
      ],
      shells: [],
      theme: {
        base: {
          kind: "platform_theme",
          catalogue_theme_id: themeId,
          release_version: "1.0.0",
          content_fingerprint: themeFingerprint,
          catalogue_fingerprint: themeCatalogueFingerprint,
        },
        token_overrides: {},
      },
    },
  });
};

const catalogueV2 = () => {
  const evidence = {
    contractVersion: "2.0.0" as const,
    platformBlocks: {
      compositionPolicy: { maximumDepth: 20, maximumPlacements: 200 },
      releases: [
        {
          blockId,
          key: "vortex.block.exact_values",
          releaseVersion: "1.0.0",
          contentFingerprint: blockFingerprint,
          catalogueFingerprint: blockCatalogueFingerprint,
          name: "Exact values",
          icon: "list-checks",
          paletteGroup: "content" as const,
          rendererKey: "vortex.renderer.exact_values",
          properties: [],
          slots: [],
          capabilities: {
            responsiveVisibility: true,
            responsiveOrder: true,
            gridWidth: true,
            height: "content_or_bounded" as const,
            accessibleName: "not_applicable" as const,
            publicSurface: "refused" as const,
          },
        },
      ],
    },
    platformTheme: {
      catalogueThemeId: themeId,
      releaseVersion: "1.0.0",
      contentFingerprint: themeFingerprint,
      catalogueFingerprint: themeCatalogueFingerprint,
      tokens: {},
    },
  };
  return applicationCompositionCatalogueSnapshotV2Schema.parse({
    ...evidence,
    fingerprint: fingerprintCanonicalValue(evidence),
  });
};

const definitionVersions = new Map([
  ["vortex.crm.organisations", "1.0.0"],
  ["vortex.crm.people", "1.0.0"],
  ["vortex.service_desk.sla", "2.0.0"],
  ["vortex.connection.webhook", "1.0.0"],
  [applicationKey, "1.0.0"],
]);

const baseIdentities = (() => {
  const identities = [...currentResolution.identities];
  let next = 8000;
  const generated = new Map<string, string>();
  for (const requirement of extractStoredSourceIdentityRequirements(exactSlaSource())) {
    const group = `${requirement.definitionKey}:${requirement.scope}:${requirement.kind}:${requirement.componentOwner}`;
    const existing = identities.find(
      (identity) =>
        identity.definitionKey === requirement.definitionKey &&
        identity.scope === requirement.scope &&
        identity.kind === requirement.kind &&
        identity.componentOwner === requirement.componentOwner,
    );
    const identifier =
      existing?.identifier ??
      generated.get(group) ??
      `70000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
    generated.set(group, identifier);
    for (const alias of requirement.aliases)
      if (
        !identities.some(
          (identity) =>
            identity.definitionKey === requirement.definitionKey &&
            identity.scope === requirement.scope &&
            identity.kind === requirement.kind &&
            identity.componentOwner === requirement.componentOwner &&
            identity.alias === alias,
        )
      )
        identities.push({
          definitionKey: requirement.definitionKey,
          scope: requirement.scope,
          kind: requirement.kind,
          componentOwner: requirement.componentOwner,
          alias,
          identifier,
        });
  }
  return identities;
})();

const resolutionFor = (
  source: DefinitionSourceDocument | ApplicationSourceDocumentV2 | ModuleSourceDocumentV2,
  contractVersion: "1.0.0" | "2.0.0",
) => {
  const definitions = currentResolution.definitions.map((definition) => ({
    ...definition,
    exactVersion: definitionVersions.get(definition.key) ?? definition.exactVersion,
  }));
  const identities = baseIdentities.filter((identity) => identity.definitionKey !== source.key);
  let next = 9000;
  for (const requirement of extractStoredSourceIdentityRequirements(source)) {
    const existing = baseIdentities.find(
      (identity) =>
        identity.definitionKey === requirement.definitionKey &&
        identity.scope === requirement.scope &&
        identity.kind === requirement.kind &&
        identity.componentOwner === requirement.componentOwner,
    );
    const identifier =
      existing?.identifier ?? `70000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
    for (const alias of requirement.aliases)
      if (
        !identities.some(
          (identity) =>
            identity.definitionKey === requirement.definitionKey &&
            identity.scope === requirement.scope &&
            identity.kind === requirement.kind &&
            identity.componentOwner === requirement.componentOwner &&
            identity.alias === alias,
        )
      )
        identities.push({
          definitionKey: requirement.definitionKey,
          scope: requirement.scope,
          kind: requirement.kind,
          componentOwner: requirement.componentOwner,
          alias,
          identifier,
        });
  }
  const evidence = { contractVersion, definitions, identities };
  return contractVersion === "2.0.0"
    ? definitionResolutionSnapshotV2Schema.parse({
        ...evidence,
        fingerprint: fingerprintCanonicalValue(evidence),
      })
    : definitionResolutionSnapshotSchema.parse({
        ...evidence,
        fingerprint: fingerprintCanonicalValue(evidence),
      });
};

type ModuleOutput = Extract<DefinitionCompilationOutput, { kind: "module" }>;

const compileDependencies = () => {
  if (historicalCompanySource.kind !== "module" || historicalPeopleSource.kind !== "module")
    throw new Error("Historical Module sources required");
  const companyResolution = resolutionFor(
    historicalCompanySource,
    "1.0.0",
  ) as DefinitionResolutionSnapshot;
  const company = compileDefinitionWithContext(
    {
      source: historicalCompanySource,
      resolution: companyResolution,
      draftMetadata: metadata,
      savedConditionRevisions: [],
    },
    { dependencyOutputs: [] },
  );
  const peopleResolution = resolutionFor(
    historicalPeopleSource,
    "1.0.0",
  ) as DefinitionResolutionSnapshot;
  const people = compileDefinitionWithContext(
    {
      source: historicalPeopleSource,
      resolution: peopleResolution,
      draftMetadata: metadata,
      savedConditionRevisions: [],
    },
    { dependencyOutputs: [company] },
  );
  const slaSource = exactSlaSource();
  const slaResolution = resolutionFor(slaSource, "2.0.0") as DefinitionResolutionSnapshotV2;
  const sla = compileDefinitionWithContext(
    {
      sourceContractVersion: "2.0.0",
      validationContractVersion: "2.0.0",
      source: slaSource,
      resolution: slaResolution,
      draftMetadata: metadata,
      savedConditionRevisions: [],
    },
    { dependencyOutputs: [] },
  );
  const webhookResolution = resolutionFor(
    historicalWebhookSource,
    "1.0.0",
  ) as DefinitionResolutionSnapshot;
  const webhook = compileDefinitionWithContext(
    { source: historicalWebhookSource, resolution: webhookResolution },
    { dependencyOutputs: [] },
  );
  if (company.kind !== "module" || people.kind !== "module" || sla.kind !== "module")
    throw new Error("Module outputs required");
  if (webhook.kind !== "connection_type") throw new Error("Connection output required");
  return { modules: [company, people, sla] as ModuleOutput[], webhook };
};

let dependencyOutputCache: ReturnType<typeof compileDependencies> | undefined;
const dependencyOutputs = () => (dependencyOutputCache ??= structuredClone(compileDependencies()));

const compileApplication = (
  source: DefinitionSourceDocument | ApplicationSourceDocumentV2,
): {
  output: Extract<DefinitionCompilationOutput, { kind: "application" }>;
  modules: ModuleOutput[];
} => {
  const dependencies = dependencyOutputs();
  const v2 = source.source_contract_version === "2.0.0";
  const resolutionV1 = resolutionFor(source, "1.0.0") as DefinitionResolutionSnapshot;
  const resolutionV2 = resolutionFor(source, "2.0.0") as DefinitionResolutionSnapshotV2;
  const request = v2
    ? {
        sourceContractVersion: "2.0.0" as const,
        validationContractVersion: "2.0.0" as const,
        source: source as ApplicationSourceDocumentV2,
        resolution: resolutionV2,
        catalogueSnapshot: catalogueV2(),
        draftMetadata: metadata,
      }
    : {
        source,
        resolution: resolutionV1,
        draftMetadata: metadata,
      };
  const [output] = compileDefinitionSet([request], {
    dependencyOutputs: [...dependencies.modules, dependencies.webhook],
    publishedHistories: [{ kind: "application", definitionKey: applicationKey, history: [] }],
  });
  if (!output || output.kind !== "application") throw new Error("Application output required");
  return { output, modules: dependencies.modules };
};

const dependencyReleases = (): {
  modules: ResolvableModuleRelease[];
  connection: ResolvableConnectionTypeRelease;
} => {
  const dependencies = dependencyOutputs();
  const releases: ResolvableModuleRelease[] = [];
  for (const output of dependencies.modules) {
    const validationContractVersion = "validationContractVersion" in output ? "2.0.0" : "1.0.0";
    const publication = {
      kind: "module" as const,
      rootId: output.artifact.rootId,
      revision: 1,
      releaseVersion: output.artifact.exactVersion,
      contentFingerprint: output.artifact.contentFingerprint,
      publishedAt: metadata.updatedAt,
      publishedBy: actorId,
      validationContractVersion,
    };
    const dependencyManifest = output.resolvedDependencies.flatMap((dependency) => {
      if (dependency.kind !== "module") return [];
      const target = releases.find((release) => release.key === dependency.key);
      if (!target) throw new Error(`Published dependency required: ${dependency.key}`);
      return [target.published.publication];
    });
    const published = publishedDefinitionHistorySchema.parse({
      kind: "module",
      definitionKey: output.artifact.definitionKey,
      history: [
        {
          publication,
          content: output.canonical.content,
          dependencyManifest,
          releaseNote: "Value-pair test dependency",
        },
      ],
    }).history[0]!;
    const source =
      output.artifact.definitionKey === historicalCompanySource.key
        ? historicalCompanySource
        : output.artifact.definitionKey === historicalPeopleSource.key
          ? historicalPeopleSource
          : exactSlaSource();
    releases.push({
      organizationId,
      key: output.artifact.definitionKey,
      rootId: output.artifact.rootId,
      releaseRevision: 1,
      releaseVersion: output.artifact.exactVersion,
      contentFingerprint: output.artifact.contentFingerprint,
      resolutionFingerprint: output.resolutionFingerprint,
      published,
      compilationOutput: output,
      resolutionSnapshot: resolutionFor(
        source,
        source.source_contract_version === "2.0.0" ? "2.0.0" : "1.0.0",
      ),
    });
  }
  const output = dependencies.webhook;
  return {
    modules: releases,
    connection: {
      key: output.artifact.definitionKey,
      rootId: output.artifact.rootId,
      releaseVersion: output.artifact.exactVersion,
      contentFingerprint: output.artifact.contentFingerprint,
      catalogueFingerprint: output.artifact.contentFingerprint,
      compilationOutput: output,
    },
  };
};

class ApplicationPublicationRepository
  implements
    DefinitionPublicationRepository,
    DefinitionPublicationReader,
    DefinitionPublicationTransaction
{
  appended?: DefinitionReleaseAppend;

  constructor(
    readonly candidate: DefinitionPublicationCandidate,
    readonly modules: readonly ResolvableModuleRelease[],
  ) {}

  read<Result>(
    _context: SessionContext,
    operation: (reader: DefinitionPublicationReader) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  transaction<Result>(
    _context: SessionContext,
    operation: (transaction: DefinitionPublicationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  async readCandidate(rootId: string) {
    return rootId === this.candidate.draft.rootId ? structuredClone(this.candidate) : undefined;
  }

  async lockCandidate(rootId: string) {
    return this.readCandidate(rootId);
  }

  async listModuleReleases(candidateOrganizationId: string, key: string) {
    return this.modules.filter(
      (release) => release.organizationId === candidateOrganizationId && release.key === key,
    );
  }

  async readModuleRelease(
    candidateOrganizationId: string,
    rootId: string,
    releaseRevision: number,
  ) {
    return this.modules.find(
      (release) =>
        release.organizationId === candidateOrganizationId &&
        release.rootId === rootId &&
        release.releaseRevision === releaseRevision,
    );
  }

  async appendRelease(release: DefinitionReleaseAppend): Promise<PublishDefinitionResult> {
    this.appended = release;
    return {
      rootId: release.draft.rootId,
      releaseRevision: release.draft.draftRevision,
      releaseVersion: release.assignedVersion,
      contentFingerprint: release.compilationOutput.artifact.contentFingerprint,
      resolutionFingerprint: release.compilationOutput.resolutionFingerprint,
      comparisonFingerprint: release.comparisonFingerprint,
      dependencyManifest: [...release.dependencyManifest],
      publishedAt: metadata.updatedAt,
      publishedBy: actorId,
    };
  }
}

const publishAndReadApplication = async (
  source: DefinitionSourceDocument | ApplicationSourceDocumentV2,
) => {
  const resolution = resolutionFor(
    source,
    source.source_contract_version === "2.0.0" ? "2.0.0" : "1.0.0",
  );
  const own = resolution.definitions.find(
    (definition) => definition.kind === "application" && definition.key === source.key,
  );
  if (own?.kind !== "application") throw new Error("Application resolution required");
  const draft = storedDefinitionDraftSchema.parse({
    kind: "application",
    rootId: own.rootId,
    key: source.key,
    sourceContractVersion: source.source_contract_version,
    sourceFingerprint: fingerprintCanonicalValue(source),
    source,
    ...metadata,
  });
  const releases = dependencyReleases();
  const candidate: DefinitionPublicationCandidate = {
    draft,
    identities: resolution.identities.filter((identity) => identity.definitionKey === source.key),
    history: { kind: "application", definitionKey: source.key, history: [] },
  };
  const repository = new ApplicationPublicationRepository(candidate, releases.modules);
  const composition = catalogueV2();
  const catalogue: DefinitionPublicationCatalogue = {
    listConnectionTypeReleases: async (key) =>
      key === releases.connection.key ? [releases.connection] : [],
    readConnectionTypeRelease: async (rootId, releaseVersion) =>
      releases.connection.rootId === rootId && releases.connection.releaseVersion === releaseVersion
        ? releases.connection
        : undefined,
    readPlatformThemeRelease: async () => undefined,
    readPlatformBlockReleaseV2: async (candidateBlockId, releaseVersion) =>
      composition.platformBlocks.releases.find(
        (release) =>
          release.blockId === candidateBlockId && release.releaseVersion === releaseVersion,
      ),
    readPlatformThemeReleaseV2: async (catalogueThemeId, releaseVersion) =>
      composition.platformTheme.catalogueThemeId === catalogueThemeId &&
      composition.platformTheme.releaseVersion === releaseVersion
        ? composition.platformTheme
        : undefined,
    readApplicationCompositionCatalogueSnapshotV2: async () => composition,
  };
  const service = createDefinitionPublicationService(repository, catalogue);
  const prepared = await service.prepare(requestContext(), {
    rootId: draft.rootId,
    expectedDraftRevision: draft.draftRevision,
  });
  const published = await service.publish(requestContext(), {
    confirmation: prepared.confirmation,
    releaseNote: "Application value-pair regression",
  });
  const appended = repository.appended;
  if (!appended) throw new Error("Application append required");
  const evidence = {
    organizationId,
    kind: "application" as const,
    key: source.key,
    rootId: draft.rootId,
    releaseRevision: draft.draftRevision,
    releaseVersion: published.releaseVersion,
    sourceContractVersion: source.source_contract_version,
    validationContractVersion: appended.validationContractVersion,
    contentFingerprint: appended.compilationOutput.artifact.contentFingerprint,
    resolutionFingerprint: appended.compilationOutput.resolutionFingerprint,
    compilationOutput: appended.compilationOutput,
    resolutionSnapshot: appended.resolutionSnapshot,
    dependencyManifest: appended.dependencyManifest,
    moduleDependencyTargets: appended.dependencyManifest.flatMap((dependency) =>
      dependency.kind === "module"
        ? [
            {
              rootId: dependency.rootId,
              releaseRevision: dependency.releaseRevision,
              releaseVersion: dependency.releaseVersion,
              contentFingerprint: dependency.contentFingerprint,
              resolutionFingerprint: dependency.resolutionFingerprint,
            },
          ]
        : [],
    ),
  };
  const read = await createDefinitionConsumerReadService(
    { read: async () => evidence },
    catalogue,
  ).read(requestContext(), {
    kind: "application",
    rootId: draft.rootId,
    selector: { selection: "revision", releaseRevision: draft.draftRevision },
  });
  return { read, evidence, catalogue };
};

const canonicalConditionValue = (condition: unknown) =>
  (condition as { right: { value: unknown } }).right.value;

const expectRefusal = (operation: () => unknown, ruleCode: string) => {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ ruleCode });
    return;
  }
  throw new Error(`Expected ${ruleCode}`);
};

describe("Application values follow their owning Module pair", () => {
  it.each([
    ["Application V1", applicationV1],
    ["Application V2", applicationV2],
  ])("normalizes exact values across %s consumers and preserves V1 numbers", (_name, source) => {
    const { output, modules } = compileApplication(source());
    const content = output.canonical.content as unknown as JsonObject;
    const queries = content.queries as JsonObject[];
    const exactQuery = queries.find((query) => query.key === "exact_values")!;
    const v1Query = queries.find((query) => query.key === "v1_numbers")!;
    const exactQueryConditions = (exactQuery.filter as JsonObject).conditions as JsonObject[];
    expect(canonicalConditionValue(exactQueryConditions[0])).toBe(exactCanonicalValue);
    expect(canonicalConditionValue(exactQueryConditions[1])).toEqual({
      amount: "12.34",
      currency: "NZD",
    });
    expect(canonicalConditionValue(v1Query.filter)).toBe(7);

    const page = (content.pages as JsonObject[])[0]!;
    const placement =
      source().source_contract_version === "2.0.0"
        ? Object.values(
            ((page.composition as JsonObject).main as JsonObject).placements as JsonObject,
          )[0]!
        : (page.blocks as JsonObject[])[0]!;
    expect(canonicalConditionValue((placement as JsonObject).visibilityCondition)).toBe(
      exactCanonicalValue,
    );
    const pipeline = (content.pipelines as JsonObject[])[0]!;
    expect(
      canonicalConditionValue(((pipeline.transitions as JsonObject[])[0] as JsonObject).gate),
    ).toBe(exactCanonicalValue);

    const applicationActions = content.actions as JsonObject[];
    const action = applicationActions.find(
      (candidate) => candidate.key === "application.crm.exact_values",
    )!;
    expect(canonicalConditionValue(action.precondition)).toBe(exactCanonicalValue);
    const effects = action.effects as JsonObject[];
    expect(((effects[0]!.value as JsonObject).value as JsonObject).amount).toBe("12.34");
    const canonicalSla = modules.find(
      (module) => module.artifact.definitionKey === "vortex.service_desk.sla",
    )!;
    const calendarRecordId = (
      (canonicalSla.canonical.content.recordTypes as unknown as JsonObject[]).find(
        (record) => record.key === "business_calendar",
      ) as JsonObject
    ).recordTypeId;
    expect(canonicalConditionValue(exactQueryConditions[2])).toEqual({
      recordTypeId: calendarRecordId,
      recordId,
    });
    expect((effects[1]!.value as JsonObject).value).toEqual({
      recordTypeId: calendarRecordId,
      recordId,
    });
    const created = effects[2]!.values as JsonObject;
    const createdValues = Object.values(created) as JsonObject[];
    expect(createdValues).toContainEqual({ source: "literal", value: exactCanonicalValue });
    expect(createdValues).toContainEqual({
      source: "literal",
      value: { amount: "15.5", currency: "NZD" },
    });
    const v1Action = applicationActions.find(
      (candidate) => candidate.key === "application.crm.v1_input",
    )!;
    expect((v1Action.inputs as JsonObject[])[0]).toMatchObject({
      type: "number",
      validation: { minimum: 1, maximum: 1000 },
    });

    const rule = (content.rules as JsonObject[])[0]!;
    expect(canonicalConditionValue(rule.condition)).toBe(exactCanonicalValue);
    expect((rule.effect as JsonObject).value).toEqual({ amount: "19.99", currency: "NZD" });

    const workflow = (content.workflows as JsonObject[])[0]!;
    expect(canonicalConditionValue((workflow.trigger as JsonObject).condition)).toBe(
      exactCanonicalValue,
    );
    const nodes = workflow.nodes as JsonObject[];
    const conditionNode = nodes.find((node) => node.type === "condition")!;
    expect(canonicalConditionValue((conditionNode.config as JsonObject).condition)).toBe(
      exactCanonicalValue,
    );
    const actionNode = nodes.find((node) => node.type === "run_action")!;
    const inputs = (actionNode.config as JsonObject).inputs as JsonObject;
    expect(inputs.exact_limit).toEqual({ source: "literal", value: exactCanonicalValue });
    expect(inputs.budget).toEqual({
      source: "literal",
      value: { amount: "12.34", currency: "NZD" },
    });
    expect(inputs.calendar).toEqual({
      source: "literal",
      value: { recordTypeId: calendarRecordId, recordId },
    });
    const interfaceOperation = (
      ((content.interfaces as JsonObject[])[0]!.operations as JsonObject[])[0]!
        .inputShape as JsonObject
    ).notes as JsonObject;
    expect(interfaceOperation.type).toBe("formatted_text");
  });

  it.each([
    [
      "V1 numeric fields into V2 exact fields",
      "vortex.crm.organisations:company",
      {
        kind: "create_record",
        record_type: "vortex.service_desk.sla:service_level",
        values: {
          first_response_minutes: { source: "subject_field", field: "employee_count" },
        },
      },
    ],
    [
      "V1 formatted text into V2 tables",
      "vortex.crm.organisations:company",
      {
        kind: "create_record",
        record_type: "vortex.service_desk.sla:business_calendar",
        values: { working_hours: { source: "subject_field", field: "description" } },
      },
    ],
    [
      "V2 exact decimals into V1 numeric fields",
      "vortex.service_desk.sla:service_level",
      {
        kind: "create_record",
        record_type: "vortex.crm.organisations:company",
        values: {
          employee_count: {
            source: "subject_field",
            field: "first_response_minutes",
          },
        },
      },
    ],
  ])("refuses dynamic %s without a conversion", (_name, recordType, effect) => {
    const source = applicationV1() as unknown as JsonObject;
    const body = source.body as JsonObject;
    (body.actions as JsonObject[]).push({
      id: "action_mixed_values",
      key: "application.crm.mixed_values",
      label: "Copy mixed values",
      record_type: recordType,
      permission: "application.crm.open",
      sharing: "refused",
      inputs: [],
      effects: [effect],
    });
    const parsed = definitionSourceDocumentSchema.parse(source);
    expectRefusal(
      () => compileApplication(parsed),
      "vortex.definition.application_action_references",
    );
  });

  it("allows text and whole-number values across V1 and V2 owners in both directions", () => {
    const source = applicationV1() as unknown as JsonObject;
    const body = source.body as JsonObject;
    (body.actions as JsonObject[]).push({
      id: "action_mixed_text",
      key: "application.crm.mixed_text",
      label: "Copy text",
      record_type: "vortex.crm.organisations:company",
      permission: "application.crm.open",
      sharing: "refused",
      inputs: [],
      effects: [
        {
          kind: "create_record",
          record_type: "vortex.service_desk.sla:business_calendar",
          values: { name: { source: "subject_field", field: "name" } },
        },
        {
          kind: "create_record",
          record_type: "vortex.service_desk.sla:service_level",
          values: {
            whole_count: { source: "subject_field", field: "employee_count" },
          },
        },
      ],
    });
    (body.actions as JsonObject[]).push({
      id: "action_whole_to_v1",
      key: "application.crm.whole_to_v1",
      label: "Copy whole to V1",
      record_type: "vortex.service_desk.sla:service_level",
      permission: "application.crm.open",
      sharing: "refused",
      inputs: [],
      effects: [
        {
          kind: "create_record",
          record_type: "vortex.crm.organisations:company",
          values: { employee_count: { source: "subject_field", field: "whole_count" } },
        },
      ],
    });
    expect(() => compileApplication(definitionSourceDocumentSchema.parse(source))).not.toThrow();
  });

  it("refuses a legacy Application number input in a V2 exact-decimal precondition", () => {
    const source = applicationV1() as unknown as JsonObject;
    const body = source.body as JsonObject;
    (body.actions as JsonObject[]).push({
      id: "action_legacy_number_exact_field",
      key: "application.crm.legacy_number_exact_field",
      label: "Compare a legacy number to an exact field",
      record_type: "vortex.service_desk.sla:service_level",
      permission: "application.crm.open",
      sharing: "refused",
      inputs: [
        {
          key: "threshold",
          label: "Threshold",
          required: true,
          type: "number",
        },
      ],
      precondition: {
        field: "first_response_minutes",
        operator: "greater_than",
        parameter: "threshold",
      },
      effects: [
        {
          kind: "set_field",
          field: "active",
          value: { source: "literal", value: "paused" },
        },
      ],
    });
    expectRefusal(
      () => compileApplication(definitionSourceDocumentSchema.parse(source)),
      "vortex.definition.application_action_references",
    );
  });

  it.each(["first_response_minutes", "resolution_minutes"])(
    "refuses a legacy Application number input assigned to V2 exact field %s",
    (field) => {
      const source = applicationV1() as unknown as JsonObject;
      const body = source.body as JsonObject;
      (body.actions as JsonObject[]).push({
        id: `action_legacy_number_${field}`,
        key: `application.crm.legacy_number_${field}`,
        label: "Assign a legacy number to an exact field",
        record_type: "vortex.service_desk.sla:service_level",
        permission: "application.crm.open",
        sharing: "refused",
        inputs: [
          {
            key: "value",
            label: "Value",
            required: true,
            type: "number",
          },
        ],
        effects: [
          {
            kind: "set_field",
            field,
            value: { source: "input", input: "value" },
          },
        ],
      });
      expectRefusal(
        () => compileApplication(definitionSourceDocumentSchema.parse(source)),
        "vortex.definition.application_action_references",
      );
    },
  );

  it.each([
    ["first_response_minutes", "whole_count"],
    ["whole_count", "first_response_minutes"],
  ])(
    "refuses dynamic V2 %s assignments to differently represented %s",
    (sourceField, targetField) => {
      const source = applicationV1() as unknown as JsonObject;
      const body = source.body as JsonObject;
      (body.actions as JsonObject[]).push({
        id: `action_v2_${sourceField}_to_${targetField}`,
        key: `application.crm.v2_${sourceField}_to_${targetField}`,
        label: "Copy incompatible V2 values",
        record_type: "vortex.service_desk.sla:service_level",
        permission: "application.crm.open",
        sharing: "refused",
        inputs: [],
        effects: [
          {
            kind: "set_field",
            field: targetField,
            value: { source: "subject_field", field: sourceField },
          },
        ],
      });
      expectRefusal(
        () => compileApplication(definitionSourceDocumentSchema.parse(source)),
        "vortex.definition.application_action_references",
      );
    },
  );

  it("refuses a Module V2 workflow action literal outside its declared record targets", () => {
    const source = applicationV1() as unknown as JsonObject;
    const body = source.body as JsonObject;
    const workflow = (body.workflows as JsonObject[])[0]!;
    const actionNode = (workflow.nodes as JsonObject[]).find((node) => node.type === "run_action")!;
    const calendar = ((actionNode.config as JsonObject).inputs as JsonObject)
      .calendar as JsonObject;
    calendar.value = {
      record_type: "vortex.crm.organisations:company",
      record_id: recordId,
    };
    expectRefusal(
      () => compileApplication(definitionSourceDocumentSchema.parse(source)),
      "vortex.definition.workflow_action_inputs",
    );
  });

  it("refuses a V2 exact field passed to a legacy Module number action input", () => {
    const source = applicationV1() as unknown as JsonObject;
    const body = source.body as JsonObject;
    const workflow = (body.workflows as JsonObject[])[0]!;
    const actionNode = (workflow.nodes as JsonObject[]).find((node) => node.type === "run_action")!;
    actionNode.config = {
      action: "vortex.crm.organisations.company.merge",
      subject: {
        source: "literal",
        value: {
          record_type: "vortex.crm.organisations:company",
          record_id: recordId,
        },
      },
      inputs: {
        duplicate_company: {
          source: "literal",
          value: {
            record_type: "vortex.crm.organisations:company",
            record_id: recordId,
          },
        },
        legacy_limit: {
          source: "trigger_field",
          field: "vortex.service_desk.sla:service_level.first_response_minutes",
        },
      },
    };
    expectRefusal(
      () => compileApplication(definitionSourceDocumentSchema.parse(source)),
      "vortex.definition.workflow_action_inputs",
    );
  });

  it("refuses a V2 exact workflow field passed to a legacy connection number input", () => {
    const source = applicationV1() as unknown as JsonObject;
    const body = source.body as JsonObject;
    const workflow = (body.workflows as JsonObject[])[0]!;
    const actionNode = (workflow.nodes as JsonObject[]).find((node) => node.type === "run_action")!;
    actionNode.type = "call_connection";
    actionNode.config = {
      connection: "webhook",
      operation: "post_json",
      inputs: {
        threshold: {
          source: "trigger_field",
          field: "vortex.service_desk.sla:service_level.first_response_minutes",
        },
      },
    };
    expectRefusal(
      () => compileApplication(definitionSourceDocumentSchema.parse(source)),
      "vortex.definition.workflow_connection_inputs",
    );
  });

  it("refuses workflow trigger-field links outside a destination field's targets", () => {
    const source = applicationV1() as unknown as JsonObject;
    const body = source.body as JsonObject;
    const workflow = (body.workflows as JsonObject[])[0]!;
    const actionNode = (workflow.nodes as JsonObject[]).find((node) => node.type === "run_action")!;
    actionNode.type = "create_record";
    actionNode.config = {
      record_type: "vortex.crm.organisations:company",
      values: {
        parent_company: {
          source: "trigger_field",
          field: "vortex.service_desk.sla:service_level.calendar",
        },
      },
    };
    expectRefusal(
      () => compileApplication(definitionSourceDocumentSchema.parse(source)),
      "vortex.definition.workflow_node_values",
    );
  });

  it("refuses exposing exact V2 query fields as lossy interface numbers", () => {
    const source = applicationV1() as unknown as JsonObject;
    const body = source.body as JsonObject;
    (body.interfaces as JsonObject[]).push({
      id: "interface_exact_values",
      key: "application.crm.exact_values",
      version: "1.0.0",
      state: "supported",
      operations: [
        {
          id: "interface_exact_values_list",
          key: "list_exact_values",
          description: "List exact values.",
          input_shape: {},
          output_shape: {
            exact: {
              type: "number",
              required: true,
              target_binding: {
                kind: "query_field",
                field: "vortex.service_desk.sla:service_level.first_response_minutes",
              },
            },
          },
          authentication: "organisation_token",
          permission: "application.crm.open",
          visibility: "organisation_private",
          rate_limit_per_minute: 60,
          maximum_request_bytes: 10000,
          duplicate_protection: "not_required",
          target: { kind: "query", key: "exact_values" },
          error_codes: ["validation_failed"],
          method: "GET",
          path: "/exact-values",
        },
      ],
    });
    const parsed = definitionSourceDocumentSchema.parse(source);
    expectRefusal(
      () => compileApplication(parsed),
      "vortex.definition.application_interface_shape",
    );
  });

  it("uses a derived field result type when checking query aggregates", () => {
    const source = applicationV1() as unknown as JsonObject;
    const body = source.body as JsonObject;
    (body.queries as JsonObject[]).push({
      id: "query_invalid_text_sum",
      key: "invalid_text_sum",
      record_type: "vortex.crm.people:contact",
      select: ["full_name"],
      filter: null,
      group_by: [],
      aggregates: [{ operation: "sum", field: "full_name", alias: "invalid_sum" }],
      sort: [{ field: "full_name", direction: "ascending" }],
      page_size: 25,
      relationship_hops: 0,
    });
    expectRefusal(
      () => compileApplication(definitionSourceDocumentSchema.parse(source)),
      "vortex.definition.application_query_references",
    );
  });

  it("refuses noncanonical exact values in compiled Application content", () => {
    const source = applicationV1();
    const { output, modules } = compileApplication(source);
    const tampered = structuredClone(output) as unknown as JsonObject;
    const content = (tampered.canonical as JsonObject).content as JsonObject;
    const query = (content.queries as JsonObject[]).find((entry) => entry.key === "exact_values")!;
    const first = ((query.filter as JsonObject).conditions as JsonObject[])[0]!;
    ((first as JsonObject).right as JsonObject).value = exactSourceValue;
    (tampered.artifact as JsonObject).contentFingerprint = fingerprintCanonicalValue(content);
    const resolution = resolutionFor(source, "1.0.0") as DefinitionResolutionSnapshot;
    const request = { source, resolution, draftMetadata: metadata };
    const validation = validateDefinitionSet({
      requests: [request],
      outputs: [tampered as unknown as DefinitionCompilationOutput],
      dependencyOutputs: modules,
      publishedHistories: [{ kind: "application", definitionKey: applicationKey, history: [] }],
    });
    expect(validation.valid).toBe(false);
    expect(validation.failures).toContainEqual(
      expect.objectContaining({ ruleCode: "vortex.definition.application_query_references" }),
    );
  });

  it.each(["wrong_reference_targets", "targets_on_text"])(
    "refuses canonical trigger record-field evidence: %s",
    (scenario) => {
      const source = applicationV1();
      const { output, modules } = compileApplication(source);
      const tampered = structuredClone(output) as unknown as JsonObject;
      const content = (tampered.canonical as JsonObject).content as JsonObject;
      const workflows = content.workflows as JsonObject[];
      const workflow = workflows.find((candidate) =>
        scenario === "wrong_reference_targets"
          ? candidate.key === "exact_values"
          : candidate.key === "v1_fields_to_v2_inputs",
      )!;
      const inputs = (workflow.trigger as JsonObject).inputs as JsonObject[];
      const input = inputs.find((candidate) =>
        scenario === "wrong_reference_targets"
          ? candidate.key === "calendar"
          : candidate.key === "label",
      )!;
      const company = modules
        .find((module) => module.artifact.definitionKey === "vortex.crm.organisations")!
        .canonical.content.recordTypes.find((record) => record.key === "company")!;
      input.recordTypeIds = [company.recordTypeId];
      (tampered.artifact as JsonObject).contentFingerprint = fingerprintCanonicalValue(content);
      const resolution = resolutionFor(source, "1.0.0") as DefinitionResolutionSnapshot;
      const validation = validateDefinitionSet({
        requests: [{ source, resolution, draftMetadata: metadata }],
        outputs: [tampered as unknown as DefinitionCompilationOutput],
        dependencyOutputs: modules,
        publishedHistories: [{ kind: "application", definitionKey: applicationKey, history: [] }],
      });
      expect(validation.failures).toContainEqual(
        expect.objectContaining({ ruleCode: "vortex.definition.workflow_trigger_values" }),
      );
    },
  );

  it.each([
    ["Application V1", applicationV1],
    ["Application V2", applicationV2],
  ])("publishes and reads exact owning-Module values through %s", async (_name, source) => {
    const { read } = await publishAndReadApplication(source());
    const query = (read.content.queries as unknown as JsonObject[]).find(
      (candidate) => candidate.key === "exact_values",
    )!;
    const conditions = (query.filter as JsonObject).conditions as JsonObject[];
    expect(canonicalConditionValue(conditions[0])).toBe(exactCanonicalValue);
    expect(canonicalConditionValue(conditions[1])).toEqual({ amount: "12.34", currency: "NZD" });
    const operation = (
      ((read.content.interfaces as unknown as JsonObject[])[0]!.operations as JsonObject[])[0]!
        .inputShape as JsonObject
    ).notes as JsonObject;
    expect(operation.type).toBe("formatted_text");
  });

  it("continues to read historical canonical record-field inputs without target evidence", async () => {
    const { evidence, catalogue } = await publishAndReadApplication(applicationV1());
    const historical = structuredClone(evidence) as unknown as JsonObject;
    const output = historical.compilationOutput as JsonObject;
    const canonical = output.canonical as JsonObject;
    const content = canonical.content as JsonObject;
    const workflow = (content.workflows as JsonObject[]).find(
      (candidate) => candidate.key === "exact_values",
    )!;
    const trigger = workflow.trigger as JsonObject;
    const input = (trigger.inputs as JsonObject[])[0]!;
    expect(input.recordTypeIds).toBeDefined();
    delete input.recordTypeIds;
    const contentFingerprint = fingerprintCanonicalValue(content);
    (output.artifact as JsonObject).contentFingerprint = contentFingerprint;
    historical.contentFingerprint = contentFingerprint;
    const parsedOutput = definitionCompilationOutputSchema.parse(output);
    historical.compilationOutput = parsedOutput;
    await expect(
      createDefinitionConsumerReadService({ read: async () => historical }, catalogue).read(
        requestContext(),
        {
          kind: "application",
          rootId: String(historical.rootId),
          selector: { selection: "revision", releaseRevision: Number(historical.releaseRevision) },
        },
      ),
    ).resolves.toMatchObject({ content });
  });
});
