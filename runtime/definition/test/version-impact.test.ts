import { describe, expect, test } from "vitest";
import {
  fieldTypeKeys,
  workflowNodeTypeKeys,
  publishedApplicationDefinitionSchema,
} from "@vortex/contracts";
import type {
  ActionDefinition,
  ApplicationDraft,
  BlockRegistration,
  InterfaceDefinition,
  ModuleDraft,
  Pipeline,
  QueryDefinition,
} from "@vortex/contracts";
import {
  confirmDefinitionVersionImpact,
  compareDefinitionVersionImpact,
} from "../src/version-impact";
import {
  canonicalJson,
  compareCanonicalStrings,
  fingerprintCanonicalValue,
} from "../src/canonical-json";
import { DefinitionVersionImpactError } from "../src/version-impact-error";
import { assignNextDefinitionVersion } from "../src/semantic-version";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const timestamp = "2026-09-03T00:00:00+00:00";

const field = (fieldId = id(10), required = false) => ({
  fieldId,
  key: `field_${fieldId.slice(-2)}`,
  label: "Field",
  required,
  unique: false,
  filterable: true,
  sortable: true,
  personalData: "none",
  publicDisplay: "refused",
  type: "text",
  settings: { maxLength: 120 },
});

const moduleDraft = (): ModuleDraft =>
  ({
    envelope: {
      kind: "module",
      rootId: id(1),
      organizationId: id(2),
      key: "sample.module",
      draftRevision: 1,
      publishedRevision: undefined as number | undefined,
      createdAt: timestamp,
      createdBy: id(3),
      updatedAt: timestamp,
      updatedBy: id(3),
    },
    content: {
      name: "Sample module",
      description: "A neutral module definition.",
      dependencies: [],
      recordTypes: [
        {
          recordTypeId: id(4),
          key: "record",
          singularLabel: "Record",
          pluralLabel: "Records",
          titleFieldId: id(10),
          storageContractId: id(5),
          storageScope: "organization_shared",
          ownershipMode: "none",
          fields: [field()],
          relationships: [],
          standardActions: ["read"],
          customActionIds: [],
        },
      ],
      permissions: [
        {
          permissionId: id(6),
          key: "sample.record.read",
          label: "Read records",
          description: "Allows records to be read.",
          recordTypeId: id(4),
          actionKind: "read",
          administrative: false,
        },
      ],
      actions: [],
      events: [],
      rules: [],
      sharingConditions: [],
      extensionPoints: [],
    },
  }) as unknown as ModuleDraft;

const applicationDraft = (): ApplicationDraft =>
  ({
    envelope: {
      kind: "application",
      rootId: id(20),
      organizationId: id(2),
      key: "sample.application",
      draftRevision: 1,
      publishedRevision: undefined as number | undefined,
      createdAt: timestamp,
      createdBy: id(3),
      updatedAt: timestamp,
      updatedBy: id(3),
    },
    content: {
      name: "Sample application",
      description: "A neutral application definition.",
      icon: "sample",
      moduleBindings: [
        {
          moduleRootId: id(1),
          version: { selection: "exact", version: "1.0.0" },
          resolvedVersion: "1.0.0",
          purpose: "primary",
        },
      ],
      navigation: [],
      pages: [
        {
          pageId: id(21),
          key: "home",
          name: "Home",
          type: "public",
          accessPermissionKey: "sample.public.open",
          states: ["normal"],
          layout: {
            desktop: { columns: 12, componentOrder: [id(22)] },
            phone: { componentOrder: [id(22)] },
          },
          publicFieldIds: [],
          blocks: [
            {
              placementId: id(22),
              blockId: id(23),
              blockReleaseVersion: "1.0.0",
              settings: {},
              desktop: { startColumn: 1, span: 12, height: 1 },
              phone: { order: 0, behaviour: "full_width" },
              viewPermissionKey: "sample.public.open",
            },
          ],
          rateLimitPerMinute: 60,
        },
      ],
      roles: [
        {
          roleId: id(24),
          key: "reader",
          name: "Reader",
          homePageId: id(21),
          permissionKeys: ["sample.public.open"],
          permissionSelection: { kind: "exact" },
        },
      ],
      queries: [],
      blockRegistrations: [],
      pipelines: [],
      permissions: [
        {
          permissionId: id(25),
          key: "sample.public.open",
          label: "Open public page",
          description: "Allows the public page to be opened.",
          actionKind: "read",
          administrative: false,
        },
      ],
      actions: [],
      rules: [],
      events: [],
      workflows: [],
      connectionBindings: [],
      interfaces: [],
      publicAddresses: [],
      theme: {
        mode: "application",
        lightAndDark: true,
        tokens: {
          brand: "indigo",
          density: "comfortable",
          corners: "medium",
          focus: "high_contrast",
        },
      },
      homePageId: id(21),
    },
  }) as unknown as ApplicationDraft;

const publish = (draft: ReturnType<typeof moduleDraft>, version = "1.0.0", revision = 1) => ({
  publication: {
    kind: "module",
    rootId: draft.envelope.rootId,
    revision,
    releaseVersion: version,
    contentFingerprint: fingerprintCanonicalValue(draft.content),
    publishedAt: timestamp,
    publishedBy: id(3),
    validationContractVersion: "1.0.0",
  },
  content: structuredClone(draft.content),
  dependencyManifest: [],
  releaseNote: "Published definition.",
});

const publishApplication = (
  draft: ReturnType<typeof applicationDraft>,
  version = "1.0.0",
  revision = 1,
) => ({
  publication: {
    kind: "application",
    rootId: draft.envelope.rootId,
    revision,
    releaseVersion: version,
    contentFingerprint: fingerprintCanonicalValue(draft.content),
    publishedAt: timestamp,
    publishedBy: id(3),
    validationContractVersion: "1.0.0",
  },
  content: structuredClone(draft.content),
  dependencyManifest: [],
  releaseNote: "Published definition.",
});

const requestAfter = (draft: ReturnType<typeof moduleDraft>) => {
  const published = publish(draft);
  const candidate = structuredClone(draft);
  candidate.envelope.draftRevision = 2;
  candidate.envelope.publishedRevision = 1;
  return { kind: "module", history: [published], candidate };
};

const applicationRequestAfter = (draft: ReturnType<typeof applicationDraft>) => {
  const published = publishApplication(draft);
  const candidate = structuredClone(draft);
  candidate.envelope.draftRevision = 2;
  candidate.envelope.publishedRevision = 1;
  return { kind: "application", history: [published], candidate };
};

describe("literal/reference version regression", () => {
  test("round-trips page literal JSON through publication contracts and compares its changes", () => {
    const draft = applicationDraft();
    const page = draft.content.pages[0]!;
    if (page.type !== "public") throw new Error("Neutral public page required");
    const payload = {
      state: "unresolved",
      qualifiedKey: "sample:item",
      nested: [{ rootId: "data" }],
    };
    page.blocks[0]!.settings.payload = { kind: "literal", value: payload };
    const release = publishedApplicationDefinitionSchema.parse(publishApplication(draft));
    expect(JSON.parse(JSON.stringify(release.content))).toEqual(draft.content);
    const request = applicationRequestAfter(draft);
    const before = compareDefinitionVersionImpact(request);
    const changedPage = request.candidate.content.pages[0]!;
    if (changedPage.type !== "public") throw new Error("Neutral public page required");
    changedPage.blocks[0]!.settings.payload = {
      kind: "literal",
      value: { ...payload, nested: [] },
    };
    const after = compareDefinitionVersionImpact(request);
    expect(after.outcome).not.toBe("no_change");
    expect(after.comparisonFingerprint).not.toBe(before.comparisonFingerprint);
  });

  test("refuses a real unresolved reference beside literal data", () => {
    const draft = applicationDraft();
    draft.content.pages[0]!.standardPageReplacement = {
      standardPage: "detail",
      recordType: { state: "unresolved", qualifiedKey: "sample:item" },
    };
    const published = publishedApplicationDefinitionSchema.safeParse(publishApplication(draft));
    expect(published.success).toBe(false);
    if (!published.success)
      expect(published.error.issues[0]?.path).toEqual([
        "content",
        "pages",
        0,
        "standardPageReplacement",
        "recordType",
      ]);
    expect(() =>
      compareDefinitionVersionImpact({ kind: "application", candidate: draft, history: [] }),
    ).toThrow(expect.objectContaining({ code: "unresolved_candidate" }));
  });
});

const resolvedRecordType = (moduleRootId = id(1), recordTypeId = id(4)) => ({
  state: "resolved",
  moduleRootId,
  recordTypeId,
});

const dailySchedule = () => ({
  cadence: "daily" as const,
  interval: 1,
  timeZone: "Pacific/Auckland",
  minute: 0,
  hour: 0,
});

