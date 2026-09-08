import fs from "node:fs";
import path from "node:path";
import {
  definitionResolutionSnapshotSchema,
  definitionResolutionSnapshotV2Schema,
  moduleSourceDocumentV2Schema,
  sessionContextSchema,
  storedDefinitionDraftSchema,
  type ModuleSourceDocumentV2,
  type PublishDefinitionResult,
  type SessionContext,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { compileDefinition } from "../src/compiler";
import { createDefinitionConsumerReadService } from "../src/definition-consumer-read";
import {
  createDefinitionHistoryService,
  type DefinitionHistoryRepository,
} from "../src/definition-history";
import {
  createDefinitionPublicationService,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationCatalogue,
  type DefinitionPublicationReader,
  type DefinitionPublicationRepository,
  type DefinitionPublicationTransaction,
  type DefinitionReleaseAppend,
} from "../src/definition-publication";
import { extractStoredSourceIdentityRequirements } from "../src/source-identities";
import { compileDefinitionSet, evaluateSavedSharingConditionV2 } from "../src/validation";

const fixtureRoot = path.resolve(import.meta.dirname, "../../../testing/fixtures");
const baseResolution = definitionResolutionSnapshotSchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "definition-resolution-snapshot.json"), "utf8"),
  ),
);
const metadata = {
  organizationId: "10000000-0000-4000-a000-000000000001",
  draftRevision: 1,
  createdAt: "2026-09-01T00:00:00+00:00",
  createdBy: "10000000-0000-4000-a000-000000000002",
  updatedAt: "2026-09-01T00:00:00+00:00",
  updatedBy: "10000000-0000-4000-a000-000000000002",
} as const;
const context = (): SessionContext =>
  sessionContextSchema.parse({
    callerKind: "system",
    tenantId: "10000000-0000-4000-8000-000000000010",
    organizationId: metadata.organizationId,
    systemActorId: metadata.createdBy,
    sessionId: "10000000-0000-4000-8000-000000000011",
    authenticationStrength: "service",
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    accessVersion: 1,
    correlationId: "10000000-0000-4000-8000-000000000012",
  });