const fieldCases = [
  [
    "text",
    { maxLength: 120 },
    (value: Record<string, unknown>) => (value.maxLength = 240),
    "minor",
  ],
  [
    "long_text",
    { maxLength: 1_000 },
    (value: Record<string, unknown>) => (value.maxLength = 2_000),
    "minor",
  ],
  [
    "formatted_text",
    { allowedBlocks: ["paragraph"] },
    (value: Record<string, unknown>) => (value.allowedBlocks as string[]).push("heading"),
    "minor",
  ],
  [
    "whole_number",
    { minimum: 0, maximum: 100 },
    (value: Record<string, unknown>) => (value.maximum = 200),
    "minor",
  ],
  [
    "decimal_number",
    { digitsBeforeDecimal: 8, decimalPlaces: 2, maximum: 100 },
    (value: Record<string, unknown>) => (value.maximum = 200),
    "minor",
  ],
  [
    "money",
    { currencyMode: "organization_default", maximum: 100 },
    (value: Record<string, unknown>) => (value.maximum = 200),
    "minor",
  ],
  [
    "yes_no",
    {},
    (_value: Record<string, unknown>, item: Record<string, unknown>) =>
      (item.label = "Updated field"),
    "patch",
  ],
  [
    "date",
    { latest: "2026-12-31" },
    (value: Record<string, unknown>) => (value.latest = "2027-12-31"),
    "minor",
  ],
  [
    "date_time",
    { displayTimeZone: "person" },
    (value: Record<string, unknown>) => (value.displayTimeZone = "utc"),
    "patch",
  ],
  [
    "choice",
    { options: [{ value: "first", label: "First" }] },
    (value: Record<string, unknown>) =>
      (value.options as unknown[]).push({ value: "second", label: "Second" }),
    "minor",
  ],
  [
    "several_choices",
    { options: [{ value: "first", label: "First" }], maximumSelections: 1 },
    (value: Record<string, unknown>) =>
      (value.options as unknown[]).push({ value: "second", label: "Second" }),
    "minor",
  ],
  [
    "reference_number",
    { digits: 8, prefix: "REF-" },
    (value: Record<string, unknown>) => (value.prefix = "NEW-"),
    "major",
  ],
  [
    "email_address",
    {},
    (_value: Record<string, unknown>, item: Record<string, unknown>) =>
      (item.label = "Updated field"),
    "patch",
  ],
  [
    "phone_number",
    { defaultCountry: "NZ" },
    (value: Record<string, unknown>) => (value.defaultCountry = "AU"),
    "patch",
  ],
  [
    "web_address",
    { allowedSchemes: ["https"] },
    (_value: Record<string, unknown>, item: Record<string, unknown>) =>
      (item.label = "Updated field"),
    "patch",
  ],
  [
    "table",
    { columns: [{ key: "value", type: "text", required: false }], minimumRows: 0, maximumRows: 20 },
    (value: Record<string, unknown>) => (value.maximumRows = 40),
    "minor",
  ],
  [
    "link",
    { target: resolvedRecordType(), reverseKey: "records", onParentDelete: "refuse" },
    (value: Record<string, unknown>) => (value.onParentDelete = "empty_optional"),
    "major",
  ],
  [
    "link_to_one_of_several",
    { targets: [resolvedRecordType()], onParentDelete: "refuse" },
    (value: Record<string, unknown>) =>
      (value.targets as unknown[]).push(resolvedRecordType(id(8), id(9))),
    "minor",
  ],
  [
    "link_to_person",
    {
      audience: "organization_accounts",
      applicationRootIdRequired: false,
      onPersonDeactivation: "retain_reference",
    },
    (value: Record<string, unknown>) => (value.applicationRootIdRequired = true),
    "major",
  ],
  [
    "calculation",
    {
      resultType: "text",
      expression: { kind: "join_text", fieldIds: [id(10)], separator: " " },
      dependencyFieldIds: [id(10)],
    },
    (value: Record<string, unknown>) =>
      (value.expression = { kind: "join_text", fieldIds: [id(10)], separator: "," }),
    "major",
  ],
  [
    "total",
    { relationshipId: id(12), operation: "count", resultType: "whole_number" },
    (value: Record<string, unknown>) => (value.operation = "maximum"),
    "major",
  ],
  [
    "attachment",
    { allowedKinds: ["document"], maxFileSizeMb: 25, multiple: true, maxFiles: 5 },
    (value: Record<string, unknown>) => (value.maxFileSizeMb = 50),
    "minor",
  ],
] as const;

const condition = (right: boolean) => ({
  kind: "comparison",
  operator: "equals",
  left: { source: "value", value: true },
  right: { source: "value", value: right },
});

const workflowCases = [
  ["start", {}, {}, true],
  ["condition", { condition: condition(true) }, { condition: condition(false) }],
  [
    "decision_table",
    {
      decisions: [
        { when: condition(true), output: "yes" },
        { when: condition(false), output: "no" },
      ],
    },
    {
      decisions: [
        { when: condition(true), output: "accepted" },
        { when: condition(false), output: "no" },
      ],
    },
  ],
  [
    "bounded_loop",
    { queryId: id(120), maximumRecords: 100 },
    { queryId: id(120), maximumRecords: 101 },
  ],
  ["delay", { seconds: 60 }, { seconds: 61 }],
  ["wait_until", { dateTimeFieldId: id(121) }, { dateTimeFieldId: id(122) }],
  ["start_workflow", { workflowId: id(123) }, { workflowId: id(124) }],
  ["stop", { reasonCode: "complete" }, { reasonCode: "cancelled" }],
  [
    "create_record",
    { recordTypeId: id(4), values: {} },
    { recordTypeId: id(4), values: { [id(10)]: { source: "literal", value: "new" } } },
  ],
  [
    "change_record",
    {
      recordTypeId: id(4),
      record: { source: "current_record" },
      values: { [id(10)]: { source: "literal", value: "before" } },
    },
    {
      recordTypeId: id(4),
      record: { source: "current_record" },
      values: { [id(10)]: { source: "literal", value: "after" } },
    },
  ],
  [
    "run_action",
    { actionKey: "sample.record.update", subject: { source: "current_record" }, inputs: {} },
    { actionKey: "sample.record.change", subject: { source: "current_record" }, inputs: {} },
  ],
  [
    "soft_delete_record",
    { recordTypeId: id(4), record: { source: "current_record" } },
    { recordTypeId: id(9), record: { source: "current_record" } },
  ],
  [
    "duplicate_record",
    { recordTypeId: id(4), record: { source: "current_record" } },
    { recordTypeId: id(9), record: { source: "current_record" } },
  ],
  [
    "add_relationship",
    {
      relationshipId: id(125),
      subject: { source: "current_record" },
      target: { source: "current_record" },
    },
    {
      relationshipId: id(126),
      subject: { source: "current_record" },
      target: { source: "current_record" },
    },
  ],
  [
    "copy_relationships",
    {
      relationshipIds: [id(125)],
      sourceRecord: { source: "current_record" },
      targetRecord: { source: "current_record" },
    },
    {
      relationshipIds: [id(126)],
      sourceRecord: { source: "current_record" },
      targetRecord: { source: "current_record" },
    },
  ],
  [
    "request_form",
    {
      pageId: id(21),
      responderPermissionKey: "sample.public.open",
      dueInSeconds: 60,
      timeoutOutcome: "expired",
      outputs: [{ key: "response", type: "text" }],
    },
    {
      pageId: id(21),
      responderPermissionKey: "sample.public.open",
      dueInSeconds: 61,
      timeoutOutcome: "expired",
      outputs: [{ key: "response", type: "text" }],
    },
  ],
  ["query_records", { queryId: id(127) }, { queryId: id(128) }],
  [
    "set_values",
    {
      record: { source: "current_record" },
      values: { [id(10)]: { source: "literal", value: "before" } },
    },
    {
      record: { source: "current_record" },
      values: { [id(10)]: { source: "literal", value: "after" } },
    },
  ],
  [
    "format_value",
    { formatterKey: "short", input: { source: "literal", value: "value" } },
    { formatterKey: "long", input: { source: "literal", value: "value" } },
  ],
  [
    "generate_export",
    { queryId: id(127), maximumRows: 100 },
    { queryId: id(127), maximumRows: 101 },
  ],
  [
    "attach_file",
    {
      record: { source: "current_record" },
      fieldId: id(10),
      file: { source: "literal", value: "file" },
    },
    {
      record: { source: "current_record" },
      fieldId: id(11),
      file: { source: "literal", value: "file" },
    },
  ],
  [
    "move_file",
    {
      record: { source: "current_record" },
      fieldId: id(10),
      file: { source: "literal", value: "file" },
    },
    {
      record: { source: "current_record" },
      fieldId: id(11),
      file: { source: "literal", value: "file" },
    },
  ],
  [
    "call_connection",
    { connectionBindingId: id(129), operationKey: "send", inputs: {} },
    { connectionBindingId: id(129), operationKey: "receive", inputs: {} },
  ],
  ["acknowledge_message", { messageKey: "received" }, { messageKey: "accepted" }],
] as const;