const sourceV2 = (exactValues = false): ModuleSourceDocumentV2 => {
  const source = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "modules/service-desk.sla.json"), "utf8"),
  ) as {
    source_contract_version: string;
    body: {
      record_types: Array<{
        key: string;
        fields: Array<Record<string, unknown>>;
      }>;
      actions: Array<Record<string, unknown>>;
      rules: Array<Record<string, unknown>>;
      sharing_conditions: Array<Record<string, unknown>>;
    };
  };
  source.source_contract_version = "2.0.0";
  if (exactValues) {
    const serviceLevel = source.body.record_types.find(
      (record: Record<string, unknown>) => record.key === "service_level",
    );
    const response = serviceLevel.fields.find(
      (field: Record<string, unknown>) => field.key === "first_response_minutes",
    );
    response.type = "decimal_number";
    response.settings = {
      digits_before_decimal: 30,
      decimal_places: 4,
      minimum: "0.1000",
      maximum: "90071992547409931234567890.1200",
    };
    response.default = "1.2500";
    const resolution = serviceLevel.fields.find(
      (field: Record<string, unknown>) => field.key === "resolution_minutes",
    );
    resolution.type = "money";
    resolution.settings = {
      currency_mode: "fixed",
      currency: "NZD",
      minimum: "0.00",
    };
    resolution.default = "12.3400";
    serviceLevel.fields.push({
      id: "fld_sla_tags",
      key: "tags",
      type: "several_choices",
      label: "Tags",
      required: false,
      unique: false,
      filterable: true,
      sortable: true,
      personal_data: "none",
      public_display: "refused",
      settings: {
        options: [
          { value: "restricted", label: "Restricted" },
          { value: "standard", label: "Standard" },
        ],
      },
    });
    serviceLevel.fields.push({
      id: "fld_sla_exact_condition",
      key: "exact_condition",
      type: "calculation",
      label: "Exact condition",
      required: false,
      unique: false,
      filterable: true,
      sortable: true,
      personal_data: "none",
      public_display: "refused",
      settings: {
        result_type: "yes_no",
        expression: {
          operation: "condition",
          condition: {
            field: "first_response_minutes",
            operator: "greater_than",
            value: "1.2000",
          },
        },
      },
    });
    serviceLevel.fields.push({
      id: "fld_sla_exact_calculation",
      key: "exact_calculation",
      type: "calculation",
      label: "Exact calculation",
      required: false,
      unique: false,
      filterable: true,
      sortable: true,
      personal_data: "none",
      public_display: "refused",
      settings: {
        result_type: "decimal_number",
        expression: {
          operation: "numeric",
          numeric_operation: "add",
          operands: [
            { source: "field", field: "first_response_minutes" },
            { source: "literal", value: "1.2500" },
          ],
        },
      },
    });
    const calendar = source.body.record_types.find(
      (record: Record<string, unknown>) => record.key === "business_calendar",
    );
    calendar.fields.push({
      id: "fld_calendar_total_response",
      key: "total_response",
      type: "total",
      label: "Total response",
      required: false,
      unique: false,
      filterable: true,
      sortable: true,
      personal_data: "none",
      public_display: "refused",
      settings: {
        relationship: "vortex.service_desk.sla:service_level.calendar",
        operation: "sum",
        result_type: "decimal_number",
        field: "first_response_minutes",
        filter: {
          field: "first_response_minutes",
          operator: "greater_than",
          value: "1.2000",
        },
      },
    });
    const pause = source.body.actions[0]!;
    pause.inputs = [
      {
        key: "exact_floor",
        label: "Exact floor",
        required: true,
        type: "decimal_number",
        validation: { minimum: "1.2000", maximum: "20.0000" },
      },
      {
        key: "money_limit",
        label: "Money limit",
        required: false,
        type: "money",
        validation: { minimum: "0.1000", maximum: "50.0000" },
      },
      {
        key: "calendar_input",
        label: "Calendar input",
        required: false,
        type: "record_reference",
        record_types: ["vortex.service_desk.sla:business_calendar"],
      },
    ];
    pause.precondition = {
      all: [
        {
          field: "first_response_minutes",
          operator: "in",
          value: ["1.2000", "1.2500"],
        },
        {
          operator: "in",
          left: { source: "field", field: "calendar" },
          right: {
            source: "value",
            value: [
              {
                record_type: "vortex.service_desk.sla:business_calendar",
                record_id: "90000000-0000-4000-8000-000000000090",
              },
            ],
          },
        },
        {
          operator: "equals",
          left: { source: "parameter", parameter: "calendar_input" },
          right: {
            source: "value",
            value: {
              record_type: "vortex.service_desk.sla:business_calendar",
              record_id: "90000000-0000-4000-8000-000000000094",
            },
          },
        },
        { field: "tags", operator: "contains", value: "restricted" },
        { field: "first_response_minutes", operator: "equals", value: null },
      ],
    };
    (pause.effects as Array<Record<string, unknown>>).push(
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
            record_id: "90000000-0000-4000-8000-000000000091",
          },
        },
      },
      {
        kind: "create_record",
        record_type: "vortex.service_desk.sla:service_level",
        values: {
          first_response_minutes: { source: "literal", value: "2.5000" },
          resolution_minutes: {
            source: "literal",
            value: { amount: "25.0000", currency: "NZD" },
          },
          calendar: {
            source: "literal",
            value: {
              record_type: "vortex.service_desk.sla:business_calendar",
              record_id: "90000000-0000-4000-8000-000000000092",
            },
          },
        },
      },
    );
    source.body.rules = [
      {
        id: "rule_exact_response",
        key: "exact_response",
        record_type: "service_level",
        trigger: "change",
        priority: 100,
        condition: {
          field: "first_response_minutes",
          operator: "greater_than",
          value: "1.2000",
        },
        effect: {
          kind: "set_value",
          field: "resolution_minutes",
          value: { amount: "15.5000", currency: "NZD" },
        },
      },
    ];
    source.body.sharing_conditions = [
      {
        id: "share_exact_response",
        source_record_type: "service_level",
        key: "response_above_floor",
        parameters: [{ key: "floor", type: "decimal_number" }],
        condition: {
          left: { source: "field", field: "first_response_minutes" },
          operator: "greater_than",
          right: { source: "parameter", parameter: "floor" },
        },
        declared_fields: ["first_response_minutes"],
        publication_tests: [
          {
            name: "Exact response exceeds floor",
            parameters: { floor: "1.2000" },
            field_values: { first_response_minutes: "1.2500" },
            expected: true,
          },
        ],
      },
      {
        id: "share_exact_calculation",
        source_record_type: "service_level",
        key: "calculation_above_floor",
        parameters: [],
        condition: {
          field: "exact_calculation",
          operator: "greater_than",
          value: "2.4000",
        },
        declared_fields: ["exact_calculation"],
        publication_tests: [
          {
            name: "Calculated exact result is canonicalized",
            parameters: {},
            field_values: { exact_calculation: "2.5000" },
            expected: true,
          },
        ],
      },
      {
        id: "share_exact_total",
        source_record_type: "business_calendar",
        key: "total_above_floor",
        parameters: [],
        condition: {
          field: "total_response",
          operator: "greater_than",
          value: "3.4000",
        },
        declared_fields: ["total_response"],
        publication_tests: [
          {
            name: "Total exact result is canonicalized",
            parameters: {},
            field_values: { total_response: "3.5000" },
            expected: true,
          },
        ],
      },
      {
        id: "share_exact_integer_lift",
        source_record_type: "service_level",
        key: "response_above_integer",
        parameters: [{ key: "integer_floor", type: "number" }],
        condition: {
          field: "first_response_minutes",
          operator: "greater_than",
          parameter: "integer_floor",
        },
        declared_fields: ["first_response_minutes"],
        publication_tests: [
          {
            name: "Legacy whole number lifts into exact comparison",
            parameters: { integer_floor: 1 },
            field_values: { first_response_minutes: "1.2500" },
            expected: true,
          },
        ],
      },
    ];
  }
  return moduleSourceDocumentV2Schema.parse(source);
};