const expectCode = (operation: () => unknown, code: string) => {
  try {
    operation();
    throw new Error("Expected a refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(DefinitionVersionImpactError);
    expect((error as DefinitionVersionImpactError).code).toBe(code);
  }
};

const sampleAction = (): ActionDefinition => ({
  actionId: id(40),
  key: "sample.record.update",
  label: "Update record",
  subjectRecordTypeId: id(4),
  permissionKey: "sample.record.read",
  sharing: "refused",
  inputs: [
    { key: "first", label: "First", required: false, type: "text" },
    { key: "second", label: "Second", required: false, type: "boolean" },
  ],
  effects: [
    {
      kind: "set_field",
      fieldId: id(10),
      value: { source: "input", inputKey: "first" },
    },
  ],
});

const sampleInterface = (
  visibility: "organization_private" | "partner" | "public" = "organization_private",
): InterfaceDefinition => ({
  interfaceId: id(70),
  key: "sample.interface",
  version: "1.0.0",
  state: "supported",
  operations: [
    {
      operationId: id(71),
      key: "read",
      description: "Read one result.",
      method: "GET",
      path: "/sample",
      inputShape: {},
      outputShape: {
        result: {
          type: "text",
          required: true,
          targetBinding: { kind: "query_field", fieldId: id(10) },
        },
      },
      authentication:
        visibility === "organization_private"
          ? "organization_token"
          : visibility === "partner"
            ? "partner_token"
            : "public",
      permissionKey: "sample.record.read",
      visibility,
      rateLimitPerMinute: 60,
      maximumRequestBytes: 10_000,
      duplicateProtection: "not_required",
      target: { kind: "query", key: "sample_query" },
      errorCodes: ["not_found"],
    },
  ],
});

const sampleQuery = (): QueryDefinition => ({
  queryId: id(72),
  key: "sample_query",
  recordType: resolvedRecordType(),
  selectedFieldIds: [id(10)],
  groupByFieldIds: [],
  aggregates: [],
  sort: [{ fieldId: id(10), direction: "ascending" }],
  pageSize: 25,
  relationshipHops: 0,
});

const sampleBlockRegistration = (): BlockRegistration => ({
  blockId: id(73),
  releaseVersion: "1.0.0",
  name: "Summary",
  icon: "summary",
  paletteGroup: "content",
  settings: [],
  allowedChildBlockIds: [],
  phoneBehaviour: "full_width",
  resizableHeight: false,
  liveUpdate: false,
  publicPage: false,
});

const samplePipeline = (): Pipeline => ({
  pipelineId: id(74),
  key: "sample_pipeline",
  name: "Sample pipeline",
  recordType: resolvedRecordType(),
  stageFieldId: id(10),
  stages: [
    {
      key: "open",
      label: "Open",
      entryActionKeys: [],
      exitActionKeys: [],
      entryWorkflowIds: [],
      exitWorkflowIds: [],
    },
  ],
  transitions: [{ from: "open", to: "open" }],
  timeTargets: [],
});

type PolicyField = Record<string, unknown> & { settings: Record<string, unknown> };
type FieldPolicyCase = readonly [
  name: string,
  original: PolicyField,
  mutate: (candidate: PolicyField) => void,
  impact: "patch" | "minor" | "major",
];

const policyField = (
  type: string,
  settings: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): PolicyField => ({ ...field(id(11)), type, settings, ...overrides });

const fieldPolicyDirectionCases: readonly FieldPolicyCase[] = [
  [
    "key change",
    policyField("text", { maxLength: 120 }),
    (item) => (item.key = "renamed"),
    "major",
  ],
  [
    "label change",
    policyField("text", { maxLength: 120 }),
    (item) => (item.label = "Renamed"),
    "patch",
  ],
  [
    "help text change",
    policyField("text", { maxLength: 120 }),
    (item) => (item.helpText = "Help"),
    "patch",
  ],
  [
    "search priority change",
    policyField("text", { maxLength: 120 }),
    (item) => (item.searchPriority = "first"),
    "patch",
  ],
  [
    "required narrows",
    policyField("text", { maxLength: 120 }),
    (item) => (item.required = true),
    "major",
  ],
  [
    "required widens",
    policyField("text", { maxLength: 120 }, { required: true }),
    (item) => (item.required = false),
    "minor",
  ],
  [
    "unique narrows",
    policyField("text", { maxLength: 120 }),
    (item) => (item.unique = true),
    "major",
  ],
  [
    "unique widens",
    policyField("text", { maxLength: 120 }, { unique: true }),
    (item) => (item.unique = false),
    "minor",
  ],
  [
    "filtering removed",
    policyField("text", { maxLength: 120 }),
    (item) => (item.filterable = false),
    "major",
  ],
  [
    "filtering added",
    policyField("text", { maxLength: 120 }, { filterable: false }),
    (item) => (item.filterable = true),
    "minor",
  ],
  [
    "sorting removed",
    policyField("text", { maxLength: 120 }),
    (item) => (item.sortable = false),
    "major",
  ],
  [
    "sorting added",
    policyField("text", { maxLength: 120 }, { sortable: false }),
    (item) => (item.sortable = true),
    "minor",
  ],
  [
    "default changes",
    policyField("text", { maxLength: 120 }),
    (item) => (item.default = "Value"),
    "major",
  ],
  [
    "personal-data class changes",
    policyField("text", { maxLength: 120 }),
    (item) => (item.personalData = "personal"),
    "major",
  ],
  [
    "public-display class changes",
    policyField("text", { maxLength: 120 }),
    (item) => (item.publicDisplay = "allowed"),
    "major",
  ],
  [
    "field type changes",
    policyField("text", { maxLength: 120 }),
    (item) => {
      item.type = "long_text";
      item.settings = { maxLength: 120 };
    },
    "major",
  ],
  [
    "text maximum widens",
    policyField("text", { maxLength: 120 }),
    (item) => (item.settings.maxLength = 240),
    "minor",
  ],
  [
    "text maximum narrows",
    policyField("text", { maxLength: 120 }),
    (item) => (item.settings.maxLength = 60),
    "major",
  ],
  [
    "text format changes",
    policyField("text", { maxLength: 120 }),
    (item) => (item.settings.format = "code"),
    "major",
  ],
  [
    "long text widens",
    policyField("long_text", { maxLength: 1_000 }),
    (item) => (item.settings.maxLength = 2_000),
    "minor",
  ],
  [
    "long text narrows",
    policyField("long_text", { maxLength: 1_000 }),
    (item) => (item.settings.maxLength = 500),
    "major",
  ],
  [
    "formatted block added",
    policyField("formatted_text", { allowedBlocks: ["paragraph"], maxLength: 500 }),
    (item) => (item.settings.allowedBlocks as string[]).push("heading"),
    "minor",
  ],
  [
    "formatted block removed",
    policyField("formatted_text", { allowedBlocks: ["paragraph", "heading"], maxLength: 500 }),
    (item) => (item.settings.allowedBlocks as string[]).pop(),
    "major",
  ],
  [
    "formatted maximum removed",
    policyField("formatted_text", { allowedBlocks: ["paragraph"], maxLength: 500 }),
    (item) => delete item.settings.maxLength,
    "minor",
  ],
  [
    "formatted maximum added",
    policyField("formatted_text", { allowedBlocks: ["paragraph"] }),
    (item) => (item.settings.maxLength = 500),
    "major",
  ],
  [
    "whole minimum widens",
    policyField("whole_number", { minimum: 0, maximum: 100 }),
    (item) => (item.settings.minimum = -1),
    "minor",
  ],
  [
    "whole minimum narrows",
    policyField("whole_number", { minimum: 0, maximum: 100 }),
    (item) => (item.settings.minimum = 1),
    "major",
  ],
  [
    "whole maximum widens",
    policyField("whole_number", { minimum: 0, maximum: 100 }),
    (item) => (item.settings.maximum = 200),
    "minor",
  ],
  [
    "whole maximum narrows",
    policyField("whole_number", { minimum: 0, maximum: 100 }),
    (item) => (item.settings.maximum = 50),
    "major",
  ],
  [
    "whole step changes",
    policyField("whole_number", { step: 1 }),
    (item) => (item.settings.step = 2),
    "major",
  ],
  [
    "decimal minimum widens",
    policyField("decimal_number", { digitsBeforeDecimal: 8, decimalPlaces: 2, minimum: 0 }),
    (item) => (item.settings.minimum = -1),
    "minor",
  ],
  [
    "decimal maximum narrows",
    policyField("decimal_number", { digitsBeforeDecimal: 8, decimalPlaces: 2, maximum: 100 }),
    (item) => (item.settings.maximum = 50),
    "major",
  ],
  [
    "decimal precision changes",
    policyField("decimal_number", { digitsBeforeDecimal: 8, decimalPlaces: 2 }),
    (item) => (item.settings.decimalPlaces = 3),
    "major",
  ],
  [
    "money bound widens",
    policyField("money", { currencyMode: "organization_default", maximum: 100 }),
    (item) => (item.settings.maximum = 200),
    "minor",
  ],
  [
    "money bound narrows",
    policyField("money", { currencyMode: "organization_default", maximum: 100 }),
    (item) => (item.settings.maximum = 50),
    "major",
  ],
  [
    "money currency changes",
    policyField("money", { currencyMode: "fixed", currency: "NZD" }),
    (item) => (item.settings.currency = "AUD"),
    "major",
  ],
  [
    "date earliest widens",
    policyField("date", { earliest: "2026-01-01" }),
    (item) => (item.settings.earliest = "2025-01-01"),
    "minor",
  ],
  [
    "date earliest narrows",
    policyField("date", { earliest: "2026-01-01" }),
    (item) => (item.settings.earliest = "2027-01-01"),
    "major",
  ],
  [
    "date latest widens",
    policyField("date", { latest: "2026-12-31" }),
    (item) => (item.settings.latest = "2027-12-31"),
    "minor",
  ],
  [
    "date latest narrows",
    policyField("date", { latest: "2026-12-31" }),
    (item) => (item.settings.latest = "2025-12-31"),
    "major",
  ],
  [
    "date-time presentation changes",
    policyField("date_time", { displayTimeZone: "person" }),
    (item) => (item.settings.displayTimeZone = "utc"),
    "patch",
  ],
  [
    "choice option added",
    policyField("choice", { options: [{ value: "first", label: "First" }] }),
    (item) => (item.settings.options as unknown[]).push({ value: "second", label: "Second" }),
    "minor",
  ],
  [
    "choice option removed",
    policyField("choice", {
      options: [
        { value: "first", label: "First" },
        { value: "second", label: "Second" },
      ],
    }),
    (item) => (item.settings.options as unknown[]).pop(),
    "major",
  ],
  [
    "choice label changes",
    policyField("choice", { options: [{ value: "first", label: "First" }] }),
    (item) => ((item.settings.options as PolicyField[])[0]!.label = "Renamed"),
    "patch",
  ],
  [
    "several-choice maximum widens",
    policyField("several_choices", {
      options: [{ value: "first", label: "First" }],
      maximumSelections: 1,
    }),
    (item) => delete item.settings.maximumSelections,
    "minor",
  ],
  [
    "several-choice maximum narrows",
    policyField("several_choices", { options: [{ value: "first", label: "First" }] }),
    (item) => (item.settings.maximumSelections = 1),
    "major",
  ],
  [
    "table optional column added",
    policyField("table", {
      columns: [{ key: "first", type: "text", required: false }],
      minimumRows: 0,
      maximumRows: 20,
    }),
    (item) =>
      (item.settings.columns as unknown[]).push({ key: "second", type: "yes_no", required: false }),
    "minor",
  ],
  [
    "table required column added",
    policyField("table", {
      columns: [{ key: "first", type: "text", required: false }],
      minimumRows: 0,
      maximumRows: 20,
    }),
    (item) =>
      (item.settings.columns as unknown[]).push({ key: "second", type: "yes_no", required: true }),
    "major",
  ],
  [
    "table column removed",
    policyField("table", {
      columns: [
        { key: "first", type: "text", required: false },
        { key: "second", type: "yes_no", required: false },
      ],
      minimumRows: 0,
      maximumRows: 20,
    }),
    (item) => (item.settings.columns as unknown[]).pop(),
    "major",
  ],
  [
    "table minimum widens",
    policyField("table", {
      columns: [{ key: "first", type: "text", required: false }],
      minimumRows: 1,
      maximumRows: 20,
    }),
    (item) => (item.settings.minimumRows = 0),
    "minor",
  ],
  [
    "table minimum narrows",
    policyField("table", {
      columns: [{ key: "first", type: "text", required: false }],
      minimumRows: 0,
      maximumRows: 20,
    }),
    (item) => (item.settings.minimumRows = 1),
    "major",
  ],
  [
    "table maximum widens",
    policyField("table", {
      columns: [{ key: "first", type: "text", required: false }],
      minimumRows: 0,
      maximumRows: 20,
    }),
    (item) => (item.settings.maximumRows = 40),
    "minor",
  ],
  [
    "table maximum narrows",
    policyField("table", {
      columns: [{ key: "first", type: "text", required: false }],
      minimumRows: 0,
      maximumRows: 20,
    }),
    (item) => (item.settings.maximumRows = 10),
    "major",
  ],
  [
    "link behaviour changes",
    policyField("link", {
      target: resolvedRecordType(),
      reverseKey: "records",
      onParentDelete: "refuse",
    }),
    (item) => (item.settings.onParentDelete = "empty_optional"),
    "major",
  ],
  [
    "multi-link target added",
    policyField("link_to_one_of_several", {
      targets: [resolvedRecordType()],
      onParentDelete: "refuse",
    }),
    (item) => (item.settings.targets as unknown[]).push(resolvedRecordType(id(8), id(9))),
    "minor",
  ],
  [
    "multi-link target removed",
    policyField("link_to_one_of_several", {
      targets: [resolvedRecordType(), resolvedRecordType(id(8), id(9))],
      onParentDelete: "refuse",
    }),
    (item) => (item.settings.targets as unknown[]).pop(),
    "major",
  ],
  [
    "person-link settings change",
    policyField("link_to_person", {
      audience: "organization_accounts",
      applicationRootIdRequired: false,
      onPersonDeactivation: "retain_reference",
    }),
    (item) => (item.settings.applicationRootIdRequired = true),
    "major",
  ],
  [
    "calculation changes",
    policyField("calculation", {
      resultType: "text",
      expression: { kind: "join_text", fieldIds: [id(10)], separator: " " },
      dependencyFieldIds: [id(10)],
    }),
    (item) =>
      (item.settings.expression = { kind: "join_text", fieldIds: [id(10)], separator: "," }),
    "major",
  ],
  [
    "total changes",
    policyField("total", {
      relationshipId: id(12),
      operation: "count",
      resultType: "whole_number",
    }),
    (item) => (item.settings.operation = "maximum"),
    "major",
  ],
  [
    "attachment kind added",
    policyField("attachment", {
      allowedKinds: ["document"],
      maxFileSizeMb: 25,
      multiple: true,
      maxFiles: 5,
    }),
    (item) => (item.settings.allowedKinds as string[]).push("image"),
    "minor",
  ],
  [
    "attachment kind removed",
    policyField("attachment", {
      allowedKinds: ["document", "image"],
      maxFileSizeMb: 25,
      multiple: true,
      maxFiles: 5,
    }),
    (item) => (item.settings.allowedKinds as string[]).pop(),
    "major",
  ],
  [
    "attachment size widens",
    policyField("attachment", {
      allowedKinds: ["document"],
      maxFileSizeMb: 25,
      multiple: true,
      maxFiles: 5,
    }),
    (item) => (item.settings.maxFileSizeMb = 50),
    "minor",
  ],
  [
    "attachment size narrows",
    policyField("attachment", {
      allowedKinds: ["document"],
      maxFileSizeMb: 25,
      multiple: true,
      maxFiles: 5,
    }),
    (item) => (item.settings.maxFileSizeMb = 10),
    "major",
  ],
  [
    "attachment count widens",
    policyField("attachment", {
      allowedKinds: ["document"],
      maxFileSizeMb: 25,
      multiple: true,
      maxFiles: 5,
    }),
    (item) => (item.settings.maxFiles = 10),
    "minor",
  ],
  [
    "attachment count narrows",
    policyField("attachment", {
      allowedKinds: ["document"],
      maxFileSizeMb: 25,
      multiple: true,
      maxFiles: 5,
    }),
    (item) => (item.settings.maxFiles = 3),
    "major",
  ],
];

describe("definition version impact", () => {
  test("assigns the first version and refuses malformed input", () => {
    const draft = moduleDraft();
    const result = compareDefinitionVersionImpact({
      kind: "module",
      history: [],
      candidate: draft,
    });
    expect(result).toMatchObject({
      outcome: "initial_release",
      subject: { definitionKind: "module", rootId: id(1) },
      assignedVersion: "1.0.0",
      reasons: [],
    });
    expectCode(
      () => compareDefinitionVersionImpact({ kind: "module", history: [], candidate: {} }),
      "invalid_request",
    );
  });

  test("returns no change for identical content and irrelevant collection order", () => {
    const draft = moduleDraft();
    draft.content.recordTypes[0]!.fields.push(field(id(11)));
    const request = requestAfter(draft);
    request.candidate.content.recordTypes[0]!.fields.reverse();
    const result = compareDefinitionVersionImpact(request);
    expect(result).toMatchObject({ outcome: "no_change", currentVersion: "1.0.0", reasons: [] });

    const unchanged = requestAfter(draft);
    const unchangedResult = compareDefinitionVersionImpact(unchanged);
    expect(unchangedResult.outcome).toBe("no_change");
    expect(result.comparisonFingerprint).not.toBe(unchangedResult.comparisonFingerprint);
  });

  test("uses locale-independent canonical JSON and rejects undefined properties", () => {
    expect(canonicalJson({ z: 1, A: 2, a: 3 })).toBe('{"A":2,"a":3,"z":1}');
    expect(() => canonicalJson({ present: true, missing: undefined })).toThrow(TypeError);
  });

  test("uses contract-compatible code-unit ordering when punctuation differs", () => {
    expect(["a_a.a", "a.a"].sort(compareCanonicalStrings)).toEqual(["a.a", "a_a.a"]);
  });

  test.each([
    [
      "patch",
      "1.0.1",
      (request: ReturnType<typeof requestAfter>) => {
        request.candidate.content.name = "Updated module name";
      },
    ],
    [
      "minor",
      "1.1.0",
      (request: ReturnType<typeof requestAfter>) => {
        request.candidate.content.recordTypes[0]!.fields.push(field(id(11)));
      },
    ],
    [
      "major",
      "2.0.0",
      (request: ReturnType<typeof requestAfter>) => {
        request.candidate.content.recordTypes[0]!.fields.push(field(id(11), true));
      },
    ],
  ] as const)("classifies a %s module change", (impact, version, change) => {
    const request = requestAfter(moduleDraft());
    change(request);
    expect(compareDefinitionVersionImpact(request)).toMatchObject({
      outcome: "release_required",
      impact,
      assignedVersion: version,
    });
  });

  test("keeps the governed field matrix aligned with the closed catalogue", () => {
    expect(fieldCases.map(([type]) => type)).toEqual(fieldTypeKeys);
  });

  test.each(fieldCases)(
    "classifies the governed %s field change",
    (type, settings, mutate, impact) => {
      const draft = moduleDraft();
      draft.content.recordTypes[0]!.fields.push({
        ...field(id(11)),
        type,
        settings: structuredClone(settings),
      });
      const request = requestAfter(draft);
      const candidateField = request.candidate.content.recordTypes[0]!.fields[1]!;
      mutate(candidateField.settings as Record<string, unknown>, candidateField);
      expect(compareDefinitionVersionImpact(request)).toMatchObject({
        outcome: "release_required",
        impact,
      });
    },
  );

  test.each(fieldPolicyDirectionCases)(
    "classifies field policy direction: %s",
    (_name, original, mutate, impact) => {
      const draft = moduleDraft();
      draft.content.recordTypes[0]!.fields.push(
        structuredClone(
          original,
        ) as unknown as (typeof draft.content.recordTypes)[number]["fields"][number],
      );
      const request = requestAfter(draft);
      mutate(request.candidate.content.recordTypes[0]!.fields[1] as unknown as PolicyField);
      expect(compareDefinitionVersionImpact(request)).toMatchObject({
        outcome: "release_required",
        impact,
      });
    },
  );

  test("classifies application presentation, additive and behavioural changes", () => {
    const patchRequest = applicationRequestAfter(applicationDraft());
    patchRequest.candidate.content.icon = "updated";
    expect(compareDefinitionVersionImpact(patchRequest)).toMatchObject({ impact: "patch" });

    const minorRequest = applicationRequestAfter(applicationDraft());
    minorRequest.candidate.content.permissions.push({
      permissionId: id(26),
      key: "sample.record.read",
      label: "Read records",
      description: "Allows records to be read.",
      actionKind: "read",
      administrative: false,
    });
    expect(compareDefinitionVersionImpact(minorRequest)).toMatchObject({ impact: "minor" });

    const majorRequest = applicationRequestAfter(applicationDraft());
    majorRequest.candidate.content.pages[0]!.accessPermissionKey = "sample.private.open";
    expect(compareDefinitionVersionImpact(majorRequest)).toMatchObject({ impact: "major" });
  });

  test("classifies permission presentation, addition and authority changes", () => {
    const patchRequest = requestAfter(moduleDraft());
    patchRequest.candidate.content.permissions[0]!.label = "Updated label";
    expect(compareDefinitionVersionImpact(patchRequest)).toMatchObject({ impact: "patch" });

    const minorRequest = requestAfter(moduleDraft());
    minorRequest.candidate.content.permissions.push({
      permissionId: id(7),
      key: "sample.record.export",
      label: "Export records",
      description: "Allows records to be exported.",
      recordTypeId: id(4),
      actionKind: "export",
      administrative: false,
    });
    expect(compareDefinitionVersionImpact(minorRequest)).toMatchObject({ impact: "minor" });

    const majorRequest = requestAfter(moduleDraft());
    majorRequest.candidate.content.permissions[0]!.administrative = true;
    expect(compareDefinitionVersionImpact(majorRequest)).toMatchObject({ impact: "major" });

    const duplicateRequest = requestAfter(moduleDraft());
    duplicateRequest.candidate.content.permissions.push({
      ...duplicateRequest.candidate.content.permissions[0]!,
      permissionId: id(7),
    });
    expectCode(
      () => compareDefinitionVersionImpact(duplicateRequest),
      "ambiguous_component_identity",
    );
  });

  test("treats title-field changes as major and presentation collection reorders as patch", () => {
    const titleDraft = moduleDraft();
    titleDraft.content.recordTypes[0]!.fields.push(field(id(11)));
    const titleRequest = requestAfter(titleDraft);
    titleRequest.candidate.content.recordTypes[0]!.titleFieldId = id(11);
    expect(compareDefinitionVersionImpact(titleRequest)).toMatchObject({ impact: "major" });

    const tableDraft = moduleDraft();
    tableDraft.content.recordTypes[0]!.fields.push({
      ...field(id(11)),
      type: "table",
      settings: {
        columns: [
          { key: "first", type: "text", required: false },
          { key: "second", type: "yes_no", required: false },
        ],
        minimumRows: 0,
        maximumRows: 20,
      },
    });
    const tableRequest = requestAfter(tableDraft);
    tableRequest.candidate.content.recordTypes[0]!.fields[1]!.settings.columns.reverse();
    expect(compareDefinitionVersionImpact(tableRequest)).toMatchObject({ impact: "patch" });
  });

  test.each([
    [
      "formatted blocks",
      {
        ...field(id(11)),
        type: "formatted_text",
        settings: { allowedBlocks: ["paragraph", "heading"], maxLength: 500 },
      },
      (candidateField: Record<string, unknown>) =>
        (candidateField.settings as { allowedBlocks: string[] }).allowedBlocks.reverse(),
    ],
    [
      "choice options",
      {
        ...field(id(11)),
        type: "choice",
        settings: {
          options: [
            { value: "first", label: "First" },
            { value: "second", label: "Second" },
          ],
        },
      },
      (candidateField: Record<string, unknown>) =>
        (candidateField.settings as { options: unknown[] }).options.reverse(),
    ],
    [
      "several-choice options",
      {
        ...field(id(11)),
        type: "several_choices",
        settings: {
          options: [
            { value: "first", label: "First" },
            { value: "second", label: "Second" },
          ],
          maximumSelections: 2,
        },
      },
      (candidateField: Record<string, unknown>) =>
        (candidateField.settings as { options: unknown[] }).options.reverse(),
    ],
    [
      "link targets",
      {
        ...field(id(11)),
        type: "link_to_one_of_several",
        settings: {
          targets: [
            { state: "resolved", moduleRootId: id(1), recordTypeId: id(4) },
            { state: "resolved", moduleRootId: id(8), recordTypeId: id(9) },
          ],
          onParentDelete: "refuse",
        },
      },
      (candidateField: Record<string, unknown>) =>
        (candidateField.settings as { targets: unknown[] }).targets.reverse(),
    ],
    [
      "attachment kinds",
      {
        ...field(id(11)),
        type: "attachment",
        settings: {
          allowedKinds: ["document", "image"],
          allowedExtensions: [".pdf", ".png"],
          maxFileSizeMb: 25,
          multiple: true,
          maxFiles: 5,
        },
      },
      (candidateField: Record<string, unknown>) => {
        const settings = candidateField.settings as {
          allowedKinds: unknown[];
          allowedExtensions: unknown[];
        };
        settings.allowedKinds.reverse();
        settings.allowedExtensions.reverse();
      },
    ],
  ] as const)("classifies %s display order as patch", (_name, orderedField, reorder) => {
    const draft = moduleDraft();
    draft.content.recordTypes[0]!.fields.push(orderedField);
    const request = requestAfter(draft);
    reorder(request.candidate.content.recordTypes[0]!.fields[1]!);
    expect(compareDefinitionVersionImpact(request)).toMatchObject({ impact: "patch" });
  });

  test("classifies navigation order as patch and navigation hierarchy as major", () => {
    const orderedDraft = applicationDraft();
    orderedDraft.content.navigation = [
      {
        id: id(30),
        type: "page",
        label: "First",
        pageId: id(21),
        permissionKey: "sample.public.open",
      },
      {
        id: id(31),
        type: "page",
        label: "Second",
        pageId: id(21),
        permissionKey: "sample.public.open",
      },
    ];
    const orderRequest = applicationRequestAfter(orderedDraft);
    orderRequest.candidate.content.navigation.reverse();
    expect(compareDefinitionVersionImpact(orderRequest)).toMatchObject({ impact: "patch" });

    const hierarchyDraft = applicationDraft();
    hierarchyDraft.content.navigation = [
      {
        id: id(32),
        type: "heading",
        label: "Group",
        children: [
          {
            id: id(33),
            type: "page",
            label: "Nested",
            pageId: id(21),
            permissionKey: "sample.public.open",
          },
          {
            id: id(34),
            type: "page",
            label: "Retained",
            pageId: id(21),
            permissionKey: "sample.public.open",
          },
        ],
      },
    ];
    const hierarchyRequest = applicationRequestAfter(hierarchyDraft);
    const heading = hierarchyRequest.candidate.content.navigation[0]!;
    const moved = heading.children.shift()!;
    hierarchyRequest.candidate.content.navigation.push(moved);
    expect(compareDefinitionVersionImpact(hierarchyRequest)).toMatchObject({ impact: "major" });
  });

  test("classifies guided-step reorder as patch and hidden phone content as major", () => {
    const guidedDraft = applicationDraft();
    const block = (placementId: string) => ({
      placementId,
      blockId: id(23),
      blockReleaseVersion: "1.0.0",
      settings: {},
      desktop: { startColumn: 1, span: 12, height: 1 },
      phone: { order: 0, behaviour: "full_width" },
      viewPermissionKey: "sample.public.open",
    });
    guidedDraft.content.pages = [
      {
        pageId: id(21),
        key: "guided",
        name: "Guided",
        type: "guided_form",
        accessPermissionKey: "sample.public.open",
        states: ["normal"],
        layout: {
          desktop: { columns: 12, componentOrder: [id(35), id(36)] },
          phone: { componentOrder: [id(35), id(36)] },
        },
        recordType: { state: "resolved", moduleRootId: id(1), recordTypeId: id(4) },
        commitActionKey: "sample.record.save",
        steps: [
          { id: id(37), name: "Details", summary: false, blocks: [block(id(35))] },
          { id: id(38), name: "Summary", summary: true, blocks: [block(id(36))] },
        ],
      },
    ];
    const orderRequest = applicationRequestAfter(guidedDraft);
    orderRequest.candidate.content.pages[0]!.steps.reverse();
    expect(compareDefinitionVersionImpact(orderRequest)).toMatchObject({ impact: "patch" });

    const hiddenRequest = applicationRequestAfter(applicationDraft());
    hiddenRequest.candidate.content.pages[0]!.blocks[0]!.phone.behaviour = "hide";
    expect(compareDefinitionVersionImpact(hiddenRequest)).toMatchObject({ impact: "major" });
  });

  test("recognises date and pattern constraint widening for action inputs", () => {
    const actionDraft = moduleDraft();
    actionDraft.content.actions = [
      {
        actionId: id(40),
        key: "sample.record.update",
        label: "Update record",
        subjectRecordTypeId: id(4),
        permissionKey: "sample.record.read",
        sharing: "refused",
        inputs: [
          {
            key: "date_value",
            label: "Date",
            required: false,
            type: "date",
            validation: { earliest: "2026-01-01" },
          },
          {
            key: "text_value",
            label: "Text",
            required: false,
            type: "text",
            validation: { pattern: "^[a-z]+$" },
          },
        ],
        effects: [
          {
            kind: "set_field",
            fieldId: id(10),
            value: { source: "input", inputKey: "text_value" },
          },
        ],
      },
    ];
    const dateRequest = requestAfter(actionDraft);
    dateRequest.candidate.content.actions[0]!.inputs[0]!.validation!.earliest = "2025-01-01";
    expect(compareDefinitionVersionImpact(dateRequest)).toMatchObject({ impact: "minor" });

    const patternRequest = requestAfter(actionDraft);
    delete patternRequest.candidate.content.actions[0]!.inputs[1]!.validation!.pattern;
    expect(compareDefinitionVersionImpact(patternRequest)).toMatchObject({ impact: "minor" });

    const formattedDraft = moduleDraft();
    formattedDraft.content.actions = [
      {
        ...actionDraft.content.actions[0]!,
        inputs: [
          {
            key: "formatted_value",
            label: "Formatted value",
            required: false,
            type: "formatted_text",
            validation: { allowedBlocks: ["paragraph", "heading"], maximumLength: 500 },
          },
        ],
        effects: [
          {
            kind: "set_field",
            fieldId: id(10),
            value: { source: "input", inputKey: "formatted_value" },
          },
        ],
      },
    ];
    const formattedRequest = requestAfter(formattedDraft);
    formattedRequest.candidate.content.actions[0]!.inputs[0]!.validation!.allowedBlocks.reverse();
    expect(compareDefinitionVersionImpact(formattedRequest)).toMatchObject({ impact: "patch" });
  });

  test("keeps the workflow-node matrix aligned with the closed catalogue", () => {
    expect(workflowCases.map(([type]) => type)).toEqual(workflowNodeTypeKeys);
  });

  test.each(workflowCases)(
    "classifies an existing %s workflow node configuration change as major",
    (type, beforeConfig, afterConfig, changeTimeout = false) => {
      const draft = applicationDraft();
      draft.content.workflows = [
        {
          workflowId: id(130),
          key: "sample_workflow",
          name: "Sample workflow",
          trigger: {
            kind: "schedule",
            schedule: dailySchedule(),
            inputs: [],
            condition: null,
            duplicateProtection: "required",
          },
          runAs: "system_with_source_authority",
          nodes: [
            {
              nodeId: id(131),
              type,
              config: structuredClone(beforeConfig),
              timeoutSeconds: 60,
              retry: {
                maximumAttempts: 1,
                initialDelaySeconds: 0,
                maximumDelaySeconds: 0,
                backoff: "fixed",
              },
              duplicateProtection: "not_applicable",
              activityKey: "node_activity",
              redaction: "identifiers_only",
            },
          ],
          edges: [],
          maximumNestingDepth: 1,
        },
      ];
      const request = applicationRequestAfter(draft);
      const candidateNode = request.candidate.content.workflows[0]!.nodes[0]!;
      if (changeTimeout) candidateNode.timeoutSeconds = 61;
      else candidateNode.config = structuredClone(afterConfig);
      expect(compareDefinitionVersionImpact(request)).toMatchObject({
        outcome: "release_required",
        impact: "major",
      });
    },
  );

  test("ignores workflow node and edge declaration order", () => {
    const draft = applicationDraft();
    const common = {
      timeoutSeconds: 60,
      retry: {
        maximumAttempts: 1,
        initialDelaySeconds: 0,
        maximumDelaySeconds: 0,
        backoff: "fixed",
      },
      duplicateProtection: "not_applicable",
      activityKey: "node_activity",
      redaction: "identifiers_only",
    };
    draft.content.workflows = [
      {
        workflowId: id(130),
        key: "sample_workflow",
        name: "Sample workflow",
        trigger: {
          kind: "schedule",
          schedule: dailySchedule(),
          inputs: [],
          condition: null,
          duplicateProtection: "required",
        },
        runAs: "system_with_source_authority",
        nodes: [
          { ...common, nodeId: id(131), type: "start", config: {} },
          { ...common, nodeId: id(132), type: "delay", config: { seconds: 60 } },
          { ...common, nodeId: id(133), type: "stop", config: { reasonCode: "complete" } },
        ],
        edges: [
          { fromNodeId: id(131), toNodeId: id(132) },
          { fromNodeId: id(132), toNodeId: id(133) },
        ],
        maximumNestingDepth: 1,
      },
    ];
    const request = applicationRequestAfter(draft);
    request.candidate.content.workflows[0]!.nodes.reverse();
    request.candidate.content.workflows[0]!.edges.reverse();
    expect(compareDefinitionVersionImpact(request)).toMatchObject({
      outcome: "no_change",
      reasons: [],
    });
  });

  test("uses one governed reason order across contracts and runtime", () => {
    const request = requestAfter(moduleDraft());
    request.candidate.content.permissions.push({
      permissionId: id(41),
      key: "sample.record.change",
      label: "Change records",
      description: "Allows records to be changed.",
      recordTypeId: id(4),
      actionKind: "update",
      administrative: false,
    });
    request.candidate.content.actions.push(sampleAction());

    const result = compareDefinitionVersionImpact(request);
    expect(result).toMatchObject({ outcome: "release_required", impact: "minor" });
    expect(result.reasons.map((reason) => reason.location.componentKind)).toEqual([
      "action",
      "permission",
    ]);
  });

  test("does not leak irrelevant order into a mixed semantic change", () => {
    const draft = applicationDraft();
    draft.content.permissions.push({
      permissionId: id(26),
      key: "sample.record.read",
      label: "Read records",
      description: "Allows records to be read.",
      actionKind: "read",
      administrative: false,
    });
    draft.content.roles[0]!.permissionKeys.push("sample.record.read");
    const request = applicationRequestAfter(draft);
    request.candidate.content.name = "Updated application name";
    request.candidate.content.roles[0]!.permissionKeys.reverse();

    const result = compareDefinitionVersionImpact(request);
    expect(result).toMatchObject({ outcome: "release_required", impact: "patch" });
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]!.location.componentKind).toBe("application");
  });

  test("keeps action input display order as a patch change", () => {
    const draft = moduleDraft();
    draft.content.actions.push(sampleAction());
    const request = requestAfter(draft);
    request.candidate.content.actions[0]!.inputs.reverse();

    expect(compareDefinitionVersionImpact(request)).toMatchObject({
      outcome: "release_required",
      impact: "patch",
    });
  });

  test.each(["text", "number", "date", "date_time"] as const)(
    "treats omitted and empty %s action-input validation as equivalent",
    (type) => {
      const draft = moduleDraft();
      const action = sampleAction();
      action.inputs = [{ key: "value", label: "Value", required: false, type }];
      action.effects = [
        {
          kind: "set_field",
          fieldId: id(10),
          value: { source: "literal", value: "unchanged" },
        },
      ];
      draft.content.actions.push(action);
      const request = requestAfter(draft);
      request.candidate.content.actions[0]!.inputs[0]!.validation = {};

      expect(compareDefinitionVersionImpact(request)).toMatchObject({
        outcome: "no_change",
        reasons: [],
      });
    },
  );

  test("treats omitted and explicit HTTPS web-address schemes as equivalent", () => {
    const draft = moduleDraft();
    draft.content.recordTypes[0]!.fields.push({
      ...field(id(11)),
      type: "web_address",
      settings: {},
    });
    const request = requestAfter(draft);
    request.candidate.content.recordTypes[0]!.fields[1]!.settings = {
      allowedSchemes: ["https"],
    };

    expect(compareDefinitionVersionImpact(request)).toMatchObject({
      outcome: "no_change",
      reasons: [],
    });
  });

  test("classifies pipeline stage additions as major and display order as patch", () => {
    const draft = applicationDraft();
    const pipeline = samplePipeline();
    pipeline.stages.push({
      key: "closed",
      label: "Closed",
      entryActionKeys: [],
      exitActionKeys: [],
      entryWorkflowIds: [],
      exitWorkflowIds: [],
    });
    pipeline.transitions.push({ from: "open", to: "closed" });
    draft.content.pipelines.push(pipeline);

    const orderRequest = applicationRequestAfter(draft);
    orderRequest.candidate.content.pipelines[0]!.stages.reverse();
    expect(compareDefinitionVersionImpact(orderRequest)).toMatchObject({ impact: "patch" });

    const additionRequest = applicationRequestAfter(applicationDraft());
    additionRequest.candidate.content.pipelines.push(samplePipeline());
    expect(compareDefinitionVersionImpact(additionRequest)).toMatchObject({ impact: "major" });

    const stageRequest = applicationRequestAfter(draft);
    stageRequest.candidate.content.pipelines[0]!.stages.push({
      key: "archived",
      label: "Archived",
      entryActionKeys: [],
      exitActionKeys: [],
      entryWorkflowIds: [],
      exitWorkflowIds: [],
    });
    expect(compareDefinitionVersionImpact(stageRequest)).toMatchObject({ impact: "major" });
  });

  test("implements exposure-aware and directional interface compatibility", () => {
    const privateAddition = applicationRequestAfter(applicationDraft());
    privateAddition.candidate.content.interfaces.push(sampleInterface());
    expect(compareDefinitionVersionImpact(privateAddition)).toMatchObject({ impact: "minor" });

    const publicAddition = applicationRequestAfter(applicationDraft());
    publicAddition.candidate.content.interfaces.push(sampleInterface("public"));
    expect(compareDefinitionVersionImpact(publicAddition)).toMatchObject({ impact: "major" });

    const base = applicationDraft();
    base.content.interfaces.push(sampleInterface());

    const deprecated = applicationRequestAfter(base);
    deprecated.candidate.content.interfaces[0]!.state = "deprecated";
    expect(compareDefinitionVersionImpact(deprecated)).toMatchObject({ impact: "patch" });

    const widenedOutput = applicationRequestAfter(base);
    widenedOutput.candidate.content.interfaces[0]!.operations[0]!.outputShape.count = {
      type: "number",
      required: true,
      targetBinding: { kind: "query_page_information", value: "result_count" },
    };
    expect(compareDefinitionVersionImpact(widenedOutput)).toMatchObject({ impact: "minor" });

    const widenedErrors = applicationRequestAfter(base);
    widenedErrors.candidate.content.interfaces[0]!.operations[0]!.errorCodes.push(
      "temporarily_unavailable",
    );
    expect(compareDefinitionVersionImpact(widenedErrors)).toMatchObject({ impact: "minor" });

    const widenedLimits = applicationRequestAfter(base);
    widenedLimits.candidate.content.interfaces[0]!.operations[0]!.rateLimitPerMinute = 120;
    expect(compareDefinitionVersionImpact(widenedLimits)).toMatchObject({ impact: "minor" });

    const narrowedOutput = applicationRequestAfter(base);
    delete narrowedOutput.candidate.content.interfaces[0]!.operations[0]!.outputShape.result;
    expect(compareDefinitionVersionImpact(narrowedOutput)).toMatchObject({ impact: "major" });

    const actionBase = applicationDraft();
    actionBase.content.interfaces.push(sampleInterface());
    actionBase.content.interfaces[0]!.operations[0]!.target = {
      kind: "action",
      key: "sample.record.update",
    };
    actionBase.content.interfaces[0]!.operations[0]!.outputShape = {};

    const optionalInput = applicationRequestAfter(actionBase);
    optionalInput.candidate.content.interfaces[0]!.operations[0]!.inputShape.value = {
      type: "text",
      required: false,
      targetBinding: { kind: "action_input", key: "first" },
    };
    expect(compareDefinitionVersionImpact(optionalInput)).toMatchObject({ impact: "minor" });

    const requiredInput = applicationRequestAfter(actionBase);
    requiredInput.candidate.content.interfaces[0]!.operations[0]!.inputShape.value = {
      type: "text",
      required: true,
      targetBinding: { kind: "action_input", key: "first" },
    };
    expect(compareDefinitionVersionImpact(requiredInput)).toMatchObject({ impact: "major" });

    const changedOutputBinding = applicationRequestAfter(base);
    changedOutputBinding.candidate.content.interfaces[0]!.operations[0]!.outputShape.result = {
      type: "text",
      required: true,
      targetBinding: { kind: "query_page_information", value: "continuation_token" },
    };
    expect(compareDefinitionVersionImpact(changedOutputBinding)).toMatchObject({ impact: "major" });

    const changedMethod = applicationRequestAfter(base);
    changedMethod.candidate.content.interfaces[0]!.operations[0]!.method = "POST";
    expect(compareDefinitionVersionImpact(changedMethod)).toMatchObject({ impact: "major" });

    const changedPath = applicationRequestAfter(base);
    changedPath.candidate.content.interfaces[0]!.operations[0]!.path = "/renamed";
    expect(compareDefinitionVersionImpact(changedPath)).toMatchObject({ impact: "major" });
  });

  test.each(["choice", "table", "workflow_edge"] as const)(
    "refuses duplicate nested %s comparison identities",
    (kind) => {
      if (kind === "workflow_edge") {
        const draft = applicationDraft();
        draft.content.workflows = [
          {
            workflowId: id(130),
            key: "sample_workflow",
            name: "Sample workflow",
            trigger: {
              kind: "schedule",
              schedule: dailySchedule(),
              inputs: [],
              condition: null,
              duplicateProtection: "required",
            },
            runAs: "system_with_source_authority",
            nodes: [
              {
                nodeId: id(131),
                type: "start",
                config: {},
                timeoutSeconds: 60,
                retry: {
                  maximumAttempts: 1,
                  initialDelaySeconds: 0,
                  maximumDelaySeconds: 0,
                  backoff: "fixed",
                },
                duplicateProtection: "not_applicable",
                activityKey: "node_activity",
                redaction: "identifiers_only",
              },
              {
                nodeId: id(132),
                type: "stop",
                config: { reasonCode: "complete" },
                timeoutSeconds: 60,
                retry: {
                  maximumAttempts: 1,
                  initialDelaySeconds: 0,
                  maximumDelaySeconds: 0,
                  backoff: "fixed",
                },
                duplicateProtection: "not_applicable",
                activityKey: "stop_activity",
                redaction: "identifiers_only",
              },
            ],
            edges: [
              { fromNodeId: id(131), toNodeId: id(132) },
              { fromNodeId: id(131), toNodeId: id(132) },
            ],
            maximumNestingDepth: 1,
          },
        ];
        expectCode(
          () => compareDefinitionVersionImpact(applicationRequestAfter(draft)),
          "ambiguous_component_identity",
        );
        return;
      }

      const draft = moduleDraft();
      draft.content.recordTypes[0]!.fields.push(
        kind === "choice"
          ? {
              ...field(id(11)),
              type: "choice",
              settings: {
                options: [
                  { value: "duplicate", label: "First" },
                  { value: "duplicate", label: "Second" },
                ],
              },
            }
          : {
              ...field(id(11)),
              type: "table",
              settings: {
                columns: [
                  { key: "duplicate", type: "text", required: false },
                  { key: "duplicate", type: "yes_no", required: false },
                ],
                minimumRows: 0,
                maximumRows: 20,
              },
            },
      );
      expectCode(
        () => compareDefinitionVersionImpact(requestAfter(draft)),
        "ambiguous_component_identity",
      );
    },
  );

  test("covers the remaining top-level module and application policy components", () => {
    const moduleCases: Array<{
      impact: "minor" | "major";
      add: (draft: ModuleDraft) => void;
    }> = [
      {
        impact: "major",
        add: (draft) =>
          draft.content.dependencies.push({
            dependencyKey: "dependency",
            moduleRootId: id(80),
            moduleKey: "sample.dependency",
            version: { selection: "exact", version: "1.0.0" },
            resolvedVersion: "1.0.0",
          }),
      },
      {
        impact: "minor",
        add: (draft) =>
          draft.content.recordTypes[0]!.relationships.push({
            relationshipId: id(81),
            key: "parent",
            fromRecordTypeId: id(4),
            fromFieldId: id(10),
            toRecordType: resolvedRecordType(),
            cardinality: "many_to_one",
            onParentDelete: "refuse",
          }),
      },
      {
        impact: "major",
        add: (draft) =>
          draft.content.rules.push({
            ruleId: id(82),
            key: "require_title",
            subjectRecordTypeId: id(4),
            trigger: "create",
            condition: condition(true),
            priority: 1,
            effect: { kind: "require", fieldId: id(10) },
          }),
      },
      {
        impact: "minor",
        add: (draft) =>
          draft.content.sharingConditions.push({
            conditionId: id(83),
            sourceRecordTypeId: id(4),
            key: "shareable",
            publishedRevision: 1,
            contractFingerprint: `sha256:${"0".repeat(64)}`,
            parameters: [],
            condition: condition(true),
            declaredFieldIds: [],
            publicationTests: [{ name: "Allows", parameters: {}, fieldValues: {}, expected: true }],
          }),
      },
      {
        impact: "minor",
        add: (draft) =>
          draft.content.extensionPoints.push({
            extensionPointId: id(84),
            key: "record_extension",
            recordTypeId: id(4),
            accepts: ["field"],
          }),
      },
    ];
    for (const { impact, add } of moduleCases) {
      const request = requestAfter(moduleDraft());
      add(request.candidate);
      expect(compareDefinitionVersionImpact(request)).toMatchObject({ impact });
    }

    const applicationCases: Array<{
      impact: "minor" | "major";
      add: (draft: ApplicationDraft) => void;
    }> = [
      {
        impact: "major",
        add: (draft) =>
          draft.content.moduleBindings.push({
            moduleRootId: id(85),
            version: { selection: "exact", version: "1.0.0" },
            resolvedVersion: "1.0.0",
            purpose: "secondary",
          }),
      },
      {
        impact: "minor",
        add: (draft) =>
          draft.content.roles.push({
            roleId: id(86),
            key: "viewer",
            name: "Viewer",
            homePageId: id(21),
            permissionKeys: ["sample.public.open"],
            permissionSelection: { kind: "exact" },
          }),
      },
      { impact: "minor", add: (draft) => draft.content.queries.push(sampleQuery()) },
      {
        impact: "minor",
        add: (draft) => draft.content.blockRegistrations.push(sampleBlockRegistration()),
      },
      { impact: "major", add: (draft) => draft.content.pipelines.push(samplePipeline()) },
      { impact: "minor", add: (draft) => draft.content.interfaces.push(sampleInterface()) },
      {
        impact: "major",
        add: (draft) =>
          draft.content.publicAddresses.push({
            addressId: id(87),
            pageId: id(21),
            path: "/sample",
            state: "active",
            rateLimitPerMinute: 60,
          }),
      },
      {
        impact: "major",
        add: (draft) =>
          draft.content.connectionBindings.push({
            bindingId: id(88),
            key: "sample_connection",
            connectionTypeId: id(89),
            version: { selection: "exact", version: "1.0.0" },
            resolvedVersion: "1.0.0",
            requiredOperationKeys: ["read"],
          }),
      },
    ];
    for (const { impact, add } of applicationCases) {
      const request = applicationRequestAfter(applicationDraft());
      add(request.candidate);
      expect(compareDefinitionVersionImpact(request)).toMatchObject({ impact });
    }
  });

  test("ignores derived saved-condition revision and fingerprint metadata", () => {
    const draft = moduleDraft();
    draft.content.sharingConditions.push({
      conditionId: id(83),
      sourceRecordTypeId: id(4),
      key: "shareable",
      publishedRevision: 1,
      contractFingerprint: `sha256:${"0".repeat(64)}`,
      parameters: [],
      condition: condition(true),
      declaredFieldIds: [],
      publicationTests: [{ name: "Allows", parameters: {}, fieldValues: {}, expected: true }],
    });
    const request = requestAfter(draft);
    request.candidate.content.sharingConditions[0]!.publishedRevision = 2;
    request.candidate.content.sharingConditions[0]!.contractFingerprint = `sha256:${"1".repeat(64)}`;
    expect(compareDefinitionVersionImpact(request)).toMatchObject({ outcome: "no_change" });
  });

  test("proves directional component addition and removal invariants", () => {
    const moduleDirections: Array<{
      add: (draft: ModuleDraft) => void;
      remove: (draft: ModuleDraft) => void;
    }> = [
      {
        add: (draft) => draft.content.recordTypes[0]!.fields.push(field(id(91))),
        remove: (draft) => void draft.content.recordTypes[0]!.fields.pop(),
      },
      {
        add: (draft) =>
          draft.content.permissions.push({
            permissionId: id(92),
            key: "sample.record.export",
            label: "Export records",
            description: "Allows records to be exported.",
            recordTypeId: id(4),
            actionKind: "export",
            administrative: false,
          }),
        remove: (draft) => void draft.content.permissions.pop(),
      },
      {
        add: (draft) => draft.content.actions.push(sampleAction()),
        remove: (draft) => void draft.content.actions.pop(),
      },
      {
        add: (draft) =>
          draft.content.events.push({
            eventId: id(93),
            key: "sample.record.changed",
            recordTypeId: id(4),
            carriedFieldIds: [id(10)],
            personalOrSensitiveValuesAllowed: false,
          }),
        remove: (draft) => void draft.content.events.pop(),
      },
      {
        add: (draft) =>
          draft.content.extensionPoints.push({
            extensionPointId: id(94),
            key: "record_extension",
            recordTypeId: id(4),
            accepts: ["field"],
          }),
        remove: (draft) => void draft.content.extensionPoints.pop(),
      },
    ];
    for (const direction of moduleDirections) {
      const addition = requestAfter(moduleDraft());
      direction.add(addition.candidate);
      expect(compareDefinitionVersionImpact(addition)).toMatchObject({ impact: "minor" });

      const removalBase = moduleDraft();
      direction.add(removalBase);
      const removal = requestAfter(removalBase);
      direction.remove(removal.candidate);
      expect(compareDefinitionVersionImpact(removal)).toMatchObject({ impact: "major" });
    }

    const applicationDirections: Array<{
      add: (draft: ApplicationDraft) => void;
      remove: (draft: ApplicationDraft) => void;
    }> = [
      {
        add: (draft) =>
          draft.content.roles.push({
            roleId: id(95),
            key: "viewer",
            name: "Viewer",
            homePageId: id(21),
            permissionKeys: ["sample.public.open"],
            permissionSelection: { kind: "exact" },
          }),
        remove: (draft) => void draft.content.roles.pop(),
      },
      {
        add: (draft) => draft.content.queries.push(sampleQuery()),
        remove: (draft) => void draft.content.queries.pop(),
      },
      {
        add: (draft) => draft.content.blockRegistrations.push(sampleBlockRegistration()),
        remove: (draft) => void draft.content.blockRegistrations.pop(),
      },
      {
        add: (draft) => draft.content.interfaces.push(sampleInterface()),
        remove: (draft) => void draft.content.interfaces.pop(),
      },
    ];
    for (const direction of applicationDirections) {
      const addition = applicationRequestAfter(applicationDraft());
      direction.add(addition.candidate);
      expect(compareDefinitionVersionImpact(addition)).toMatchObject({ impact: "minor" });

      const removalBase = applicationDraft();
      direction.add(removalBase);
      const removal = applicationRequestAfter(removalBase);
      direction.remove(removal.candidate);
      expect(compareDefinitionVersionImpact(removal)).toMatchObject({ impact: "major" });
    }
  });

  test("returns all reasons once, in deterministic severity order", () => {
    const request = requestAfter(moduleDraft());
    request.candidate.content.name = "Updated module name";
    request.candidate.content.recordTypes[0]!.fields.push(field(id(11)));
    request.candidate.content.recordTypes[0]!.storageScope = "application_contained";
    const first = compareDefinitionVersionImpact(request);
    const second = compareDefinitionVersionImpact(structuredClone(request));
    expect(second).toEqual(first);
    expect(first.outcome).toBe("release_required");
    if (first.outcome === "release_required") {
      expect(first.impact).toBe("major");
      expect(first.reasons.map((reason) => reason.impact)).toEqual(["major", "minor", "patch"]);
      expect(new Set(first.reasons.map((reason) => JSON.stringify(reason))).size).toBe(
        first.reasons.length,
      );
    }
  });

  test("validates history roots, ordering and recorded content fingerprints", () => {
    const rootMismatch = requestAfter(moduleDraft());
    rootMismatch.history[0]!.publication.rootId = id(90);
    expectCode(() => compareDefinitionVersionImpact(rootMismatch), "root_mismatch");

    const changedContent = requestAfter(moduleDraft());
    changedContent.history[0]!.content.name = "Changed after publication";
    expectCode(
      () => compareDefinitionVersionImpact(changedContent),
      "content_fingerprint_mismatch",
    );

    const invalidOrder = requestAfter(moduleDraft());
    const second = publish(moduleDraft(), "0.9.0", 2);
    invalidOrder.history.push(second);
    invalidOrder.candidate.envelope.publishedRevision = 2;
    invalidOrder.candidate.envelope.draftRevision = 3;
    expectCode(() => compareDefinitionVersionImpact(invalidOrder), "invalid_history");

    const invalidFirstRelease = requestAfter(moduleDraft());
    invalidFirstRelease.history[0] = publish(moduleDraft(), "2.0.0", 1);
    expectCode(() => compareDefinitionVersionImpact(invalidFirstRelease), "invalid_history");

    const prerelease = requestAfter(moduleDraft());
    prerelease.history[0] = publish(moduleDraft(), "1.0.0-alpha", 1);
    expectCode(() => compareDefinitionVersionImpact(prerelease), "invalid_history");

    const duplicateField = requestAfter(moduleDraft());
    duplicateField.candidate.content.recordTypes[0]!.fields.push({
      ...duplicateField.candidate.content.recordTypes[0]!.fields[0]!,
    });
    expectCode(
      () => compareDefinitionVersionImpact(duplicateField),
      "ambiguous_component_identity",
    );

    const duplicateOlderHistory = requestAfter(moduleDraft());
    const older = publish(moduleDraft(), "1.0.0", 1);
    older.content.permissions.push({
      ...older.content.permissions[0]!,
      permissionId: id(7),
    });
    older.publication.contentFingerprint = fingerprintCanonicalValue(older.content);
    const latestDraft = moduleDraft();
    const latest = publish(latestDraft, "1.1.0", 2);
    duplicateOlderHistory.history = [older, latest];
    duplicateOlderHistory.candidate.envelope.publishedRevision = 2;
    duplicateOlderHistory.candidate.envelope.draftRevision = 3;
    expectCode(
      () => compareDefinitionVersionImpact(duplicateOlderHistory),
      "ambiguous_component_identity",
    );
  });

  test("recomputes confirmations and rejects stale results, overrides and no-change releases", () => {
    const request = requestAfter(moduleDraft());
    request.candidate.content.name = "Updated module name";
    const result = compareDefinitionVersionImpact(request);
    expect(result.outcome).toBe("release_required");
    if (result.outcome !== "release_required") throw new Error("Expected a release");
    const confirmation = {
      subject: result.subject,
      comparisonFingerprint: result.comparisonFingerprint,
      assignedVersion: result.assignedVersion,
    };
    expect(confirmDefinitionVersionImpact(request, confirmation)).toEqual(result);

    request.candidate.content.description = "The candidate changed after confirmation.";
    expectCode(
      () => confirmDefinitionVersionImpact(request, confirmation),
      "confirmation_mismatch",
    );
    expectCode(
      () => confirmDefinitionVersionImpact(requestAfter(moduleDraft()), confirmation),
      "no_release_to_confirm",
    );
    expectCode(
      () => confirmDefinitionVersionImpact(request, { ...confirmation, overrideVersion: "9.0.0" }),
      "confirmation_mismatch",
    );
  });

  test("increments arbitrarily large stable versions without numeric overflow", () => {
    expect(assignNextDefinitionVersion("999999999999999999999.2.3", "major")).toBe(
      "1000000000000000000000.0.0",
    );
  });
});