const resolutionV2 = (source = sourceV2()) => {
  const identities = [...baseResolution.identities];
  for (const requirement of extractStoredSourceIdentityRequirements(source)) {
    const ownerIdentity = identities.find(
      (identity) =>
        identity.definitionKey === requirement.definitionKey &&
        identity.scope === requirement.scope &&
        identity.kind === requirement.kind &&
        identity.componentOwner === requirement.componentOwner,
    );
    const owner =
      ownerIdentity ??
      ({
        definitionKey: requirement.definitionKey,
        scope: requirement.scope,
        kind: requirement.kind,
        componentOwner: requirement.componentOwner,
        alias: requirement.aliases[0]!,
        identifier: `90000000-0000-4000-8000-${String(identities.length + 1).padStart(12, "0")}`,
      } as const);
    if (!ownerIdentity) identities.push(owner);
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
        identities.push({ ...owner, alias });
  }
  const evidence = {
    contractVersion: "2.0.0" as const,
    definitions: baseResolution.definitions,
    identities,
  };
  return definitionResolutionSnapshotV2Schema.parse({
    ...evidence,
    fingerprint: fingerprintCanonicalValue(evidence),
  });
};

const savedConditionRevisionsV2 = (
  source: ModuleSourceDocumentV2,
  resolution: ReturnType<typeof resolutionV2>,
) =>
  source.body.sharing_conditions.map((condition) => {
    const identity = resolution.identities.find(
      (candidate) =>
        candidate.definitionKey === source.key &&
        candidate.kind === "sharing_condition" &&
        candidate.componentOwner === condition.id,
    );
    if (!identity) throw new Error("Sharing-condition identity required");
    return { conditionId: identity.identifier, revision: 1 };
  });

const catalogue: DefinitionPublicationCatalogue = {
  listConnectionTypeReleases: async () => [],
  readConnectionTypeRelease: async () => undefined,
  readPlatformThemeRelease: async () => undefined,
  readPlatformBlockReleaseV2: async () => undefined,
  readPlatformThemeReleaseV2: async () => undefined,
  readApplicationCompositionCatalogueSnapshotV2: async () => undefined,
};

class ModuleV2PublicationRepository
  implements
    DefinitionPublicationRepository,
    DefinitionPublicationReader,
    DefinitionPublicationTransaction
{
  appended?: DefinitionReleaseAppend;

  constructor(readonly candidate: DefinitionPublicationCandidate) {}

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

  async readCandidate() {
    return structuredClone(this.candidate);
  }

  async lockCandidate() {
    return structuredClone(this.candidate);
  }

  async listModuleReleases() {
    return [];
  }

  async readModuleRelease() {
    return undefined;
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
      publishedBy: metadata.updatedBy,
    };
  }
}

describe("Module V2 Definition runtime", () => {
  it("dispatches the exact pair and preserves deterministic V2 output", () => {
    const source = sourceV2();
    const request = {
      sourceContractVersion: "2.0.0" as const,
      validationContractVersion: "2.0.0" as const,
      source,
      resolution: resolutionV2(source),
      draftMetadata: metadata,
      savedConditionRevisions: [],
    };
    const output = compileDefinition(request);
    expect(output).toMatchObject({
      kind: "module",
      validationContractVersion: "2.0.0",
      resolutionFingerprint: request.resolution.fingerprint,
    });
    expect(compileDefinition(structuredClone(request))).toEqual(output);
    expect(() =>
      compileDefinition({ ...request, validationContractVersion: "1.0.0" } as never),
    ).toThrow();
  });

  it("normalizes exact decimal and amount-only money defaults without binary conversion", () => {
    const source = sourceV2(true);
    const sourceResolution = resolutionV2(source);
    const request = {
      sourceContractVersion: "2.0.0",
      validationContractVersion: "2.0.0",
      source,
      resolution: sourceResolution,
      draftMetadata: metadata,
      savedConditionRevisions: savedConditionRevisionsV2(source, sourceResolution),
    } as const;
    const [output] = compileDefinitionSet([request], {
      publishedHistories: [{ kind: "module", definitionKey: source.key, history: [] }],
    });
    if (!output) throw new Error("Module V2 output required");
    if (output.kind !== "module" || !("validationContractVersion" in output))
      throw new Error("Module V2 output required");
    const fields = output.canonical.content.recordTypes.find(
      (record) => record.key === "service_level",
    )!.fields;
    const decimal = fields.find((field) => field.key === "first_response_minutes");
    const money = fields.find((field) => field.key === "resolution_minutes");
    expect(decimal).toMatchObject({
      type: "decimal_number",
      default: "1.25",
      settings: {
        minimum: "0.1",
        maximum: "90071992547409931234567890.12",
      },
    });
    expect(money).toMatchObject({
      type: "money",
      default: "12.34",
      settings: { currencyMode: "fixed", currency: "NZD", minimum: "0" },
    });
    expect(fields.find((field) => field.key === "exact_condition")).toMatchObject({
      settings: {
        expression: {
          kind: "condition",
          condition: {
            kind: "comparison",
            right: { source: "value", value: "1.2" },
          },
        },
      },
    });
    const total = output.canonical.content.recordTypes
      .find((record) => record.key === "business_calendar")!
      .fields.find((field) => field.key === "total_response");
    expect(total).toMatchObject({
      settings: {
        filter: {
          kind: "comparison",
          right: { source: "value", value: "1.2" },
        },
      },
    });
    const action = output.canonical.content.actions.find(
      (candidate) => candidate.key === "vortex.service_desk.sla.service_level.pause",
    )!;
    expect(action.inputs).toMatchObject([
      { type: "decimal_number", validation: { minimum: "1.2", maximum: "20" } },
      { type: "money", validation: { minimum: "0.1", maximum: "50" } },
      { type: "record_reference", recordTypes: [expect.any(Object)] },
    ]);
    expect(action.precondition).toMatchObject({
      kind: "all",
      conditions: [
        { right: { source: "value", value: ["1.2", "1.25"] } },
        {
          right: {
            source: "value",
            value: [
              {
                recordTypeId: expect.any(String),
                recordId: "90000000-0000-4000-8000-000000000090",
              },
            ],
          },
        },
        {
          right: {
            source: "value",
            value: {
              recordTypeId: expect.any(String),
              recordId: "90000000-0000-4000-8000-000000000094",
            },
          },
        },
        { right: { source: "value", value: "restricted" } },
        { right: { source: "value", value: null } },
      ],
    });
    expect(action.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "set_field",
          value: { source: "literal", value: { amount: "12.34", currency: "NZD" } },
        }),
        expect.objectContaining({
          kind: "create_record",
          values: expect.objectContaining({
            [decimal!.fieldId]: { source: "literal", value: "2.5" },
            [money!.fieldId]: {
              source: "literal",
              value: { amount: "25", currency: "NZD" },
            },
          }),
        }),
      ]),
    );
    expect(output.canonical.content.rules[0]).toMatchObject({
      condition: { right: { source: "value", value: "1.2" } },
      effect: { kind: "set_value", value: { amount: "15.5", currency: "NZD" } },
    });
    const sharing = output.canonical.content.sharingConditions[0]!;
    const publicationTest = sharing.publicationTests[0]!;
    expect(publicationTest).toMatchObject({
      parameters: { floor: "1.2" },
      fieldValues: { [decimal!.fieldId]: "1.25" },
    });
    expect(
      evaluateSavedSharingConditionV2(
        sharing,
        publicationTest.fieldValues,
        publicationTest.parameters,
        fields,
      ),
    ).toBe(true);
    expect(
      output.canonical.content.sharingConditions.find(
        (condition) => condition.key === "calculation_above_floor",
      )?.publicationTests[0]?.fieldValues,
    ).toEqual({ [fields.find((field) => field.key === "exact_calculation")!.fieldId]: "2.5" });
    expect(
      output.canonical.content.sharingConditions.find(
        (condition) => condition.key === "total_above_floor",
      )?.publicationTests[0]?.fieldValues,
    ).toEqual({ [total!.fieldId]: "3.5" });
  });

  it("refuses action and rule link literals outside the field's declared target", () => {
    const source = sourceV2(true);
    const pause = source.body.actions[0]!;
    const wrongLink = {
      record_type: "vortex.service_desk.sla:service_level",
      record_id: "90000000-0000-4000-8000-000000000093",
    };
    const calendarEffect = pause.effects.find(
      (effect) => effect.kind === "set_field" && effect.field === "calendar",
    );
    if (calendarEffect?.kind !== "set_field" || calendarEffect.value.source !== "literal")
      throw new Error("Calendar effect required");
    calendarEffect.value.value = wrongLink;
    const sourceResolution = resolutionV2(source);
    expect(() =>
      compileDefinitionSet(
        [
          {
            sourceContractVersion: "2.0.0",
            validationContractVersion: "2.0.0",
            source,
            resolution: sourceResolution,
            draftMetadata: metadata,
            savedConditionRevisions: savedConditionRevisionsV2(source, sourceResolution),
          },
        ],
        { publishedHistories: [{ kind: "module", definitionKey: source.key, history: [] }] },
      ),
    ).toThrow();

    const ruleSource = sourceV2(true);
    ruleSource.body.rules[0]!.effect = {
      kind: "set_value",
      field: "calendar",
      value: wrongLink,
    };
    const ruleResolution = resolutionV2(ruleSource);
    expect(() =>
      compileDefinitionSet(
        [
          {
            sourceContractVersion: "2.0.0",
            validationContractVersion: "2.0.0",
            source: ruleSource,
            resolution: ruleResolution,
            draftMetadata: metadata,
            savedConditionRevisions: savedConditionRevisionsV2(ruleSource, ruleResolution),
          },
        ],
        { publishedHistories: [{ kind: "module", definitionKey: ruleSource.key, history: [] }] },
      ),
    ).toThrow();
  });

  it("refuses V2 conditions whose declared types or collection element types cannot execute", () => {
    const incompatibleDeclarations = sourceV2(true);
    incompatibleDeclarations.body.actions[0]!.precondition = {
      field: "first_response_minutes",
      operator: "equals",
      parameter: "money_limit",
    };
    const collectionAsElement = sourceV2(true);
    collectionAsElement.body.actions[0]!.precondition = {
      field: "tags",
      operator: "in",
      value: [["restricted"]],
    };
    for (const source of [incompatibleDeclarations, collectionAsElement]) {
      const sourceResolution = resolutionV2(source);
      expect(() =>
        compileDefinitionSet(
          [
            {
              sourceContractVersion: "2.0.0",
              validationContractVersion: "2.0.0",
              source,
              resolution: sourceResolution,
              draftMetadata: metadata,
              savedConditionRevisions: savedConditionRevisionsV2(source, sourceResolution),
            },
          ],
          { publishedHistories: [{ kind: "module", definitionKey: source.key, history: [] }] },
        ),
      ).toThrow();
    }
  });

  it("refuses cross-shape assignments between distinct opaque V2 value families", () => {
    const source = sourceV2(true);
    const serviceLevel = source.body.record_types.find((record) => record.key === "service_level")!;
    serviceLevel.fields.push({
      id: "fld_sla_notes_table",
      key: "notes_table",
      type: "table",
      label: "Notes table",
      required: false,
      unique: false,
      filterable: false,
      sortable: false,
      personal_data: "none",
      public_display: "refused",
      settings: {
        minimum_rows: 0,
        maximum_rows: 5,
        columns: [
          {
            key: "note",
            type: "text",
            required: false,
            settings: { max_length: 100 },
          },
        ],
      },
    });
    const action = source.body.actions[0]!;
    action.inputs.push({
      key: "formatted_notes",
      label: "Formatted notes",
      required: false,
      type: "formatted_text",
      validation: { allowed_blocks: ["paragraph"] },
    });
    action.effects.push({
      kind: "set_field",
      field: "notes_table",
      value: { source: "input", input: "formatted_notes" },
    });
    const resolution = resolutionV2(source);
    expect(() =>
      compileDefinitionSet(
        [
          {
            sourceContractVersion: "2.0.0",
            validationContractVersion: "2.0.0",
            source,
            resolution,
            draftMetadata: metadata,
            savedConditionRevisions: savedConditionRevisionsV2(source, resolution),
          },
        ],
        { publishedHistories: [{ kind: "module", definitionKey: source.key, history: [] }] },
      ),
    ).toThrow();
  });

  it("publishes, reads, and restores one exact Module V2 release", async () => {
    const source = sourceV2();
    const resolution = resolutionV2(source);
    const own = resolution.definitions.find(
      (definition) => definition.kind === "module" && definition.key === source.key,
    );
    if (own?.kind !== "module") throw new Error("Module resolution required");
    const draft = storedDefinitionDraftSchema.parse({
      kind: "module",
      rootId: own.rootId,
      key: source.key,
      draftRevision: 1,
      sourceContractVersion: "2.0.0",
      sourceFingerprint: fingerprintCanonicalValue(source),
      source,
      ...metadata,
    });
    const candidate: DefinitionPublicationCandidate = {
      draft,
      identities: resolution.identities.filter((identity) => identity.definitionKey === source.key),
      history: { kind: "module", definitionKey: source.key, history: [] },
    };
    const repository = new ModuleV2PublicationRepository(candidate);
    const service = createDefinitionPublicationService(repository, catalogue);
    const prepared = await service.prepare(context(), {
      rootId: draft.rootId,
      expectedDraftRevision: 1,
    });
    await service.publish(context(), {
      confirmation: prepared.confirmation,
      releaseNote: "Native Module V2 release",
    });
    const appended = repository.appended;
    if (!appended || !("validationContractVersion" in appended.compilationOutput))
      throw new Error("Module V2 append required");
    expect(appended.validationContractVersion).toBe("2.0.0");

    const evidence = {
      organizationId: metadata.organizationId,
      kind: "module" as const,
      key: source.key,
      rootId: draft.rootId,
      releaseRevision: 1,
      releaseVersion: "1.0.0",
      sourceContractVersion: "2.0.0",
      validationContractVersion: "2.0.0",
      contentFingerprint: appended.compilationOutput.artifact.contentFingerprint,
      resolutionFingerprint: appended.compilationOutput.resolutionFingerprint,
      compilationOutput: appended.compilationOutput,
      resolutionSnapshot: appended.resolutionSnapshot,
      dependencyManifest: appended.dependencyManifest,
      moduleDependencyTargets: [],
    };
    await expect(
      createDefinitionConsumerReadService({ read: async () => evidence }, catalogue).read(
        context(),
        {
          kind: "module",
          rootId: draft.rootId,
          selector: { selection: "revision", releaseRevision: 1 },
        },
      ),
    ).resolves.toMatchObject({
      validationContractVersion: "2.0.0",
      content: appended.compilationOutput.canonical.content,
    });

    const requirements = extractStoredSourceIdentityRequirements(source);
    const identityEvidence = requirements.flatMap((requirement) =>
      requirement.aliases.map((alias) => {
        const identity = appended.resolutionSnapshot.identities.find(
          (entry) =>
            entry.definitionKey === source.key &&
            entry.scope === requirement.scope &&
            entry.kind === requirement.kind &&
            entry.componentOwner === requirement.componentOwner &&
            entry.alias === alias,
        );
        if (!identity)
          throw new Error(
            `Restore identity evidence required: ${JSON.stringify({
              scope: requirement.scope,
              kind: requirement.kind,
              owner: requirement.componentOwner,
              alias,
            })}`,
          );
        return { ...identity, ownerScope: requirement.ownerScope };
      }),
    );
    const restored = storedDefinitionDraftSchema.parse({
      ...draft,
      draftRevision: 2,
      publishedRevision: 1,
      restoredFromReleaseRevision: 1,
      restoredFromSourceFingerprint: draft.sourceFingerprint,
      restoredBy: context().systemActorId,
      restoredAt: metadata.updatedAt,
      restoreCorrelationId: context().correlationId,
    });
    const historyRepository: DefinitionHistoryRepository = {
      list: async () => undefined,
      readMetadata: async () => undefined,
      restore: async (_context, _command, verify) => {
        await verify({
          ...evidence,
          authoredSource: source,
          sourceFingerprint: draft.sourceFingerprint,
          identityEvidence,
        });
        return { outcome: "restored", draft: restored };
      },
    };
    await expect(
      createDefinitionHistoryService(historyRepository, catalogue).restoreDraft(context(), {
        kind: "module",
        rootId: draft.rootId,
        targetReleaseRevision: 1,
        expectedDraftRevision: 1,
      }),
    ).resolves.toMatchObject({ sourceContractVersion: "2.0.0", source });
  });
});
