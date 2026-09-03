import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  definitionResolutionSnapshotSchema,
  definitionSourceDocumentSchema,
  workflowNodeOutputsByType,
} from "@vortex/contracts";
import {
  definitionCompilerRefusalCodes,
  DefinitionCompilationError,
} from "../src/compilation-error";
import { compileDefinition } from "../src/compiler";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { compareDefinitionVersionImpact } from "../src/version-impact";
import {
  compileDefinitionSet,
  definitionSemanticRules,
  evaluateSavedSharingCondition,
  fingerprintActiveDependantCheck,
  validateDefinitionSource,
  validateDefinitionSet,
  workflowValueCompatible,
} from "../src/validation";

const fixtureRoot = path.resolve(import.meta.dirname, "../../../testing/fixtures");
const fixturePaths = ["modules", "applications", "connection-types"].flatMap((directory) =>
  fs
    .readdirSync(path.join(fixtureRoot, directory))
    .filter((name) => name.endsWith(".json"))
    .map((name) => `${directory}/${name}`),
);
const sources = fixturePaths.map((file) =>
  definitionSourceDocumentSchema.parse(
    JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), "utf8")),
  ),
);
const resolution = definitionResolutionSnapshotSchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "definition-resolution-snapshot.json"), "utf8"),
  ),
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
const publicationOptions = {
  publishedHistories: sources
    .filter((source) => source.kind === "module" || source.kind === "application")
    .map((source) => ({ kind: source.kind, definitionKey: source.key, history: [] })),
  activeDependants: [],
} as const;
const requestFor = (source: (typeof sources)[number]) => ({
  source,
  resolution,
  ...(source.kind === "connection_type" ? {} : { draftMetadata }),
  ...(source.kind === "module" ? { savedConditionRevisions } : {}),
});
const publicationContext = (
  requests: ReturnType<typeof requestFor>[],
  outputs: ReturnType<typeof compileDefinition>[],
) => ({ requests, outputs, ...publicationOptions });
const withResolutionFingerprint = (value: typeof resolution) => ({
  ...value,
  fingerprint: fingerprintCanonicalValue({
    contractVersion: value.contractVersion,
    definitions: value.definitions,
    identities: value.identities,
  }),
});
const hasPath = (value: unknown, segments: readonly (string | number)[]) => {
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || !(segment in current)) return false;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return true;
};
const leafPathKeys = (value: unknown, path: readonly (string | number)[] = []): string[] =>
  Array.isArray(value)
    ? value.flatMap((entry, index) => leafPathKeys(entry, [...path, index]))
    : value !== null && typeof value === "object"
      ? Object.entries(value).flatMap(([key, entry]) => leafPathKeys(entry, [...path, key]))
      : [JSON.stringify(path)];

describe("authored definition compiler", () => {
  it("compiles all thirteen source definitions through the immutable snapshot", () => {
    const outputs = sources.map((source) => {
      try {
        return compileDefinition({
          source,
          resolution,
          ...(source.kind === "connection_type" ? {} : { draftMetadata }),
          ...(source.kind === "module" ? { savedConditionRevisions } : {}),
        });
      } catch (error) {
        throw new Error(`Compilation failed for ${source.key}`, { cause: error });
      }
    });
    expect(outputs).toHaveLength(13);
    expect(outputs.every((output) => output.resolutionFingerprint === resolution.fingerprint)).toBe(
      true,
    );
    expect(outputs.map((output) => output.kind).sort()).toEqual([
      "application",
      "application",
      "connection_type",
      "connection_type",
      "connection_type",
      "module",
      "module",
      "module",
      "module",
      "module",
      "module",
      "module",
      "module",
    ]);
  });

  it("expands the sole application wildcard into exact non-admin permissions", () => {
    const source = structuredClone(
      sources.find(
        (candidate) => candidate.kind === "application" && candidate.key === "vortex.app.crm",
      ),
    );
    expect(source?.kind).toBe("application");
    if (!source || source.kind !== "application") throw new Error("Application fixture missing");
    source.body.roles[0]!.permissions = ["*"];

    const output = compileDefinition(requestFor(source));
    if (output.kind !== "application") throw new Error("Application output expected");
    const role = output.canonical.content.roles[0]!;
    const expectedPermissions = output.canonical.content.permissions
      .filter((permission) => !permission.administrative)
      .sort((left, right) => left.key.localeCompare(right.key));

    expect(role.permissionKeys).toEqual(expectedPermissions.map((permission) => permission.key));
    expect(role.permissionKeys).not.toContain("*");
    expect(role.permissionSelection).toEqual({
      kind: "application_wildcard",
      catalogueFingerprint: fingerprintCanonicalValue(expectedPermissions),
    });
    const wildcardSourcePath = JSON.stringify(["body", "roles", 0, "permissions", 0]);
    const generatedRoleLeafPaths = leafPathKeys(role).map((serialized) =>
      JSON.stringify(["content", "roles", 0, ...JSON.parse(serialized)]),
    );
    const wildcardProvenance = output.provenance.filter(
      (entry) => JSON.stringify(entry.sourcePath) === wildcardSourcePath,
    );
    expect(wildcardProvenance.map((entry) => JSON.stringify(entry.canonicalPath)).sort()).toEqual(
      generatedRoleLeafPaths.filter((path) => path.includes("permission")).sort(),
    );
    expect(wildcardProvenance.every((entry) => entry.ruleCode !== undefined)).toBe(true);
  });

  it("orders and validates the complete set independently of input order", () => {
    const requests = sources.map(requestFor);
    for (const source of sources)
      expect(validateDefinitionSource(source).failures, source.key).toEqual([]);
    const forward = compileDefinitionSet(requests, publicationOptions);
    const reverse = compileDefinitionSet([...requests].reverse(), publicationOptions);
    expect(reverse).toEqual(forward);
    expect(forward).toHaveLength(13);
  });

  it("keeps every semantic failure code under one honest static rule owner", () => {
    expect(new Set(definitionSemanticRules.map((rule) => rule.ruleId)).size).toBe(
      definitionSemanticRules.length,
    );
    expect(new Set(definitionSemanticRules.map((rule) => rule.run)).size).toBe(
      definitionSemanticRules.length,
    );
    expect(definitionSemanticRules.every((rule) => rule.requiredContext.length > 0)).toBe(true);
    const outputs = sources.map((source) => compileDefinition(requestFor(source)));
    const context = publicationContext(sources.map(requestFor), outputs);
    expect(
      definitionSemanticRules.every((rule) =>
        rule.run(context).every((failure) => rule.emittedCodes.includes(failure.ruleCode)),
      ),
    ).toBe(true);
    const emittedCodes = definitionSemanticRules.flatMap((rule) => rule.emittedCodes);
    expect(new Set(emittedCodes).size).toBe(emittedCodes.length);
    const registered = new Set(emittedCodes);
    expect(
      validateDefinitionSet(context).failures.every((entry) => registered.has(entry.ruleCode)),
    ).toBe(true);
    expect(
      emittedCodes.every((code) => definitionCompilerRefusalCodes.includes(code as never)),
    ).toBe(true);
    expect(new Set(definitionCompilerRefusalCodes).size).toBe(
      definitionCompilerRefusalCodes.length,
    );
  });

  it("returns safe edit-time and compiler refusals without leaking schema diagnostics", () => {
    const sourceValidation = validateDefinitionSource({ kind: "module" });
    expect(sourceValidation.valid).toBe(false);
    expect(sourceValidation.failures).toEqual(
      expect.arrayContaining([
        { ruleCode: "vortex.definition.source_shape", family: "unsupported_choice" },
        { ruleCode: "vortex.definition.source_shape", family: "invalid_value" },
      ]),
    );
    expect(
      sourceValidation.failures.every((failure) =>
        Object.keys(failure).every((key) => ["ruleCode", "family", "location"].includes(key)),
      ),
    ).toBe(true);
    const nestedSource = structuredClone(sources.find((source) => source.kind === "module")!);
    if (nestedSource.kind !== "module") throw new Error("Expected module source");
    const nestedField = nestedSource.body.record_types[0]!.fields[0]! as unknown as Record<
      string,
      unknown
    >;
    nestedField.internal_note = "must never appear in a public error";
    const nestedValidation = validateDefinitionSource(nestedSource);
    const unknownProperty = nestedValidation.failures.find(
      (failure) => failure.family === "unknown_property",
    );
    expect(unknownProperty?.location).toEqual(
      expect.objectContaining({
        documentKind: "module",
        documentKey: nestedSource.key,
        segments: expect.arrayContaining([
          expect.objectContaining({
            kind: "field",
            key: nestedSource.body.record_types[0]!.fields[0]!.key,
          }),
        ]),
      }),
    );
    expect(JSON.stringify(nestedValidation)).not.toContain("must never appear");
    let refusal: unknown;
    try {
      compileDefinition({ source: { kind: "module" } });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(DefinitionCompilationError);
    expect(definitionCompilerRefusalCodes).toContain(
      (refusal as DefinitionCompilationError).ruleCode,
    );
    expect((refusal as Error).message).toBe((refusal as DefinitionCompilationError).ruleCode);
    expect(() =>
      compileDefinitionSet(
        [{ source: { kind: "module" } }] as unknown as ReturnType<typeof requestFor>[],
        { publishedHistories: [], activeDependants: [] },
      ),
    ).toThrowError("vortex.definition.invalid_compilation_request");
  });

  it("refuses incompatible action values and conditions during edit/save", () => {
    const base = sources.find(
      (source) => source.kind === "module" && source.key === "vortex.service_desk.knowledge",
    );
    if (!base || base.kind !== "module") throw new Error("Expected knowledge module source");

    const actionSource = structuredClone(base);
    const setField = actionSource.body.actions
      .flatMap((action) => action.effects)
      .find((effect) => effect.kind === "set_field");
    if (!setField || setField.kind !== "set_field") throw new Error("Expected set-field effect");
    setField.value = { source: "literal", value: true };
    expect(
      validateDefinitionSource(actionSource).failures.map((failure) => failure.ruleCode),
    ).toContain("vortex.definition.source_type_compatibility");

    const conditionSource = structuredClone(base);
    const condition = conditionSource.body.rules[0]?.condition;
    if (!condition || !("all" in condition)) throw new Error("Expected compound condition");
    condition.all[0] = { field: "public", operator: "equals", value: "yes" };
    expect(
      validateDefinitionSource(conditionSource).failures.map((failure) => failure.ruleCode),
    ).toContain("vortex.definition.source_type_compatibility");
  });

  it("does not permit authors to supply publication-owned metadata", () => {
    const source = structuredClone(sources.find((entry) => entry.kind === "module")!);
    const result = definitionSourceDocumentSchema.safeParse({
      ...source,
      version: "1.0.0",
      revision: 1,
      state: "published",
      content_fingerprint: "fixture:forbidden",
      published_by: "10000000-0000-4000-a000-000000000002",
    });
    expect(result.success).toBe(false);
  });

  it("refuses application-only rule effects in module source before compilation", () => {
    const module = structuredClone(sources.find((entry) => entry.kind === "module"));
    if (!module || module.kind !== "module") throw new Error("Expected module source");
    module.body.rules = [
      {
        id: "invalid_rule",
        key: "invalid_rule",
        record_type: module.body.record_types[0].key,
        trigger: "change",
        priority: 1,
        condition: { field: module.body.record_types[0].fields[0].key, operator: "is_not_empty" },
        effect: { kind: "start_background_work", workflow: "application_only" },
      },
    ];
    expect(validateDefinitionSource(module).valid).toBe(false);
    expect(() => compileDefinition(requestFor(module))).toThrowError(
      "vortex.definition.invalid_compilation_request",
    );
  });

  it("records source, resolution, fixed-default and system provenance", () => {
    const application = sources.find((source) => source.kind === "application")!;
    const output = compileDefinition(requestFor(application));
    expect(new Set(output.provenance.map((entry) => entry.origin))).toEqual(
      new Set(["source", "resolved", "fixed_default", "system_metadata"]),
    );
    expect(
      output.provenance.every((entry) => entry.canonicalPath.length > 0 || entry.sourcePath),
    ).toBe(true);
    expect(
      output.provenance.every(
        (entry) =>
          hasPath(output.canonical, entry.canonicalPath) &&
          (entry.sourcePath === undefined || hasPath(application, entry.sourcePath)),
      ),
    ).toBe(true);
    const sourceLeaves = new Set(leafPathKeys(application));
    const canonicalLeaves = new Set(leafPathKeys(output.canonical));
    expect(
      output.provenance.every(
        (entry) =>
          entry.sourcePath === undefined || sourceLeaves.has(JSON.stringify(entry.sourcePath)),
      ),
    ).toBe(true);
    expect(
      output.provenance.every(
        (entry) =>
          canonicalLeaves.has(JSON.stringify(entry.canonicalPath)) ||
          entry.ruleCode === "vortex.definition.semantic_transform" ||
          entry.ruleCode === "vortex.definition.immutable_resolution",
      ),
    ).toBe(true);
    expect(
      output.provenance
        .filter((entry) => (entry.sourcePath?.length ?? 0) >= 3)
        .every((entry) => JSON.stringify(entry.canonicalPath) !== JSON.stringify(["content"])),
    ).toBe(true);
    expect(
      output.provenance
        .filter((entry) => entry.canonicalPath[0] === "content" && entry.canonicalPath.length >= 3)
        .every((entry) => JSON.stringify(entry.sourcePath) !== JSON.stringify(["body"])),
    ).toBe(true);

    const overridden = structuredClone(application);
    if (overridden.kind !== "application") throw new Error("Expected application source");
    overridden.body.workflows[0]!.nodes[0]!.timeout_seconds = 42;
    const overriddenOutput = compileDefinition(requestFor(overridden));
    expect(
      overriddenOutput.provenance.find(
        (entry) =>
          entry.canonicalPath.at(-1) === "timeoutSeconds" &&
          entry.sourcePath?.at(-1) === "timeout_seconds",
      )?.origin,
    ).toBe("source");
  });

  it("keeps sibling dynamic-map provenance bound to its own resolved key", () => {
    const source = sources.find((entry) => entry.key === "vortex.crm.people");
    if (!source || source.kind !== "module") throw new Error("Expected people module source");
    const actionIndex = source.body.actions.findIndex((action) =>
      action.effects.some(
        (effect) =>
          effect.kind === "create_record" &&
          "values" in effect &&
          Object.keys(effect.values).includes("first_name") &&
          Object.keys(effect.values).includes("last_name"),
      ),
    );
    const effectIndex = source.body.actions[actionIndex]!.effects.findIndex(
      (effect) => effect.kind === "create_record",
    );
    const firstNameId = resolution.identities.find(
      (entry) =>
        entry.definitionKey === source.key &&
        entry.kind === "field" &&
        entry.alias === "first_name",
    )?.identifier;
    const lastNameId = resolution.identities.find(
      (entry) =>
        entry.definitionKey === source.key && entry.kind === "field" && entry.alias === "last_name",
    )?.identifier;
    if (!firstNameId || !lastNameId) throw new Error("Expected resolved field identities");

    const output = compileDefinition(requestFor(source));
    const firstNameSourcePrefix = [
      "body",
      "actions",
      actionIndex,
      "effects",
      effectIndex,
      "values",
      "first_name",
    ];
    const firstNameMappings = output.provenance.filter(
      (entry) =>
        entry.sourcePath
          ?.slice(0, firstNameSourcePrefix.length)
          .every((segment, index) => segment === firstNameSourcePrefix[index]) === true,
    );
    expect(firstNameMappings.some((entry) => entry.canonicalPath.includes(firstNameId))).toBe(true);
    expect(firstNameMappings.some((entry) => entry.canonicalPath.includes(lastNameId))).toBe(false);
  });

  it("never assigns transformed names, labels, triggers, or conditions to sibling leaves", () => {
    const moduleSource = sources.find(
      (source) => source.kind === "module" && source.body.actions.length > 0,
    );
    if (!moduleSource || moduleSource.kind !== "module") throw new Error("Expected module source");
    const moduleOutput = compileDefinition(requestFor(moduleSource));
    const recordName = moduleOutput.provenance.filter(
      (entry) =>
        JSON.stringify(entry.sourcePath) === JSON.stringify(["body", "record_types", 0, "name"]),
    );
    expect(recordName.map((entry) => entry.canonicalPath)).toEqual([
      ["content", "recordTypes", 0, "singularLabel"],
    ]);
    const actionLabel = moduleOutput.provenance.filter(
      (entry) =>
        JSON.stringify(entry.sourcePath) === JSON.stringify(["body", "actions", 0, "label"]),
    );
    expect(actionLabel.map((entry) => entry.canonicalPath)).toEqual([
      ["content", "actions", 0, "label"],
    ]);

    const applicationSource = sources.find(
      (source) => source.kind === "application" && source.body.workflows.length > 0,
    );
    if (!applicationSource || applicationSource.kind !== "application")
      throw new Error("Expected application source");
    const applicationOutput = compileDefinition(requestFor(applicationSource));
    const triggerEvent = applicationOutput.provenance.filter(
      (entry) =>
        JSON.stringify(entry.sourcePath) ===
        JSON.stringify(["body", "workflows", 0, "trigger", "event"]),
    );
    expect(triggerEvent.map((entry) => entry.canonicalPath)).toEqual([
      ["content", "workflows", 0, "trigger", "eventKey"],
    ]);

    const conditionModule = sources.find(
      (source) => source.kind === "module" && source.body.sharing_conditions.length > 0,
    );
    if (!conditionModule || conditionModule.kind !== "module")
      throw new Error("Expected module condition");
    const conditionOutput = compileDefinition(requestFor(conditionModule));
    const conditionField = conditionOutput.provenance.filter(
      (entry) =>
        JSON.stringify(entry.sourcePath) ===
        JSON.stringify(["body", "sharing_conditions", 0, "condition", "field"]),
    );
    expect(conditionField.map((entry) => entry.canonicalPath)).toEqual([
      ["content", "sharingConditions", 0, "condition", "left", "source"],
      ["content", "sharingConditions", 0, "condition", "left", "fieldId"],
    ]);
    expect(
      conditionField.some((entry) =>
        entry.canonicalPath.some((segment) => segment === "right" || segment === "operator"),
      ),
    ).toBe(false);
  });

  it("refuses sibling fields that resolve to one globally owned identifier", () => {
    const source = sources.find((entry) => entry.key === "vortex.crm.people");
    if (!source || source.kind !== "module") throw new Error("Expected people module source");
    const firstName = resolution.identities.find(
      (entry) =>
        entry.definitionKey === source.key &&
        entry.kind === "field" &&
        entry.alias === "first_name",
    );
    const lastNameIndex = resolution.identities.findIndex(
      (entry) =>
        entry.definitionKey === source.key && entry.kind === "field" && entry.alias === "last_name",
    );
    if (!firstName || lastNameIndex < 0) throw new Error("Expected resolved field identities");
    const identities = [...resolution.identities];
    identities[lastNameIndex] = {
      ...identities[lastNameIndex]!,
      identifier: firstName.identifier,
    };
    const collidingResolution = withResolutionFingerprint({ ...resolution, identities });
    expect(() =>
      compileDefinition({ ...requestFor(source), resolution: collidingResolution }),
    ).toThrowError("vortex.definition.duplicate_identity_resolution");
  });

  it("refuses identifiers reused by different snapshot owners", () => {
    const source = sources.find((entry) => entry.kind === "module")!;
    const definitions = [...resolution.definitions];
    definitions[1] = { ...definitions[1]!, rootId: definitions[0]!.rootId };
    const collidingDefinitions = withResolutionFingerprint({ ...resolution, definitions });
    expect(() =>
      compileDefinition({ ...requestFor(source), resolution: collidingDefinitions }),
    ).toThrowError("vortex.definition.duplicate_resolution");

    const firstIdentity = resolution.identities[0]!;
    const differentOwnerIndex = resolution.identities.findIndex(
      (entry) =>
        entry.definitionKey !== firstIdentity.definitionKey ||
        entry.scope !== firstIdentity.scope ||
        entry.kind !== firstIdentity.kind,
    );
    if (differentOwnerIndex < 0) throw new Error("Expected identities with different owners");
    const identities = [...resolution.identities];
    identities[differentOwnerIndex] = {
      ...identities[differentOwnerIndex]!,
      identifier: firstIdentity.identifier,
    };
    const collidingIdentities = withResolutionFingerprint({ ...resolution, identities });
    expect(() =>
      compileDefinition({ ...requestFor(source), resolution: collidingIdentities }),
    ).toThrowError("vortex.definition.duplicate_identity_resolution");

    const firstField = resolution.identities.find((entry) => entry.kind === "field")!;
    const siblingFieldIndex = resolution.identities.findIndex(
      (entry) =>
        entry.definitionKey === firstField.definitionKey &&
        entry.scope === firstField.scope &&
        entry.kind === firstField.kind &&
        entry.componentOwner !== firstField.componentOwner,
    );
    if (siblingFieldIndex < 0) throw new Error("Expected sibling field identities");
    const siblingCollision = [...resolution.identities];
    siblingCollision[siblingFieldIndex] = {
      ...siblingCollision[siblingFieldIndex]!,
      identifier: firstField.identifier,
    };
    expect(() =>
      compileDefinition({
        ...requestFor(source),
        resolution: withResolutionFingerprint({
          ...resolution,
          identities: siblingCollision,
        }),
      }),
    ).toThrowError("vortex.definition.duplicate_identity_resolution");

    const componentIndex = resolution.identities.findIndex((entry) => entry.kind !== "root");
    if (componentIndex < 0) throw new Error("Expected a contained component identity");
    const rootCollision = [...resolution.identities];
    rootCollision[componentIndex] = {
      ...rootCollision[componentIndex]!,
      identifier: resolution.definitions[0]!.rootId,
    };
    expect(() =>
      compileDefinition({
        ...requestFor(source),
        resolution: withResolutionFingerprint({ ...resolution, identities: rootCollision }),
      }),
    ).toThrowError("vortex.definition.duplicate_identity_resolution");
  });

  it("compiles every calculation expression without an implicit transform fallback", () => {
    const base = sources.find((source) => source.key === "vortex.crm.opportunities");
    if (!base || base.kind !== "module") throw new Error("Expected calculation fixture module");
    const cases = [
      {
        result_type: "decimal_number",
        expression: {
          operation: "numeric",
          numeric_operation: "multiply",
          operands: [
            { source: "field", field: "value" },
            { source: "literal", value: 2 },
          ],
        },
        expectedKind: "numeric",
      },
      {
        result_type: "yes_no",
        expression: {
          operation: "condition",
          condition: { field: "probability", operator: "greater_than", value: 50 },
        },
        expectedKind: "condition",
      },
      {
        result_type: "date",
        expression: {
          operation: "date_offset",
          date_field: "expected_close_date",
          amount: { source: "literal", value: 7 },
          unit: "days",
        },
        expectedKind: "date_offset",
      },
    ] as const;

    for (const example of cases) {
      const source = structuredClone(base);
      const field = source.body.record_types
        .flatMap((recordType) => recordType.fields)
        .find((candidate) => candidate.type === "calculation");
      if (!field || field.type !== "calculation") throw new Error("Expected calculation field");
      field.settings = {
        result_type: example.result_type,
        expression: example.expression,
      };
      const parsed = definitionSourceDocumentSchema.parse(source);
      const output = compileDefinition(requestFor(parsed));
      if (output.kind !== "module") throw new Error("Expected module output");
      expect(
        output.canonical.content.recordTypes
          .flatMap((recordType) => recordType.fields)
          .some(
            (candidate) =>
              candidate.type === "calculation" &&
              candidate.settings.expression.kind === example.expectedKind,
          ),
      ).toBe(true);
    }
  });

  it("compiles explicit field-to-field conditions without a hidden shorthand", () => {
    const source = structuredClone(
      sources.find((candidate) => candidate.key === "vortex.service_desk.cases")!,
    );
    if (source.kind !== "module") throw new Error("Expected module source");
    source.body.sharing_conditions[0]!.condition = {
      operator: "equals",
      left: { source: "field", field: "priority" },
      right: { source: "field", field: "status" },
    };
    const output = compileDefinition(requestFor(definitionSourceDocumentSchema.parse(source)));
    if (output.kind !== "module") throw new Error("Expected module output");
    const condition = output.canonical.content.sharingConditions[0]!.condition;
    if (condition.kind !== "comparison") throw new Error("Expected comparison condition");
    expect(condition.left).toEqual(
      expect.objectContaining({ source: "field", fieldId: expect.any(String) }),
    );
    expect(condition.right).toEqual(
      expect.objectContaining({ source: "field", fieldId: expect.any(String) }),
    );
    expect(condition.left).not.toEqual(condition.right);
  });

  it("compiles every workflow trigger through the closed transform catalogue", () => {
    const base = sources.find(
      (source) =>
        source.kind === "application" &&
        source.body.workflows.length > 0 &&
        source.body.pipelines.some((pipeline) =>
          pipeline.transitions.some((transition) => transition.action !== undefined),
        ) &&
        source.body.interfaces.some((definition) => definition.operations.length > 0),
    );
    if (!base || base.kind !== "application") throw new Error("Expected application source");
    const workflowKey = base.body.workflows[0]?.key;
    const actionKey = base.body.pipelines
      .flatMap((pipeline) => pipeline.transitions)
      .find((transition) => transition.action !== undefined)?.action;
    const interfaceOperation = base.body.interfaces[0]?.operations[0]?.key;
    if (!workflowKey || !actionKey || !interfaceOperation)
      throw new Error("Expected workflow trigger references");
    const triggerExecution = {
      inputs: [],
      condition: null,
      duplicate_protection: "required" as const,
    };
    const triggers = [
      {
        kind: "schedule",
        schedule: {
          cadence: "daily",
          interval: 1,
          time_zone: "Pacific/Auckland",
          minute: 0,
          hour: 9,
        },
        ...triggerExecution,
      },
      { kind: "incoming_message", message: "received", ...triggerExecution },
      { kind: "button", action: actionKey, ...triggerExecution },
      { kind: "interface", operation: interfaceOperation, ...triggerExecution },
      { kind: "workflow", workflow: workflowKey, ...triggerExecution },
    ] as const;

    for (const trigger of triggers) {
      const source = structuredClone(base);
      const workflow = source.body.workflows[0]!;
      const start = workflow.nodes.find((node) => node.type === "start");
      const stop = workflow.nodes.find((node) => node.type === "stop");
      if (!start || !stop) throw new Error("Expected reusable start and stop nodes");
      // The fixture workflow is event-record-aware.  Reduce it to a trigger-neutral
      // graph so every trigger kind is tested as a compilation transform on its own.
      workflow.trigger = trigger;
      workflow.nodes = [start, stop];
      workflow.edges = [[start.id, stop.id]];
      const parsed = definitionSourceDocumentSchema.parse(source);
      const triggerResolution = withResolutionFingerprint({
        ...resolution,
        identities: resolution.identities.filter(
          (identity) =>
            identity.definitionKey !== parsed.key ||
            identity.kind !== "workflow_node" ||
            identity.scope !== `workflow:${workflow.key}` ||
            [start.id, stop.id].includes(identity.alias),
        ),
      });
      const output = compileDefinition({ ...requestFor(parsed), resolution: triggerResolution });
      if (output.kind !== "application") throw new Error("Expected application output");
      expect(output.canonical.content.workflows[0]?.trigger.kind).toBe(trigger.kind);
    }

    const invalidSchedule = structuredClone(base);
    invalidSchedule.body.workflows[0]!.trigger = {
      kind: "schedule",
      schedule: {
        cadence: "daily",
        interval: 0,
        time_zone: "Pacific/Auckland",
        minute: 0,
        hour: 9,
      },
      ...triggerExecution,
    };
    expect(definitionSourceDocumentSchema.safeParse(invalidSchedule).success).toBe(false);
  });

  it("types every declared workflow producer output for its consumers and record target", () => {
    const recordTypeId = "record-type-a";
    const queries = new Map([["query-a", { recordType: { recordTypeId } }]]);
    for (const [nodeType, outputs] of Object.entries(workflowNodeOutputsByType)) {
      for (const output of outputs) {
        const producer = {
          nodeId: "producer",
          type: nodeType,
          config: {
            recordTypeId,
            queryId: "query-a",
            record: { source: "current_record" },
          },
        };
        const nodes = new Map([["producer", producer]]);
        const expectedTargets = output.target === "none" ? undefined : [recordTypeId];
        expect(
          workflowValueCompatible(
            { source: "node_output", nodeId: "producer", outputKey: output.key },
            output.type,
            new Map(),
            nodes,
            queries,
            recordTypeId,
            expectedTargets,
          ),
          `${nodeType}.${output.key}`,
        ).toBe(true);
        if (expectedTargets)
          expect(
            workflowValueCompatible(
              { source: "node_output", nodeId: "producer", outputKey: output.key },
              output.type,
              new Map(),
              nodes,
              queries,
              recordTypeId,
              ["record-type-b"],
            ),
          ).toBe(false);
      }
    }

    const formNodes = new Map([
      [
        "form",
        {
          type: "request_form",
          config: {
            outputs: [
              { key: "record", type: "record_reference", recordTypeIds: [recordTypeId] },
              { key: "approved", type: "yes_no" },
            ],
          },
        },
      ],
    ]);
    expect(
      workflowValueCompatible(
        { source: "node_output", nodeId: "form", outputKey: "record" },
        "record_reference",
        new Map(),
        formNodes,
        queries,
        undefined,
        [recordTypeId],
      ),
    ).toBe(true);
    expect(
      workflowValueCompatible(
        { source: "node_output", nodeId: "form", outputKey: "record" },
        "record_reference",
        new Map(),
        formNodes,
        queries,
        undefined,
        ["record-type-b"],
      ),
    ).toBe(false);

    const calculatedFields = new Map([
      ["calculated_text", { type: "calculation", settings: { resultType: "text" } }],
      ["calculated_boolean", { type: "calculation", settings: { resultType: "yes_no" } }],
      ["calculated_date", { type: "calculation", settings: { resultType: "date" } }],
    ]);
    expect(
      workflowValueCompatible(
        { source: "trigger_field", fieldId: "calculated_text" },
        "text",
        calculatedFields,
        new Map(),
        new Map(),
      ),
    ).toBe(true);
    expect(
      workflowValueCompatible(
        { source: "trigger_field", fieldId: "calculated_boolean" },
        "boolean",
        calculatedFields,
        new Map(),
        new Map(),
      ),
    ).toBe(true);
    expect(
      workflowValueCompatible(
        { source: "trigger_field", fieldId: "calculated_date" },
        "date",
        calculatedFields,
        new Map(),
        new Map(),
      ),
    ).toBe(true);
    expect(
      workflowValueCompatible(
        { source: "trigger_field", fieldId: "calculated_boolean" },
        "number",
        calculatedFields,
        new Map(),
        new Map(),
      ),
    ).toBe(false);
  });

  it("treats person links as organisation-account values at edit/save and publication", () => {
    const source = structuredClone(
      sources.find((candidate) => candidate.key === "vortex.service_desk.cases"),
    );
    if (!source || source.kind !== "module") throw new Error("Expected person-link module");
    const record = source.body.record_types.find((candidate) =>
      candidate.fields.some((field) => field.type === "link_to_person"),
    );
    const personField = record?.fields.find((field) => field.type === "link_to_person");
    const permission = source.body.permissions.find(
      (candidate) => candidate.record_type === record?.key,
    );
    if (!record || !personField || !permission) throw new Error("Expected person-link source data");
    source.body.actions.push({
      id: "person_link_current_actor",
      key: `${source.key}.${record.key}.assign_current_actor`,
      label: "Assign current actor",
      record_type: record.key,
      permission: permission.key,
      inputs: [],
      effects: [{ kind: "set_field", field: personField.key, value: { source: "current_actor" } }],
      shareable: false,
    });
    expect(validateDefinitionSource(source).valid).toBe(true);

    const wrongInput = structuredClone(source);
    const assignment = wrongInput.body.actions.find((action) =>
      action.effects.some(
        (effect) =>
          effect.kind === "set_field" &&
          effect.field === personField.key &&
          effect.value.source === "input",
      ),
    );
    const usedInput = assignment?.effects.find(
      (effect) => effect.kind === "set_field" && effect.value.source === "input",
    );
    if (
      !assignment ||
      !usedInput ||
      usedInput.kind !== "set_field" ||
      usedInput.value.source !== "input"
    )
      throw new Error("Expected account-input assignment");
    const inputIndex = assignment.inputs.findIndex((input) => input.key === usedInput.value.input);
    assignment.inputs[inputIndex] = {
      key: usedInput.value.input,
      label: "Wrong record",
      required: true,
      type: "record_reference",
      record_types: [`${source.key}:${record.key}`],
    };
    expect(validateDefinitionSource(wrongInput).valid).toBe(false);

    const requests = sources.map(requestFor);
    const outputs = structuredClone(requests.map(compileDefinition));
    const application = outputs.find(
      (output) =>
        output.kind === "application" &&
        output.artifact.definitionKey === "vortex.app.service_desk",
    );
    const personFieldIds = new Set(
      outputs
        .filter((output) => output.kind === "module")
        .flatMap((output) => output.canonical.content.recordTypes)
        .flatMap((candidate) => candidate.fields)
        .filter((field) => field.type === "link_to_person")
        .map((field) => field.fieldId),
    );
    if (!application || application.kind !== "application" || personFieldIds.size === 0)
      throw new Error("Expected compiled person-link workflow data");
    const createNode = application.canonical.content.workflows
      .flatMap((workflow) => workflow.nodes)
      .find(
        (node) =>
          node.type === "create_record" &&
          Object.entries(node.config.values).some(
            ([fieldId, value]) => personFieldIds.has(fieldId) && value.source === "current_actor",
          ),
      );
    if (!createNode || createNode.type !== "create_record")
      throw new Error("Expected current-actor create node");
    const personFieldId = Object.keys(createNode.config.values).find((fieldId) =>
      personFieldIds.has(fieldId),
    );
    if (!personFieldId) throw new Error("Expected current-actor person field");
    expect(createNode.config.values[personFieldId]).toEqual({ source: "current_actor" });
    expect(
      validateDefinitionSet(publicationContext(requests, outputs)).failures.map(
        (failure) => failure.ruleCode,
      ),
    ).not.toContain("vortex.definition.workflow_node_values");
    createNode.config.values[personFieldId] = { source: "current_record" };
    application.artifact.contentFingerprint = fingerprintCanonicalValue(
      application.canonical.content,
    );
    expect(
      validateDefinitionSet(publicationContext(requests, outputs)).failures.map(
        (failure) => failure.ruleCode,
      ),
    ).toContain("vortex.definition.workflow_node_values");
  });

  it("uses declared calculation result types in source and canonical consumers", () => {
    for (const resultType of ["text", "yes_no"] as const) {
      const source = structuredClone(
        sources.find(
          (candidate) =>
            candidate.kind === "module" &&
            candidate.body.record_types.some((record) =>
              record.fields.some(
                (field) =>
                  field.type === "calculation" && field.settings.result_type === resultType,
              ),
            ),
        ),
      );
      if (!source || source.kind !== "module")
        throw new Error(`Expected ${resultType} calculation module`);
      const record = source.body.record_types.find((candidate) =>
        candidate.fields.some(
          (field) => field.type === "calculation" && field.settings.result_type === resultType,
        ),
      );
      const calculation = record?.fields.find(
        (field) => field.type === "calculation" && field.settings.result_type === resultType,
      );
      if (resultType === "yes_no" && record)
        record.fields.push({
          id: "calculation_boolean_target",
          key: "calculation_boolean_target",
          type: "yes_no",
          label: "Calculation Boolean target",
          required: false,
          unique: false,
          filterable: true,
          sortable: true,
          personal_data: "none",
          public_display: "refused",
          settings: {},
        });
      const target = record?.fields.find((field) =>
        resultType === "text"
          ? field.type === "text"
          : field.type === "yes_no" && field.key !== calculation?.key,
      );
      const permission = source.body.permissions.find(
        (candidate) => candidate.record_type === record?.key,
      );
      if (!record || !calculation || !target || !permission)
        throw new Error(`Expected ${resultType} calculation consumer data`);
      source.body.actions.push({
        id: `calculation_${resultType}_consumer`,
        key: `${source.key}.${record.key}.use_${resultType}_calculation`,
        label: "Use calculated value",
        record_type: record.key,
        permission: permission.key,
        inputs: [],
        effects: [
          {
            kind: "set_field",
            field: target.key,
            value: { source: "subject_field", field: calculation.key },
          },
        ],
        shareable: false,
      });
      expect(validateDefinitionSource(source).valid).toBe(true);
    }

    const dateSource = structuredClone(
      sources.find((candidate) => candidate.key === "vortex.service_desk.cases"),
    );
    if (!dateSource || dateSource.kind !== "module") throw new Error("Expected date module");
    const dateRecord = dateSource.body.record_types.find((record) => record.key === "case");
    const dateFields = dateRecord?.fields.filter((field) => field.type === "date_time") ?? [];
    const datePermission = dateSource.body.permissions.find(
      (permission) => permission.record_type === dateRecord?.key,
    );
    if (!dateRecord || dateFields.length < 2 || !datePermission)
      throw new Error("Expected date calculation consumer data");
    dateRecord.fields.push({
      id: "calculated_date_consumer",
      key: "calculated_date_consumer",
      type: "calculation",
      label: "Calculated date consumer",
      required: true,
      unique: false,
      filterable: true,
      sortable: true,
      personal_data: "none",
      public_display: "refused",
      settings: {
        result_type: "date_time",
        expression: {
          operation: "date_offset",
          date_field: dateFields[0]!.key,
          amount: { source: "literal", value: 1 },
          unit: "days",
        },
      },
    });
    dateSource.body.actions.push({
      id: "calculation_date_consumer_action",
      key: `${dateSource.key}.${dateRecord.key}.use_date_calculation`,
      label: "Use date calculation",
      record_type: dateRecord.key,
      permission: datePermission.key,
      inputs: [],
      effects: [
        {
          kind: "set_field",
          field: dateFields[1]!.key,
          value: { source: "subject_field", field: "calculated_date_consumer" },
        },
      ],
      shareable: false,
    });
    expect(validateDefinitionSource(dateSource).valid).toBe(true);
  });

  it("normalizes action inputs and preserves record targets at edit/save and publish", () => {
    const scalarCases = [
      {
        moduleKey: "vortex.crm.opportunities",
        fieldType: "money",
        input: { key: "value", label: "Value", required: true, type: "number" as const },
      },
      {
        moduleKey: "vortex.crm.people",
        fieldType: "text",
        input: { key: "value", label: "Value", required: true, type: "text" as const },
      },
    ];
    for (const [index, scenario] of scalarCases.entries()) {
      const source = structuredClone(
        sources.find((candidate) => candidate.key === scenario.moduleKey),
      );
      if (!source || source.kind !== "module") throw new Error("Expected scalar action module");
      const record = source.body.record_types.find((candidate) =>
        candidate.fields.some((field) => field.type === scenario.fieldType),
      );
      const field = record?.fields.find((candidate) => candidate.type === scenario.fieldType);
      const permission = source.body.permissions.find(
        (candidate) => candidate.record_type === record?.key,
      );
      if (!record || !field || !permission) throw new Error("Expected scalar action data");
      source.body.actions.push({
        id: `scalar_input_${index}`,
        key: `${source.key}.${record.key}.scalar_input_${index}`,
        label: "Use scalar input",
        record_type: record.key,
        permission: permission.key,
        inputs: [scenario.input],
        effects: [
          {
            kind: "set_field",
            field: field.key,
            value: { source: "input", input: "value" },
          },
        ],
        shareable: false,
      });
      expect(validateDefinitionSource(source).valid).toBe(true);
      const wrong = structuredClone(source);
      wrong.body.actions.at(-1)!.inputs = [
        { key: "value", label: "Value", required: true, type: "boolean" },
      ];
      expect(validateDefinitionSource(wrong).valid).toBe(false);
    }

    const booleanSource = structuredClone(
      sources.find((candidate) => candidate.key === "vortex.service_desk.cases"),
    );
    if (!booleanSource || booleanSource.kind !== "module")
      throw new Error("Expected Boolean action module");
    const booleanRecord = booleanSource.body.record_types.find((record) => record.key === "case");
    const booleanPermission = booleanSource.body.permissions.find(
      (permission) => permission.record_type === booleanRecord?.key,
    );
    if (!booleanRecord || !booleanPermission) throw new Error("Expected Boolean action data");
    booleanRecord.fields.push({
      id: "boolean_action_target",
      key: "boolean_action_target",
      type: "yes_no",
      label: "Boolean action target",
      required: false,
      unique: false,
      filterable: true,
      sortable: true,
      personal_data: "none",
      public_display: "refused",
      settings: {},
    });
    booleanSource.body.actions.push({
      id: "boolean_input_action",
      key: `${booleanSource.key}.${booleanRecord.key}.boolean_input`,
      label: "Use Boolean input",
      record_type: booleanRecord.key,
      permission: booleanPermission.key,
      inputs: [{ key: "value", label: "Value", required: true, type: "boolean" }],
      effects: [
        {
          kind: "set_field",
          field: "boolean_action_target",
          value: { source: "input", input: "value" },
        },
      ],
      shareable: false,
    });
    expect(validateDefinitionSource(booleanSource).valid).toBe(true);

    const linkSource = structuredClone(booleanSource);
    const caseRecord = linkSource.body.record_types.find((record) => record.key === "case")!;
    const companyLink = caseRecord.fields.find(
      (field) => field.type === "link" && field.settings.target.includes("organisations"),
    );
    if (!companyLink || companyLink.type !== "link") throw new Error("Expected company link");
    linkSource.body.actions.push({
      id: "wrong_record_target_action",
      key: `${linkSource.key}.${caseRecord.key}.wrong_record_target`,
      label: "Wrong record target",
      record_type: caseRecord.key,
      permission: booleanPermission.key,
      inputs: [
        {
          key: "record",
          label: "Record",
          required: true,
          type: "record_reference",
          record_types: ["vortex.crm.people:contact"],
        },
      ],
      effects: [
        {
          kind: "set_field",
          field: companyLink.key,
          value: { source: "input", input: "record" },
        },
      ],
      shareable: false,
    });
    expect(validateDefinitionSource(linkSource).valid).toBe(false);

    const requests = sources.map(requestFor);
    const outputs = structuredClone(requests.map(compileDefinition));
    const organisationModule = outputs.find(
      (output) =>
        output.kind === "module" && output.artifact.definitionKey === "vortex.crm.organisations",
    );
    const peopleModule = outputs.find(
      (output) => output.kind === "module" && output.artifact.definitionKey === "vortex.crm.people",
    );
    if (
      !organisationModule ||
      organisationModule.kind !== "module" ||
      !peopleModule ||
      peopleModule.kind !== "module"
    )
      throw new Error("Expected record-target modules");
    const merge = organisationModule.canonical.content.actions.find((action) =>
      action.effects.some((effect) => effect.kind === "copy_relationships"),
    );
    const contactId = peopleModule.canonical.content.recordTypes.find(
      (record) => record.key === "contact",
    )?.recordTypeId;
    const targetInput = merge?.inputs.find((input) => input.type === "record_reference");
    if (!merge || !contactId || !targetInput || targetInput.type !== "record_reference")
      throw new Error("Expected copy-relationship target input");
    targetInput.recordTypes = [
      { moduleRootId: peopleModule.canonical.envelope.rootId, recordTypeId: contactId },
    ];
    organisationModule.artifact.contentFingerprint = fingerprintCanonicalValue(
      organisationModule.canonical.content,
    );
    expect(
      validateDefinitionSet(publicationContext(requests, outputs)).failures.map(
        (failure) => failure.ruleCode,
      ),
    ).toContain("vortex.definition.module_action_references");
  });

  it("requires publication history and checks active dependants", () => {
    const requests = sources.map(requestFor);
    const outputs = requests.map((request) => compileDefinition(request));
    expect(() =>
      compileDefinitionSet(requests, {
        publishedHistories: [
          ...publicationOptions.publishedHistories,
          publicationOptions.publishedHistories[0]!,
        ],
        activeDependants: [],
      }),
    ).toThrowError("vortex.definition.invalid_publication_context");
    expect(() =>
      compileDefinitionSet(requests, { publishedHistories: [], activeDependants: [] }),
    ).toThrowError("vortex.definition.prior_published_version_required");
    const candidate = outputs.find(
      (output) => output.kind === "module" && output.artifact.definitionKey === "vortex.crm.tags",
    );
    const dependant = outputs.find(
      (output) =>
        output.kind === "application" && output.artifact.definitionKey === "vortex.app.crm",
    );
    if (!candidate || candidate.kind !== "module" || !dependant)
      throw new Error("Expected compiled candidate and dependant");
    const comparison = compareDefinitionVersionImpact({
      kind: "module",
      history: [],
      candidate: candidate.canonical,
    });
    const candidateExactVersion =
      comparison.outcome === "no_change" ? comparison.currentVersion : comparison.assignedVersion;
    const dependantCheck = {
      definitionKind: "module" as const,
      definitionKey: candidate.artifact.definitionKey,
      definitionRootId: candidate.artifact.rootId,
      candidateExactVersion,
      candidateContentFingerprint: candidate.artifact.contentFingerprint,
      candidateResolutionFingerprint: candidate.artifact.resolutionFingerprint,
      dependantKey: dependant.artifact.definitionKey,
      dependantKind: dependant.kind,
      dependantRootId: dependant.artifact.rootId,
      dependantExactVersion: dependant.artifact.exactVersion,
      dependantContentFingerprint: dependant.artifact.contentFingerprint,
      acceptedVersion: { selection: "exact" as const, version: "2.0.0" },
      referencesValid: true,
      comparisonFingerprint: comparison.comparisonFingerprint,
    };
    expect(() =>
      compileDefinitionSet(requests, {
        publishedHistories: publicationOptions.publishedHistories,
        activeDependants: [
          {
            ...dependantCheck,
            referenceCheckFingerprint: fingerprintActiveDependantCheck(dependantCheck),
          },
        ],
      }),
    ).toThrowError("vortex.definition.active_dependants_compatible");
  });

  it("publishes one application against already-compiled immutable dependencies", () => {
    const application = sources.find((source) => source.key === "vortex.app.crm")!;
    const dependencies = sources
      .filter((source) => source.kind !== "application")
      .map((source) => compileDefinition(requestFor(source)));
    const outputs = compileDefinitionSet([requestFor(application)], {
      dependencyOutputs: dependencies,
      publishedHistories: [{ kind: "application", definitionKey: application.key, history: [] }],
      activeDependants: [],
    });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.dependencyOrder).toEqual(
      expect.arrayContaining([
        "vortex.crm.organisations",
        "vortex.connection.email",
        "vortex.connection.calendar",
      ]),
    );
    expect(outputs[0]?.resolvedDependencies.every((dependency) => dependency.exactVersion)).toBe(
      true,
    );
  });

  it("refuses publication when provenance omits a source or canonical leaf", () => {
    const application = sources.find((source) => source.kind === "application")!;
    const request = requestFor(application);
    const output = compileDefinition(request);
    const sourcePath = output.provenance.find((entry) => entry.sourcePath)?.sourcePath;
    expect(sourcePath).toBeDefined();
    const withoutSourceLeaf = {
      ...output,
      provenance: output.provenance.filter(
        (entry) => JSON.stringify(entry.sourcePath) !== JSON.stringify(sourcePath),
      ),
    };
    expect(
      validateDefinitionSet(publicationContext([request], [withoutSourceLeaf])).failures,
    ).toContainEqual(
      expect.objectContaining({ ruleCode: "vortex.definition.provenance_complete" }),
    );

    const canonicalPath = output.provenance.at(-1)!.canonicalPath;
    const withoutCanonicalLeaf = {
      ...output,
      provenance: output.provenance.filter(
        (entry) => JSON.stringify(entry.canonicalPath) !== JSON.stringify(canonicalPath),
      ),
    };
    expect(
      validateDefinitionSet(publicationContext([request], [withoutCanonicalLeaf])).failures,
    ).toContainEqual(
      expect.objectContaining({ ruleCode: "vortex.definition.provenance_complete" }),
    );
  });

  it("binds compiled artifacts and application dependencies to exact immutable content", () => {
    const requests = sources.map(requestFor);
    const outputs = requests.map(compileDefinition);
    const changedContent = structuredClone(outputs);
    const module = changedContent.find((output) => output.kind === "module");
    if (!module || module.kind !== "module") throw new Error("Expected module output");
    module.canonical.content.name = `${module.canonical.content.name} changed`;
    expect(
      validateDefinitionSet(publicationContext(requests, changedContent)).failures,
    ).toContainEqual(expect.objectContaining({ ruleCode: "vortex.definition.artifact_binding" }));

    const application = sources.find((source) => source.key === "vortex.app.crm")!;
    const dependencyOutputs = sources
      .filter((source) => source.kind !== "application")
      .map((source) => compileDefinition(requestFor(source)));
    const staleDependency = structuredClone(dependencyOutputs);
    const bindingKey =
      application.kind === "application" ? application.body.module_bindings[0]?.module : undefined;
    if (!bindingKey) throw new Error("Expected application module binding");
    const boundModule = staleDependency.find(
      (output) => output.kind === "module" && output.artifact.definitionKey === bindingKey,
    );
    if (!boundModule || boundModule.kind !== "module")
      throw new Error("Expected dependency module");
    boundModule.artifact.exactVersion = "9.0.0";
    const applicationRequest = requestFor(application);
    const dependencyBindingFailures = validateDefinitionSet({
      requests: [applicationRequest],
      outputs: [compileDefinition(applicationRequest)],
      dependencyOutputs: staleDependency,
      publishedHistories: [{ kind: "application", definitionKey: application.key, history: [] }],
      activeDependants: [],
    }).failures;
    expect(dependencyBindingFailures).toContainEqual(
      expect.objectContaining({ ruleCode: "vortex.definition.application_module_bindings" }),
    );
  });

  it("validates interface shapes against their exact action and query targets", () => {
    const requests = sources.map(requestFor);
    const outputs = requests.map(compileDefinition);
    const changed = structuredClone(outputs);
    const application = changed.find(
      (output) =>
        output.kind === "application" && output.artifact.definitionKey === "vortex.app.crm",
    );
    if (!application || application.kind !== "application")
      throw new Error("Expected CRM application output");
    const actionOperation = application.canonical.content.interfaces[0]?.operations.find(
      (operation) => operation.target.kind === "action",
    );
    if (!actionOperation) throw new Error("Expected action interface operation");
    actionOperation.inputShape = {};
    application.artifact.contentFingerprint = fingerprintCanonicalValue(
      application.canonical.content,
    );
    expect(validateDefinitionSet(publicationContext(requests, changed)).failures).toContainEqual(
      expect.objectContaining({ ruleCode: "vortex.definition.application_interface_shape" }),
    );
  });

  it("refuses calculation dependency cycles", () => {
    const requests = sources.map(requestFor);
    const outputs = requests.map(compileDefinition);
    const changed = structuredClone(outputs);
    const module = changed.find(
      (output) => output.kind === "module" && output.artifact.definitionKey === "vortex.crm.people",
    );
    if (!module || module.kind !== "module") throw new Error("Expected people module output");
    const calculated = module.canonical.content.recordTypes
      .flatMap((record) => record.fields)
      .find((field) => field.type === "calculation");
    if (!calculated || calculated.type !== "calculation")
      throw new Error("Expected calculation field");
    calculated.settings.dependencyFieldIds = [calculated.fieldId];
    module.artifact.contentFingerprint = fingerprintCanonicalValue(module.canonical.content);
    expect(validateDefinitionSet(publicationContext(requests, changed)).failures).toContainEqual(
      expect.objectContaining({ ruleCode: "vortex.definition.module_calculation_acyclic" }),
    );
  });

  it("executes the authored sharing publication tests and refuses undeclared inputs", () => {
    const module = sources.find((source) => source.key === "vortex.service_desk.cases")!;
    const output = compileDefinition(requestFor(module));
    if (output.kind !== "module") throw new Error("Expected module output");
    const saved = output.canonical.content.sharingConditions[0]!;
    for (const test of saved.publicationTests)
      expect(evaluateSavedSharingCondition(saved, test.fieldValues, test.parameters)).toBe(
        test.expected,
      );
    expect(() =>
      evaluateSavedSharingCondition(
        saved,
        { ...saved.publicationTests[0]!.fieldValues, unknown: "private" },
        saved.publicationTests[0]!.parameters,
      ),
    ).toThrowError("vortex.definition.sharing_condition_input_refused");
  });

  it("refuses missing identities, incompatible versions and dependency cycles", () => {
    const module = sources.find((source) => source.kind === "module")!;
    const missingResolution = withResolutionFingerprint({
      ...resolution,
      identities: resolution.identities.filter(
        (entry) => !(entry.definitionKey === module.key && entry.kind === "record_type"),
      ),
    });
    expect(() =>
      compileDefinition({ ...requestFor(module), resolution: missingResolution }),
    ).toThrowError("vortex.definition.missing_identity");
    try {
      compileDefinition({ ...requestFor(module), resolution: missingResolution });
    } catch (error) {
      expect(error).toBeInstanceOf(DefinitionCompilationError);
      expect((error as DefinitionCompilationError).location).toEqual(
        expect.objectContaining({
          documentKind: "module",
          documentKey: module.key,
          segments: expect.arrayContaining([
            { kind: "module", key: module.key },
            expect.objectContaining({ kind: "record_type" }),
          ]),
        }),
      );
    }

    expect(() =>
      compileDefinition({
        ...requestFor(module),
        resolution: { ...resolution, identities: resolution.identities.slice(1) },
      }),
    ).toThrowError("vortex.definition.invalid_resolution_fingerprint");

    const application = structuredClone(sources.find((source) => source.kind === "application")!);
    if (application.kind !== "application") throw new Error("Expected application source");
    application.body.module_bindings[0]!.version = { selection: "exact", version: "9.0.0" };
    expect(() => compileDefinition(requestFor(application))).toThrowError(
      "vortex.definition.incompatible_version",
    );

    const lowerBoundApplication = structuredClone(
      sources.find((source) => source.kind === "application")!,
    );
    if (lowerBoundApplication.kind !== "application")
      throw new Error("Expected application source");
    lowerBoundApplication.body.module_bindings[0]!.version = {
      selection: "allowed_range",
      expression: "^1.1.0",
    };
    expect(() => compileDefinition(requestFor(lowerBoundApplication))).toThrowError(
      "vortex.definition.incompatible_version",
    );

    const cyclicSources = structuredClone(sources);
    const organizationModule = cyclicSources.find(
      (source) => source.key === "vortex.crm.organisations",
    )!;
    if (organizationModule.kind !== "module") throw new Error("Expected module source");
    organizationModule.body.dependencies.push({
      dependency_key: "activities",
      module: "vortex.crm.activities",
      version: { selection: "exact", version: "1.0.0" },
    });
    expect(() =>
      compileDefinitionSet(cyclicSources.map(requestFor), publicationOptions),
    ).toThrowError("vortex.definition.dependency_cycle");
  });

  it("locates unresolved nested fields, actions, workflows, and dependencies safely", () => {
    const capture = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        if (error instanceof DefinitionCompilationError) return error;
        throw error;
      }
      throw new Error("Expected compilation refusal");
    };
    const module = sources.find(
      (source) => source.kind === "module" && source.body.dependencies.length > 0,
    );
    if (!module || module.kind !== "module") throw new Error("Expected dependent module");

    for (const kind of ["field", "action"] as const) {
      const identity = resolution.identities.find(
        (entry) => entry.definitionKey === module.key && entry.kind === kind,
      );
      if (!identity) throw new Error(`Expected ${kind} identity`);
      const changed = withResolutionFingerprint({
        ...resolution,
        identities: resolution.identities.filter((entry) => entry !== identity),
      });
      const error = capture(() =>
        compileDefinition({ ...requestFor(module), resolution: changed }),
      );
      expect(error.location?.segments).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind, key: identity.alias })]),
      );
    }

    const application = sources.find(
      (source) => source.kind === "application" && source.body.workflows.length > 0,
    );
    if (!application || application.kind !== "application")
      throw new Error("Expected workflow application");
    const workflowNode = resolution.identities.find(
      (entry) => entry.definitionKey === application.key && entry.kind === "workflow_node",
    );
    if (!workflowNode) throw new Error("Expected workflow node identity");
    const workflowResolution = withResolutionFingerprint({
      ...resolution,
      identities: resolution.identities.filter((entry) => entry !== workflowNode),
    });
    const workflowError = capture(() =>
      compileDefinition({ ...requestFor(application), resolution: workflowResolution }),
    );
    expect(workflowError.location?.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "workflow" }),
        { kind: "workflow_node", key: workflowNode.alias },
      ]),
    );

    const dependencyKey = module.body.dependencies[0]!.module;
    const dependencyResolution = withResolutionFingerprint({
      ...resolution,
      definitions: resolution.definitions.filter((entry) => entry.key !== dependencyKey),
    });
    const dependencyError = capture(() =>
      compileDefinition({ ...requestFor(module), resolution: dependencyResolution }),
    );
    expect(dependencyError.location?.segments).toEqual(
      expect.arrayContaining([{ kind: "module", key: dependencyKey }]),
    );
    expect(JSON.stringify(dependencyError)).not.toContain("submitted");
  });

  it("finds unreachable workflow nodes and unsafe public fields", () => {
    const application = structuredClone(
      sources.find((source) => source.key === "vortex.app.service_desk")!,
    );
    if (application.kind !== "application") throw new Error("Expected application source");
    application.body.workflows[0]!.edges.shift();
    const requests = sources
      .filter((source) => source.key !== application.key)
      .map(requestFor)
      .concat(requestFor(application));
    const outputs = requests.map(compileDefinition);
    const result = validateDefinitionSet(publicationContext(requests, outputs));
    expect(result.valid).toBe(false);
    expect(result.failures.map((entry) => entry.ruleCode)).toContain(
      "vortex.definition.workflow_reachable",
    );

    const unsafeOutputs = structuredClone(outputs);
    const compiledApplication = unsafeOutputs.find(
      (output) =>
        output.kind === "application" && output.canonical.envelope.key === application.key,
    );
    if (!compiledApplication || compiledApplication.kind !== "application")
      throw new Error("Expected compiled application");
    const publicPage = compiledApplication.canonical.content.pages.find(
      (page) => page.type === "public",
    );
    if (!publicPage || publicPage.type !== "public") throw new Error("Expected public page");
    const foreignField = resolution.identities.find(
      (entry) =>
        entry.definitionKey === "vortex.service_desk.cases" &&
        entry.kind === "field" &&
        entry.alias === "description",
    )!;
    publicPage.publicFieldIds.push(foreignField.identifier);
    const unsafe = validateDefinitionSet(publicationContext(requests, unsafeOutputs));
    expect(unsafe.failures.map((entry) => entry.ruleCode)).toContain(
      "vortex.definition.application_public_surface",
    );
  });

  it("refuses stale module references and unresolved workflow triggers", () => {
    const requests = sources.map(requestFor);
    const outputs = requests.map(compileDefinition);
    const invalidModuleOutputs = structuredClone(outputs);
    const module = invalidModuleOutputs.find((output) => output.kind === "module");
    if (!module || module.kind !== "module") throw new Error("Expected module output");
    module.canonical.content.recordTypes[0]!.customActionIds.push(
      "ffffffff-ffff-4fff-afff-ffffffffffff",
    );
    expect(
      validateDefinitionSet(publicationContext(requests, invalidModuleOutputs)).failures.map(
        (entry) => entry.ruleCode,
      ),
    ).toContain("vortex.definition.module_record_references");

    const invalidTriggerOutputs = structuredClone(outputs);
    const application = invalidTriggerOutputs.find((output) => output.kind === "application");
    if (!application || application.kind !== "application")
      throw new Error("Expected application output");
    const eventWorkflow = application.canonical.content.workflows.find(
      (workflow) => workflow.trigger.kind === "event",
    );
    if (!eventWorkflow || eventWorkflow.trigger.kind !== "event")
      throw new Error("Expected event workflow");
    eventWorkflow.trigger.eventKey = "vortex.unknown.event";
    expect(
      validateDefinitionSet(publicationContext(requests, invalidTriggerOutputs)).failures.map(
        (entry) => entry.ruleCode,
      ),
    ).toContain("vortex.definition.workflow_trigger_reference");

    const invalidNodeOutputs = structuredClone(outputs);
    const workflowApplication = invalidNodeOutputs.find(
      (output) =>
        output.kind === "application" && output.artifact.definitionKey === "vortex.app.crm",
    );
    if (!workflowApplication || workflowApplication.kind !== "application")
      throw new Error("Expected workflow application");
    const createRecordNode = workflowApplication.canonical.content.workflows
      .flatMap((workflow) => workflow.nodes)
      .find((node) => node.type === "create_record");
    if (!createRecordNode || createRecordNode.type !== "create_record")
      throw new Error("Expected create-record node");
    const firstFieldId = Object.keys(createRecordNode.config.values)[0]!;
    createRecordNode.config.values[firstFieldId] = { source: "literal", value: true };
    workflowApplication.artifact.contentFingerprint = fingerprintCanonicalValue(
      workflowApplication.canonical.content,
    );
    expect(
      validateDefinitionSet(publicationContext(requests, invalidNodeOutputs)).failures.map(
        (entry) => entry.ruleCode,
      ),
    ).toContain("vortex.definition.workflow_node_values");
  });

  describe("page record scope and public-surface regression coverage", () => {
    const compiledRequests = () => sources.map(requestFor);
    const compiledOutputs = (requests: ReturnType<typeof requestFor>[]) =>
      requests.map(compileDefinition);
    const applicationOutput = (outputs: ReturnType<typeof compileDefinition>[], key: string) => {
      const output = outputs.find(
        (candidate) => candidate.kind === "application" && candidate.artifact.definitionKey === key,
      );
      if (!output || output.kind !== "application")
        throw new Error(`Expected compiled application ${key}`);
      return output;
    };
    const validationFailures = (
      outputs: ReturnType<typeof compileDefinition>[],
      requests: ReturnType<typeof requestFor>[],
    ) =>
      validateDefinitionSet(publicationContext(requests, outputs)).failures.map(
        (entry) => entry.ruleCode,
      );
    const refreshArtifact = (output: ReturnType<typeof compileDefinition>) => {
      output.artifact.contentFingerprint = fingerprintCanonicalValue(output.canonical.content);
    };

    it("refuses a page query or form commit action whose subject record differs from the page", () => {
      const requests = compiledRequests();
      const outputs = structuredClone(compiledOutputs(requests));
      const application = applicationOutput(outputs, "vortex.app.service_desk");
      const pages = application.canonical.content.pages;
      const queries = application.canonical.content.queries;
      const list = pages.find((page) => page.type === "list" && page.recordType !== undefined);
      if (!list || list.type !== "list") throw new Error("Expected a list page");
      const foreignQuery = queries.find(
        (query) => query.recordType.recordTypeId !== list.recordType.recordTypeId,
      );
      if (!foreignQuery) throw new Error("Expected a query for a different record type");
      list.queryId = foreignQuery.queryId;
      refreshArtifact(application);
      expect(validationFailures(outputs, requests)).toContain(
        "vortex.definition.application_page_query",
      );

      const formRequests = compiledRequests();
      const formOutputs = structuredClone(compiledOutputs(formRequests));
      const formApplication = applicationOutput(formOutputs, "vortex.app.service_desk");
      const form = formApplication.canonical.content.pages.find((page) => page.type === "form");
      if (!form || form.type !== "form") throw new Error("Expected a form page");
      const boundRoots = new Set(
        formApplication.canonical.content.moduleBindings.map((binding) => binding.moduleRootId),
      );
      const foreignAction = formOutputs
        .filter(
          (output) => output.kind === "module" && boundRoots.has(output.canonical.envelope.rootId),
        )
        .flatMap((output) => output.canonical.content.actions)
        .find((action) => action.subjectRecordTypeId !== form.recordType.recordTypeId);
      if (!foreignAction) throw new Error("Expected a custom action for a different record type");
      form.commitActionKey = foreignAction.key;
      refreshArtifact(formApplication);
      expect(validationFailures(formOutputs, formRequests)).toContain(
        "vortex.definition.application_page_references",
      );
    });

    it("refuses block field, query, action, and record references outside its page record", () => {
      const scenarios = [
        { control: "field_picker", kind: "field_reference" },
        { control: "data_reading", kind: "query_reference" },
        { control: "action_picker", kind: "action_reference" },
        { control: "record_picker", kind: "record_reference" },
      ] as const;

      for (const scenario of scenarios) {
        const requests = compiledRequests();
        const outputs = structuredClone(compiledOutputs(requests));
        const application = applicationOutput(outputs, "vortex.app.service_desk");
        const page = application.canonical.content.pages.find(
          (candidate) => candidate.type === "detail",
        );
        if (!page || page.type !== "detail") throw new Error("Expected a detail page");
        const foreignQuery = application.canonical.content.queries.find(
          (query) => query.recordType.recordTypeId !== page.recordType.recordTypeId,
        );
        if (!foreignQuery) throw new Error("Expected foreign query data");
        const foreignModule = outputs.find(
          (output) =>
            output.kind === "module" &&
            output.canonical.envelope.rootId === foreignQuery.recordType.moduleRootId,
        );
        if (!foreignModule || foreignModule.kind !== "module")
          throw new Error("Expected a bound module for the foreign query");
        const foreignRecord = foreignModule.canonical.content.recordTypes.find(
          (record) => record.recordTypeId === foreignQuery.recordType.recordTypeId,
        );
        if (!foreignRecord) throw new Error("Expected foreign record data");
        const foreignField = foreignRecord.fields[0]!;
        const foreignAction = foreignModule.canonical.content.actions.find(
          (action) => action.subjectRecordTypeId === foreignRecord.recordTypeId,
        );
        if (!foreignAction) throw new Error("Expected an action for a foreign record");
        const placement = page.blocks[0]!;
        const registration = application.canonical.content.blockRegistrations.find(
          (block) => block.blockId === placement.blockId,
        );
        if (!registration) throw new Error("Expected placed block registration");
        registration.settings = [
          { key: "record_scope", control: scenario.control, required: true },
        ];
        placement.settings = {
          record_scope:
            scenario.kind === "field_reference"
              ? { kind: "field_reference", fieldId: foreignField.fieldId }
              : scenario.kind === "query_reference"
                ? { kind: "query_reference", queryId: foreignQuery.queryId }
                : scenario.kind === "action_reference"
                  ? { kind: "action_reference", actionKey: foreignAction.key }
                  : {
                      kind: "record_reference",
                      recordType: foreignQuery.recordType,
                      recordId: "90000000-0000-4000-a000-000000000001",
                    },
        };
        refreshArtifact(application);
        expect(validationFailures(outputs, requests)).toContain(
          "vortex.definition.application_block_references",
        );
      }
    });

    it("refuses public pages that expose non-public query controls, permissions, or actions", () => {
      const queryProperties = ["filter", "groupByFieldIds", "aggregates", "sort"] as const;
      for (const property of queryProperties) {
        const requests = compiledRequests();
        const outputs = structuredClone(compiledOutputs(requests));
        const application = applicationOutput(outputs, "vortex.app.service_desk");
        const page = application.canonical.content.pages.find(
          (candidate) => candidate.type === "public",
        );
        if (!page || page.type !== "public" || !page.recordType)
          throw new Error("Expected a public record page");
        const record = outputs
          .filter((output) => output.kind === "module")
          .flatMap((output) => output.canonical.content.recordTypes)
          .find((candidate) => candidate.recordTypeId === page.recordType!.recordTypeId);
        const privateField = record?.fields.find(
          (field) => !page.publicFieldIds.includes(field.fieldId),
        );
        const query = application.canonical.content.queries.find(
          (candidate) => candidate.recordType.recordTypeId === page.recordType!.recordTypeId,
        );
        if (!privateField || !query) throw new Error("Expected a private field and local query");
        const placement = page.blocks[0]!;
        placement.queryId = query.queryId;
        query.selectedFieldIds = [page.publicFieldIds[0]!];
        if (property === "filter")
          query.filter = {
            kind: "comparison",
            operator: "equals",
            left: { source: "field", fieldId: privateField.fieldId },
            right: { source: "literal", value: "draft" },
          };
        if (property === "groupByFieldIds") query.groupByFieldIds = [privateField.fieldId];
        if (property === "aggregates")
          query.aggregates = [
            { operation: "maximum", fieldId: privateField.fieldId, alias: "private" },
          ];
        if (property === "sort")
          query.sort = [{ fieldId: privateField.fieldId, direction: "ascending" }];
        refreshArtifact(application);
        expect(validationFailures(outputs, requests)).toContain(
          "vortex.definition.application_public_surface",
        );
      }

      const permissionRequests = compiledRequests();
      const permissionOutputs = structuredClone(compiledOutputs(permissionRequests));
      const permissionApplication = applicationOutput(permissionOutputs, "vortex.app.service_desk");
      const publicPage = permissionApplication.canonical.content.pages.find(
        (candidate) => candidate.type === "public",
      );
      const administrativePermission = permissionApplication.canonical.content.permissions.find(
        (permission) => permission.administrative,
      );
      if (!publicPage || !administrativePermission)
        throw new Error("Expected public page and admin permission");
      publicPage.accessPermissionKey = administrativePermission.key;
      refreshArtifact(permissionApplication);
      expect(validationFailures(permissionOutputs, permissionRequests)).toContain(
        "vortex.definition.application_public_surface",
      );

      const subjectRequests = compiledRequests();
      const subjectOutputs = structuredClone(compiledOutputs(subjectRequests));
      const subjectApplication = applicationOutput(subjectOutputs, "vortex.app.service_desk");
      const subjectPage = subjectApplication.canonical.content.pages.find(
        (candidate) => candidate.type === "public",
      );
      if (!subjectPage || subjectPage.type !== "public") throw new Error("Expected public page");
      subjectPage.publicActionKey = "vortex.service_desk.cases.case.add_public_comment";
      refreshArtifact(subjectApplication);
      expect(validationFailures(subjectOutputs, subjectRequests)).toContain(
        "vortex.definition.application_public_surface",
      );

      const effectRequests = compiledRequests();
      const effectOutputs = structuredClone(compiledOutputs(effectRequests));
      const effectApplication = applicationOutput(effectOutputs, "vortex.app.service_desk");
      const effectPage = effectApplication.canonical.content.pages.find(
        (candidate) => candidate.type === "public",
      );
      if (!effectPage || effectPage.type !== "public" || !effectPage.recordType)
        throw new Error("Expected public page");
      const effectRecord = effectOutputs
        .filter((output) => output.kind === "module")
        .flatMap((output) => output.canonical.content.recordTypes)
        .find((candidate) => candidate.recordTypeId === effectPage.recordType!.recordTypeId);
      const privateEffectField = effectRecord?.fields.find(
        (field) => !effectPage.publicFieldIds.includes(field.fieldId),
      );
      if (!privateEffectField) throw new Error("Expected non-public field");
      const actionKey = "vortex.service_desk.knowledge.article.public_mutation";
      effectApplication.canonical.content.actions.push({
        actionId: "90000000-0000-4000-a000-000000000002",
        key: actionKey,
        label: "Public mutation",
        subjectRecordTypeId: effectRecord!.recordTypeId,
        permissionKey: "application.service_desk.open",
        sharing: "allowed",
        inputs: [],
        effects: [
          {
            kind: "set_field",
            fieldId: privateEffectField.fieldId,
            value: { source: "literal", value: "published" },
          },
        ],
      });
      effectPage.publicActionKey = actionKey;
      refreshArtifact(effectApplication);
      expect(validationFailures(effectOutputs, effectRequests)).toContain(
        "vortex.definition.application_public_surface",
      );

      const crossRecordRequests = compiledRequests();
      const crossRecordOutputs = structuredClone(compiledOutputs(crossRecordRequests));
      const crossRecordApplication = applicationOutput(
        crossRecordOutputs,
        "vortex.app.service_desk",
      );
      const crossRecordPage = crossRecordApplication.canonical.content.pages.find(
        (candidate) => candidate.type === "public",
      );
      if (!crossRecordPage || crossRecordPage.type !== "public" || !crossRecordPage.recordType)
        throw new Error("Expected public page");
      const differentRecordModule = crossRecordOutputs.find(
        (output) =>
          output.kind === "module" &&
          output.canonical.content.recordTypes.some(
            (record) =>
              record.recordTypeId !== crossRecordPage.recordType!.recordTypeId &&
              record.fields.some(
                (field) => field.publicDisplay === "allowed" && field.type === "text",
              ),
          ),
      );
      if (!differentRecordModule || differentRecordModule.kind !== "module")
        throw new Error("Expected another module with a public text field");
      const differentRecord = differentRecordModule.canonical.content.recordTypes.find(
        (record) =>
          record.recordTypeId !== crossRecordPage.recordType!.recordTypeId &&
          record.fields.some((field) => field.publicDisplay === "allowed" && field.type === "text"),
      );
      const differentPublicField = differentRecord?.fields.find(
        (field) => field.publicDisplay === "allowed" && field.type === "text",
      );
      if (!differentRecord || !differentPublicField)
        throw new Error("Expected another record with a public text field");
      const crossRecordActionKey = "vortex.example.record.cross_record_public_create";
      crossRecordApplication.canonical.content.actions.push({
        actionId: "90000000-0000-4000-a000-000000000004",
        key: crossRecordActionKey,
        label: "Cross-record public create",
        subjectRecordTypeId: crossRecordPage.recordType.recordTypeId,
        permissionKey: "application.service_desk.open",
        sharing: "allowed",
        inputs: [],
        effects: [
          {
            kind: "create_record",
            recordType: {
              moduleRootId: differentRecordModule.canonical.envelope.rootId,
              recordTypeId: differentRecord.recordTypeId,
            },
            values: {
              [differentPublicField.fieldId]: { source: "literal", value: "Public value" },
            },
          },
        ],
      });
      crossRecordPage.publicActionKey = crossRecordActionKey;
      refreshArtifact(crossRecordApplication);
      expect(validationFailures(crossRecordOutputs, crossRecordRequests)).toContain(
        "vortex.definition.application_public_surface",
      );
    });

    it("accepts only public-safe action interfaces", () => {
      const preparePublicActionInterface = () => {
        const requests = compiledRequests();
        const outputs = structuredClone(compiledOutputs(requests));
        const application = applicationOutput(outputs, "vortex.app.service_desk");
        const operation = application.canonical.content.interfaces
          .flatMap((definition) => definition.operations)
          .find((candidate) => candidate.target.kind === "action");
        if (!operation || operation.target.kind !== "action")
          throw new Error("Expected an action interface");
        const module = outputs.find(
          (candidate) =>
            candidate.kind === "module" &&
            candidate.canonical.content.actions.some(
              (action) => action.key === operation.target.key,
            ),
        );
        if (!module || module.kind !== "module") throw new Error("Expected target module");
        const originalAction = module.canonical.content.actions.find(
          (action) => action.key === operation.target.key,
        );
        const subject = module.canonical.content.recordTypes.find(
          (record) => record.recordTypeId === originalAction?.subjectRecordTypeId,
        );
        const publicTextField = subject?.fields.find(
          (field) => field.publicDisplay === "allowed" && field.type === "text",
        );
        const privateTextField = subject?.fields.find(
          (field) => field.publicDisplay !== "allowed" && field.type === "formatted_text",
        );
        if (!originalAction || !subject || !publicTextField || !privateTextField)
          throw new Error("Expected public-interface action test data");

        const actionKey = "vortex.example.record.public_update";
        application.canonical.content.actions.push({
          actionId: "90000000-0000-4000-a000-000000000003",
          key: actionKey,
          label: "Public update",
          subjectRecordTypeId: subject.recordTypeId,
          permissionKey: originalAction.permissionKey,
          sharing: "allowed",
          inputs: [{ key: "body", label: "Body", required: true, type: "text" }],
          effects: [
            {
              kind: "set_field",
              fieldId: publicTextField.fieldId,
              value: { source: "input", inputKey: "body" },
            },
          ],
        });
        operation.target.key = actionKey;
        operation.visibility = "public";
        operation.authentication = "public";
        operation.permissionKey = originalAction.permissionKey;
        refreshArtifact(application);
        return { requests, outputs, application, operation, privateTextField };
      };

      const safe = preparePublicActionInterface();
      expect(validationFailures(safe.outputs, safe.requests)).not.toContain(
        "vortex.definition.application_interface_exposure",
      );

      const privateEffect = preparePublicActionInterface();
      const action = privateEffect.application.canonical.content.actions.find(
        (candidate) => candidate.key === privateEffect.operation.target.key,
      );
      if (!action) throw new Error("Expected public interface action");
      action.effects = [
        {
          kind: "set_field",
          fieldId: privateEffect.privateTextField.fieldId,
          value: { source: "literal", value: "not public" },
        },
      ];
      refreshArtifact(privateEffect.application);
      expect(validationFailures(privateEffect.outputs, privateEffect.requests)).toContain(
        "vortex.definition.application_interface_exposure",
      );

      const administrative = preparePublicActionInterface();
      const administrativePermission =
        administrative.application.canonical.content.permissions.find(
          (permission) => permission.administrative,
        );
      if (!administrativePermission) throw new Error("Expected administrative permission");
      administrative.operation.permissionKey = administrativePermission.key;
      refreshArtifact(administrative.application);
      expect(validationFailures(administrative.outputs, administrative.requests)).toContain(
        "vortex.definition.application_interface_exposure",
      );
    });

    it("checks the complete field surface of a public query interface", () => {
      const requests = compiledRequests();
      const outputs = structuredClone(compiledOutputs(requests));
      const application = applicationOutput(outputs, "vortex.app.service_desk");
      const operation = application.canonical.content.interfaces
        .flatMap((definition) => definition.operations)
        .find((candidate) => candidate.target.kind === "query");
      if (!operation || operation.target.kind !== "query")
        throw new Error("Expected query interface");
      const query = application.canonical.content.queries.find(
        (candidate) => candidate.key === operation.target.key,
      );
      const outputBinding = Object.values(operation.outputShape).find(
        (field) => field.targetBinding.kind === "query_field",
      );
      if (!query || !outputBinding || outputBinding.targetBinding.kind !== "query_field")
        throw new Error("Expected query interface binding");
      const record = outputs
        .filter((output) => output.kind === "module")
        .flatMap((output) => output.canonical.content.recordTypes)
        .find((candidate) => candidate.recordTypeId === query.recordType.recordTypeId);
      const privateField = record?.fields.find(
        (field) => field.publicDisplay !== "allowed" && field.type === "formatted_text",
      );
      if (!record || !privateField) throw new Error("Expected private query field");
      query.selectedFieldIds = [outputBinding.targetBinding.fieldId];
      query.filter = null;
      query.groupByFieldIds = [];
      query.aggregates = [];
      query.sort = [];
      operation.visibility = "public";
      operation.authentication = "public";
      refreshArtifact(application);
      expect(validationFailures(outputs, requests)).not.toContain(
        "vortex.definition.application_interface_exposure",
      );

      query.filter = {
        kind: "comparison",
        operator: "equals",
        left: { source: "field", fieldId: privateField.fieldId },
        right: { source: "literal", value: "private" },
      };
      refreshArtifact(application);
      expect(validationFailures(outputs, requests)).toContain(
        "vortex.definition.application_interface_exposure",
      );
    });

    it("refuses relationship copying from a public page without an explicit relationship contract", () => {
      const requests = compiledRequests();
      const outputs = structuredClone(compiledOutputs(requests));
      const application = applicationOutput(outputs, "vortex.app.service_desk");
      const page = application.canonical.content.pages.find(
        (candidate) => candidate.type === "public",
      );
      if (!page || page.type !== "public" || !page.recordType)
        throw new Error("Expected a public record page");
      const module = outputs.find(
        (output) =>
          output.kind === "module" &&
          output.canonical.content.recordTypes.some(
            (candidate) => candidate.recordTypeId === page.recordType!.recordTypeId,
          ),
      );
      if (!module || module.kind !== "module") throw new Error("Expected the page module");
      const record = module.canonical.content.recordTypes.find(
        (candidate) => candidate.recordTypeId === page.recordType!.recordTypeId,
      );
      if (!record) throw new Error("Expected the page record");
      const relationshipFieldId = "90000000-0000-4000-a000-000000000007";
      const relationshipId = "90000000-0000-4000-a000-000000000008";
      record.fields.push({
        fieldId: relationshipFieldId,
        key: "related_record",
        label: "Related record",
        type: "link",
        required: false,
        unique: false,
        filterable: true,
        sortable: true,
        personalData: "none",
        publicDisplay: "refused",
        settings: {
          target: {
            moduleRootId: module.canonical.envelope.rootId,
            recordTypeId: record.recordTypeId,
          },
          reverseKey: "related_records",
          onParentDelete: "empty_optional",
        },
      });
      record.relationships.push({
        relationshipId,
        key: "related_record",
        fromRecordTypeId: record.recordTypeId,
        fromFieldId: relationshipFieldId,
        toRecordType: {
          moduleRootId: module.canonical.envelope.rootId,
          recordTypeId: record.recordTypeId,
        },
        cardinality: "many_to_one",
        onParentDelete: "empty_optional",
      });
      refreshArtifact(module);
      const actionKey = "vortex.example.record.public_relationship_copy";
      application.canonical.content.actions.push({
        actionId: "90000000-0000-4000-a000-000000000005",
        key: actionKey,
        label: "Public relationship copy",
        subjectRecordTypeId: record.recordTypeId,
        permissionKey: page.accessPermissionKey,
        sharing: "allowed",
        inputs: [
          {
            key: "target",
            label: "Target",
            required: true,
            type: "record_reference",
            recordTypes: [record.recordTypeId],
          },
        ],
        effects: [
          {
            kind: "copy_relationships",
            relationshipIds: [relationshipId],
            targetInputKey: "target",
          },
        ],
      });
      page.publicActionKey = actionKey;
      refreshArtifact(application);
      expect(validationFailures(outputs, requests)).toContain(
        "vortex.definition.application_public_surface",
      );
    });
  });

  describe("independent review regression coverage", () => {
    const refreshArtifact = (output: ReturnType<typeof compileDefinition>) => {
      output.artifact.contentFingerprint = fingerprintCanonicalValue(
        output.kind === "connection_type" ? output.canonical : output.canonical.content,
      );
    };
    const failureCodes = (
      requests: ReturnType<typeof requestFor>[],
      outputs: ReturnType<typeof compileDefinition>[],
    ) =>
      validateDefinitionSet(publicationContext(requests, outputs)).failures.map(
        (entry) => entry.ruleCode,
      );

    it("binds the application dependency manifest one-for-one to its declared bindings", () => {
      const requests = sources.map(requestFor);
      const baseline = requests.map(compileDefinition);
      const application = baseline.find(
        (output) =>
          output.kind === "application" && output.artifact.definitionKey === "vortex.app.crm",
      );
      if (!application || application.kind !== "application")
        throw new Error("Expected application output");

      const missing = structuredClone(baseline);
      const missingApplication = missing.find(
        (output) =>
          output.kind === "application" &&
          output.artifact.definitionKey === application.artifact.definitionKey,
      );
      if (!missingApplication || missingApplication.kind !== "application")
        throw new Error("Expected application output");
      missingApplication.resolvedDependencies = missingApplication.resolvedDependencies.slice(1);
      expect(failureCodes(requests, missing)).toContain(
        "vortex.definition.application_dependency_manifest",
      );

      const duplicated = structuredClone(baseline);
      const duplicatedApplication = duplicated.find(
        (output) =>
          output.kind === "application" &&
          output.artifact.definitionKey === application.artifact.definitionKey,
      );
      if (!duplicatedApplication || duplicatedApplication.kind !== "application")
        throw new Error("Expected application output");
      duplicatedApplication.resolvedDependencies.push(
        structuredClone(duplicatedApplication.resolvedDependencies[0]!),
      );
      expect(failureCodes(requests, duplicated)).toContain(
        "vortex.definition.application_dependency_manifest",
      );

      const substituted = structuredClone(baseline);
      const substitutedApplication = substituted.find(
        (output) =>
          output.kind === "application" &&
          output.artifact.definitionKey === application.artifact.definitionKey,
      );
      if (!substitutedApplication || substitutedApplication.kind !== "application")
        throw new Error("Expected application output");
      substitutedApplication.resolvedDependencies[0]!.exactVersion = "9.9.9";
      expect(failureCodes(requests, substituted)).toContain(
        "vortex.definition.application_dependency_manifest",
      );
    });

    it("requires declared application dependency ranges to accept their resolved versions", () => {
      const requests = sources.map(requestFor);
      const baseline = requests.map(compileDefinition);

      const moduleMismatch = structuredClone(baseline);
      const moduleApplication = moduleMismatch.find(
        (output) =>
          output.kind === "application" && output.artifact.definitionKey === "vortex.app.crm",
      );
      if (!moduleApplication || moduleApplication.kind !== "application")
        throw new Error("Expected application output");
      moduleApplication.canonical.content.moduleBindings[0]!.version = {
        selection: "exact",
        version: "9.9.9",
      };
      refreshArtifact(moduleApplication);
      expect(failureCodes(requests, moduleMismatch)).toContain(
        "vortex.definition.application_module_bindings",
      );

      const connectionMismatch = structuredClone(baseline);
      const connectionApplication = connectionMismatch.find(
        (output) =>
          output.kind === "application" && output.artifact.definitionKey === "vortex.app.crm",
      );
      if (!connectionApplication || connectionApplication.kind !== "application")
        throw new Error("Expected application output");
      connectionApplication.canonical.content.connectionBindings[0]!.version = {
        selection: "exact",
        version: "9.9.9",
      };
      refreshArtifact(connectionApplication);
      expect(failureCodes(requests, connectionMismatch)).toContain(
        "vortex.definition.application_connection_operations",
      );
    });

    it("requires each connection binding to use the exact complete caller-snapshot artifact", () => {
      const requests = sources.map(requestFor);
      const baseline = requests.map(compileDefinition);
      const application = baseline.find(
        (output) =>
          output.kind === "application" && output.artifact.definitionKey === "vortex.app.crm",
      );
      if (!application || application.kind !== "application")
        throw new Error("Expected application output");
      const binding = application.canonical.content.connectionBindings[0]!;

      const missing = baseline.filter(
        (output) =>
          output.kind !== "connection_type" || output.artifact.rootId !== binding.connectionTypeId,
      );
      expect(failureCodes(requests, missing)).toContain(
        "vortex.definition.application_connection_operations",
      );

      const foreignSnapshot = structuredClone(baseline);
      const foreignConnection = foreignSnapshot.find(
        (output) =>
          output.kind === "connection_type" && output.artifact.rootId === binding.connectionTypeId,
      );
      if (!foreignConnection || foreignConnection.kind !== "connection_type")
        throw new Error("Expected connection output");
      foreignConnection.artifact.resolutionFingerprint =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      foreignConnection.resolutionFingerprint = foreignConnection.artifact.resolutionFingerprint;
      expect(failureCodes(requests, foreignSnapshot)).toContain(
        "vortex.definition.application_connection_operations",
      );

      const incompleteOperations = structuredClone(baseline);
      const incompleteConnection = incompleteOperations.find(
        (output) =>
          output.kind === "connection_type" && output.artifact.rootId === binding.connectionTypeId,
      );
      if (!incompleteConnection || incompleteConnection.kind !== "connection_type")
        throw new Error("Expected connection output");
      incompleteConnection.canonical.operations = incompleteConnection.canonical.operations.filter(
        (operation) => operation.key !== binding.requiredOperationKeys[0],
      );
      refreshArtifact(incompleteConnection);
      expect(failureCodes(requests, incompleteOperations)).toContain(
        "vortex.definition.application_connection_operations",
      );
    });

    it("refuses a recomputed resolution snapshot with an invented root identity", () => {
      const source = sources.find((entry) => entry.kind === "module");
      if (!source || source.kind !== "module") throw new Error("Expected module source");
      const invented = withResolutionFingerprint({
        ...resolution,
        identities: [
          ...resolution.identities,
          {
            definitionKey: source.key,
            scope: "document",
            kind: "root" as const,
            alias: "invented_root_alias",
            identifier: "90000000-0000-4000-a000-000000000006",
            componentOwner: "root",
          },
        ],
      });
      expect(() => compileDefinition({ ...requestFor(source), resolution: invented })).toThrowError(
        "vortex.definition.duplicate_identity_resolution",
      );
    });

    it("refuses a dependency artifact that is self-consistent but bound to a different caller snapshot", () => {
      const application = sources.find((source) => source.key === "vortex.app.crm");
      if (!application || application.kind !== "application")
        throw new Error("Expected application fixture");
      const dependencies = sources
        .filter((source) => source.kind !== "application")
        .map((source) => compileDefinition(requestFor(source)));
      const callerResolution = withResolutionFingerprint({
        ...resolution,
        definitions: [...resolution.definitions].reverse(),
      });
      const callerRequest = { ...requestFor(application), resolution: callerResolution };

      expect(
        dependencies.every(
          (dependency) => dependency.artifact.resolutionFingerprint === resolution.fingerprint,
        ),
      ).toBe(true);
      expect(callerResolution.fingerprint).not.toBe(resolution.fingerprint);
      const callerSnapshotFailures = validateDefinitionSet({
        requests: [callerRequest],
        outputs: [compileDefinition(callerRequest)],
        dependencyOutputs: dependencies,
        publishedHistories: [{ kind: "application", definitionKey: application.key, history: [] }],
        activeDependants: [],
      }).failures;
      expect(callerSnapshotFailures).toContainEqual(
        expect.objectContaining({ ruleCode: "vortex.definition.application_module_bindings" }),
      );
    });

    it("binds a connection canonical version to its exact artifact version", () => {
      const requests = sources.map(requestFor);
      const outputs = structuredClone(requests.map(compileDefinition));
      const connection = outputs.find((output) => output.kind === "connection_type");
      if (!connection || connection.kind !== "connection_type")
        throw new Error("Expected connection output");
      connection.canonical.version = "9.9.9";
      refreshArtifact(connection);
      expect(failureCodes(requests, outputs)).toContain("vortex.definition.artifact_binding");
    });

    it("binds a child workflow trigger bidirectionally to its exact parent node", () => {
      const requests = sources.map(requestFor);
      const baseline = structuredClone(requests.map(compileDefinition));
      expect(failureCodes(requests, baseline)).not.toContain(
        "vortex.definition.workflow_trigger_reference",
      );
      expect(failureCodes(requests, baseline)).not.toContain(
        "vortex.definition.workflow_node_values",
      );

      const mismatchedTrigger = structuredClone(baseline);
      const triggerApplication = mismatchedTrigger.find(
        (output) =>
          output.kind === "application" &&
          output.artifact.definitionKey === "vortex.app.service_desk",
      );
      if (!triggerApplication || triggerApplication.kind !== "application")
        throw new Error("Expected workflow application");
      const child = triggerApplication.canonical.content.workflows.find(
        (workflow) => workflow.trigger.kind === "workflow",
      );
      const unrelated = triggerApplication.canonical.content.workflows.find(
        (workflow) =>
          workflow.workflowId !== child?.workflowId &&
          workflow.workflowId !==
            (child?.trigger.kind === "workflow" ? child.trigger.workflowId : ""),
      );
      if (!child || child.trigger.kind !== "workflow" || !unrelated)
        throw new Error("Expected parent-triggered and unrelated workflows");
      child.trigger.workflowId = unrelated.workflowId;
      refreshArtifact(triggerApplication);
      expect(failureCodes(requests, mismatchedTrigger)).toContain(
        "vortex.definition.workflow_trigger_reference",
      );

      const eventTarget = structuredClone(baseline);
      const nodeApplication = eventTarget.find(
        (output) =>
          output.kind === "application" &&
          output.artifact.definitionKey === "vortex.app.service_desk",
      );
      if (!nodeApplication || nodeApplication.kind !== "application")
        throw new Error("Expected workflow application");
      const parent = nodeApplication.canonical.content.workflows.find((workflow) =>
        workflow.nodes.some((node) => node.type === "start_workflow"),
      );
      const startChild = parent?.nodes.find((node) => node.type === "start_workflow");
      const eventWorkflow = nodeApplication.canonical.content.workflows.find(
        (workflow) => workflow.trigger.kind === "event",
      );
      if (!parent || !startChild || startChild.type !== "start_workflow" || !eventWorkflow)
        throw new Error("Expected parent node and event workflow");
      startChild.config.workflowId = eventWorkflow.workflowId;
      refreshArtifact(nodeApplication);
      expect(failureCodes(requests, eventTarget)).toContain(
        "vortex.definition.workflow_node_values",
      );
    });

    it("retains the same failure at two distinct component locations", () => {
      const requests = sources.map(requestFor);
      const outputs = structuredClone(requests.map(compileDefinition));
      const application = outputs.find(
        (output) =>
          output.kind === "application" &&
          output.artifact.definitionKey === "vortex.app.service_desk",
      );
      if (!application || application.kind !== "application")
        throw new Error("Expected workflow application");
      const affected = application.canonical.content.workflows.slice(0, 2);
      for (const workflow of affected)
        workflow.nodes = workflow.nodes.filter((node) => node.type !== "start");
      refreshArtifact(application);
      const failures = validateDefinitionSet(publicationContext(requests, outputs)).failures.filter(
        (failure) => failure.ruleCode === "vortex.definition.workflow_single_start",
      );
      expect(failures).toHaveLength(2);
      expect(new Set(failures.map((failure) => JSON.stringify(failure.location))).size).toBe(2);
    });

    it("refuses a sibling identity collision even when the snapshot spoofs the same component owner", () => {
      const source = sources.find((entry) => entry.key === "vortex.crm.people");
      if (!source || source.kind !== "module") throw new Error("Expected module fixture");
      const firstOwner = resolution.identities.find(
        (entry) =>
          entry.definitionKey === source.key &&
          entry.kind === "field" &&
          entry.alias === "fld_contact_first",
      );
      const siblingOwner = resolution.identities.find(
        (entry) =>
          entry.definitionKey === source.key &&
          entry.kind === "field" &&
          entry.alias === "fld_contact_last",
      );
      if (!firstOwner || !siblingOwner) throw new Error("Expected sibling field identities");
      const spoofedResolution = withResolutionFingerprint({
        ...resolution,
        identities: resolution.identities.map((entry) =>
          entry.definitionKey === source.key &&
          entry.kind === "field" &&
          entry.componentOwner === siblingOwner.componentOwner
            ? {
                ...entry,
                componentOwner: firstOwner.componentOwner,
                identifier: firstOwner.identifier,
              }
            : entry,
        ),
      });

      expect(() =>
        compileDefinition({ ...requestFor(source), resolution: spoofedResolution }),
      ).toThrowError("vortex.definition.duplicate_identity_resolution");

      const actionSource = sources.find((entry) => entry.key === "vortex.service_desk.cases");
      if (!actionSource || actionSource.kind !== "module")
        throw new Error("Expected action module fixture");
      const actionOwners = [
        ...new Set(
          resolution.identities
            .filter((entry) => entry.definitionKey === actionSource.key && entry.kind === "action")
            .map((entry) => entry.componentOwner),
        ),
      ].slice(0, 2);
      const sharedActionIdentifier = resolution.identities.find(
        (entry) =>
          entry.definitionKey === actionSource.key &&
          entry.kind === "action" &&
          entry.componentOwner === actionOwners[0],
      )?.identifier;
      if (actionOwners.length !== 2 || !sharedActionIdentifier)
        throw new Error("Expected sibling action identities");
      const ordinaryStringSpoof = withResolutionFingerprint({
        ...resolution,
        identities: resolution.identities.map((entry) =>
          entry.definitionKey === actionSource.key &&
          entry.kind === "action" &&
          actionOwners.includes(entry.componentOwner)
            ? { ...entry, componentOwner: "case", identifier: sharedActionIdentifier }
            : entry,
        ),
      });
      expect(() =>
        compileDefinition({ ...requestFor(actionSource), resolution: ordinaryStringSpoof }),
      ).toThrowError("vortex.definition.duplicate_identity_resolution");

      const navigationSource = sources.find((entry) => entry.key === "vortex.app.crm");
      if (!navigationSource || navigationSource.kind !== "application")
        throw new Error("Expected navigation application fixture");
      const nestedNavigation = resolution.identities.filter(
        (entry) =>
          entry.definitionKey === navigationSource.key &&
          entry.kind === "navigation_item" &&
          ["nav_crm_companies", "nav_crm_contacts"].includes(entry.alias),
      );
      if (nestedNavigation.length !== 2)
        throw new Error("Expected sibling nested navigation identities");
      const nestedOwnerSpoof = withResolutionFingerprint({
        ...resolution,
        identities: resolution.identities.map((entry) =>
          entry.definitionKey === navigationSource.key &&
          nestedNavigation.some((navigation) => navigation.componentOwner === entry.componentOwner)
            ? {
                ...entry,
                componentOwner: "Customers",
                identifier: nestedNavigation[0]!.identifier,
              }
            : entry,
        ),
      });
      expect(() =>
        compileDefinition({ ...requestFor(navigationSource), resolution: nestedOwnerSpoof }),
      ).toThrowError("vortex.definition.duplicate_identity_resolution");
    });

    it("enforces link targets and file references in workflow node inputs", () => {
      const requests = sources.map(requestFor);
      const linkOutputs = structuredClone(requests.map(compileDefinition));
      const linkApplication = linkOutputs.find(
        (output) =>
          output.kind === "application" &&
          output.artifact.definitionKey === "vortex.app.service_desk",
      );
      if (!linkApplication || linkApplication.kind !== "application")
        throw new Error("Expected application output");
      const cleanupWorkflow = linkApplication.canonical.content.workflows.find(
        (workflow) => workflow.key === "service_desk_resolution_cleanup",
      );
      const knowledgeModule = linkOutputs.find(
        (output) =>
          output.kind === "module" &&
          output.artifact.definitionKey === "vortex.service_desk.knowledge",
      );
      const articleCaseRecord =
        knowledgeModule?.kind === "module"
          ? knowledgeModule.canonical.content.recordTypes.find(
              (candidate) => candidate.key === "article_case",
            )
          : undefined;
      const articleCase = cleanupWorkflow?.nodes.find(
        (node) =>
          node.type === "create_record" &&
          node.config.recordTypeId === articleCaseRecord?.recordTypeId,
      );
      if (
        !cleanupWorkflow ||
        !articleCase ||
        articleCase.type !== "create_record" ||
        !articleCaseRecord
      )
        throw new Error("Expected article-case create node");
      const articleFieldId = Object.keys(articleCase.config.values).find((fieldId) => {
        return (
          articleCaseRecord.fields.find((field) => field.fieldId === fieldId)?.key === "article"
        );
      });
      if (!articleFieldId) throw new Error("Expected article link field");
      articleCase.config.values[articleFieldId] = { source: "current_record" };
      refreshArtifact(linkApplication);
      expect(failureCodes(requests, linkOutputs)).toContain(
        "vortex.definition.workflow_node_values",
      );

      for (const workflowKey of ["crm_opportunity_won", "crm_data_hygiene"] as const) {
        const fileOutputs = structuredClone(requests.map(compileDefinition));
        const fileApplication = fileOutputs.find(
          (output) =>
            output.kind === "application" && output.artifact.definitionKey === "vortex.app.crm",
        );
        if (!fileApplication || fileApplication.kind !== "application")
          throw new Error("Expected application output");
        const workflow = fileApplication.canonical.content.workflows.find(
          (candidate) => candidate.key === workflowKey,
        );
        const fileNode = workflow?.nodes.find(
          (node) => node.type === "attach_file" || node.type === "move_file",
        );
        if (!workflow || !fileNode || !["attach_file", "move_file"].includes(fileNode.type))
          throw new Error("Expected file workflow node");
        fileNode.config.file = { source: "current_record" };
        refreshArtifact(fileApplication);
        expect(failureCodes(requests, fileOutputs), workflowKey).toContain(
          "vortex.definition.workflow_node_values",
        );
      }
    });

    it("resolves non-count totals in the relationship source record and rejects invalid aggregates", () => {
      const totalSource = structuredClone(
        sources.find((source) => source.key === "vortex.crm.tags"),
      );
      if (!totalSource || totalSource.kind !== "module") throw new Error("Expected tags module");
      const ownerRecordIndex = totalSource.body.record_types.findIndex(
        (record) => record.key === "tag",
      );
      const ownerRecord = totalSource.body.record_types[ownerRecordIndex];
      const totalFieldIndex =
        ownerRecord?.fields.findIndex((field) => field.type === "total") ?? -1;
      const totalField = ownerRecord?.fields[totalFieldIndex];
      if (!ownerRecord || !totalField || totalField.type !== "total")
        throw new Error("Expected total field");
      totalField.settings = {
        relationship: "vortex.crm.tags:record_tag.tag",
        operation: "maximum",
        result_type: "date_time",
        field: "assigned_at",
        filter: { field: "assigned_by", operator: "is_not_empty" },
      };
      const parsedTotalSource = definitionSourceDocumentSchema.parse(totalSource);
      const requests = sources
        .filter((source) => source.key !== parsedTotalSource.key)
        .map(requestFor)
        .concat(requestFor(parsedTotalSource));
      const outputs = requests.map(compileDefinition);
      expect(failureCodes(requests, outputs)).not.toContain(
        "vortex.definition.module_field_references",
      );
      const compiled = outputs.find(
        (output) => output.kind === "module" && output.artifact.definitionKey === totalSource.key,
      );
      if (!compiled || compiled.kind !== "module") throw new Error("Expected compiled module");
      const compiledTotal = compiled.canonical.content.recordTypes
        .find((record) => record.key === "tag")
        ?.fields.find((field) => field.type === "total");
      const aggregateRecord = compiled.canonical.content.recordTypes.find(
        (record) => record.key === "record_tag",
      );
      const aggregateField = aggregateRecord?.fields.find((field) => field.key === "assigned_at");
      if (!compiledTotal || compiledTotal.type !== "total" || !aggregateField)
        throw new Error("Expected compiled aggregate field");
      expect(compiledTotal.settings.fieldId).toBe(aggregateField.fieldId);
      expect(compiled.provenance).toContainEqual(
        expect.objectContaining({
          sourcePath: [
            "body",
            "record_types",
            ownerRecordIndex,
            "fields",
            totalFieldIndex,
            "settings",
            "field",
          ],
        }),
      );

      const wrongRecord = structuredClone(parsedTotalSource);
      const wrongRecordTotal = wrongRecord.body.record_types
        .find((record) => record.key === "tag")
        ?.fields.find((field) => field.type === "total");
      if (!wrongRecordTotal || wrongRecordTotal.type !== "total")
        throw new Error("Expected total field");
      wrongRecordTotal.settings.field = "name";
      expect(() => compileDefinition(requestFor(wrongRecord))).toThrowError(
        "vortex.definition.missing_identity",
      );

      const wrongType = structuredClone(parsedTotalSource);
      const wrongTypeTotal = wrongType.body.record_types
        .find((record) => record.key === "tag")
        ?.fields.find((field) => field.type === "total");
      if (!wrongTypeTotal || wrongTypeTotal.type !== "total")
        throw new Error("Expected total field");
      wrongTypeTotal.settings.operation = "sum";
      wrongTypeTotal.settings.result_type = "decimal_number";
      const wrongTypeRequests = sources
        .filter((source) => source.key !== wrongType.key)
        .map(requestFor)
        .concat(requestFor(wrongType));
      expect(failureCodes(wrongTypeRequests, wrongTypeRequests.map(compileDefinition))).toContain(
        "vortex.definition.module_field_references",
      );

      const wrongDirectionOutputs = structuredClone(outputs);
      const wrongDirectionModule = wrongDirectionOutputs.find(
        (output) => output.kind === "module" && output.artifact.definitionKey === totalSource.key,
      );
      if (!wrongDirectionModule || wrongDirectionModule.kind !== "module")
        throw new Error("Expected compiled module");
      const wrongDirectionTotal = wrongDirectionModule.canonical.content.recordTypes
        .find((record) => record.key === "tag")
        ?.fields.find((field) => field.type === "total");
      const outgoingRelationship = wrongDirectionModule.canonical.content.recordTypes
        .find((record) => record.key === "record_tag")
        ?.relationships.find((relationship) => relationship.key === "record");
      if (!wrongDirectionTotal || wrongDirectionTotal.type !== "total" || !outgoingRelationship)
        throw new Error("Expected total and outgoing relationship");
      wrongDirectionTotal.settings = {
        relationshipId: outgoingRelationship.relationshipId,
        operation: "count",
        resultType: "whole_number",
      };
      refreshArtifact(wrongDirectionModule);
      expect(failureCodes(requests, wrongDirectionOutputs)).toContain(
        "vortex.definition.module_field_references",
      );
    });

    it("acknowledges only the exact message that triggered the workflow", () => {
      const requests = sources.map(requestFor);
      const baseline = requests.map(compileDefinition);
      const application = baseline.find(
        (output) =>
          output.kind === "application" &&
          output.artifact.definitionKey === "vortex.app.service_desk",
      );
      if (!application || application.kind !== "application")
        throw new Error("Expected application output");
      const incoming = application.canonical.content.workflows.find(
        (workflow) => workflow.trigger.kind === "incoming_message",
      );
      const acknowledge = incoming?.nodes.find((node) => node.type === "acknowledge_message");
      if (!incoming || !acknowledge || acknowledge.type !== "acknowledge_message")
        throw new Error("Expected incoming-message acknowledgement");
      expect(failureCodes(requests, baseline)).not.toContain(
        "vortex.definition.workflow_node_values",
      );

      const mismatched = structuredClone(baseline);
      const mismatchedApplication = mismatched.find(
        (output) =>
          output.kind === "application" &&
          output.artifact.definitionKey === "vortex.app.service_desk",
      );
      if (!mismatchedApplication || mismatchedApplication.kind !== "application")
        throw new Error("Expected application output");
      const mismatchedNode = mismatchedApplication.canonical.content.workflows
        .find((workflow) => workflow.trigger.kind === "incoming_message")
        ?.nodes.find((node) => node.type === "acknowledge_message");
      if (!mismatchedNode || mismatchedNode.type !== "acknowledge_message")
        throw new Error("Expected acknowledgement node");
      mismatchedNode.config.messageKey = "delivery_status";
      refreshArtifact(mismatchedApplication);
      expect(failureCodes(requests, mismatched)).toContain(
        "vortex.definition.workflow_node_values",
      );

      const eventTriggered = structuredClone(baseline);
      const eventApplication = eventTriggered.find(
        (output) =>
          output.kind === "application" &&
          output.artifact.definitionKey === "vortex.app.service_desk",
      );
      if (!eventApplication || eventApplication.kind !== "application")
        throw new Error("Expected application output");
      const eventWorkflow = eventApplication.canonical.content.workflows.find(
        (workflow) => workflow.trigger.kind === "event",
      );
      const changedWorkflow = eventApplication.canonical.content.workflows.find(
        (workflow) => workflow.trigger.kind === "incoming_message",
      );
      if (!eventWorkflow || !changedWorkflow)
        throw new Error("Expected event and message workflows");
      changedWorkflow.trigger = structuredClone(eventWorkflow.trigger);
      refreshArtifact(eventApplication);
      expect(failureCodes(requests, eventTriggered)).toContain(
        "vortex.definition.workflow_node_values",
      );
    });

    it("waits only on a date-time field from the workflow current record", () => {
      const requests = sources.map(requestFor);
      const baseline = requests.map(compileDefinition);
      const application = baseline.find(
        (output) =>
          output.kind === "application" &&
          output.artifact.definitionKey === "vortex.app.service_desk",
      );
      if (!application || application.kind !== "application")
        throw new Error("Expected application output");
      const workflow = application.canonical.content.workflows.find((candidate) =>
        candidate.nodes.some((node) => node.type === "wait_until"),
      );
      const wait = workflow?.nodes.find((node) => node.type === "wait_until");
      if (!workflow || !wait || wait.type !== "wait_until")
        throw new Error("Expected wait-until node");
      const waitRecordId = baseline
        .filter((output) => output.kind === "module")
        .flatMap((output) => output.canonical.content.recordTypes)
        .find((record) =>
          record.fields.some((field) => field.fieldId === wait.config.dateTimeFieldId),
        )?.recordTypeId;
      if (!waitRecordId) throw new Error("Expected wait record type");
      expect(failureCodes(requests, baseline)).not.toContain(
        "vortex.definition.workflow_node_references",
      );

      const wrongRecord = structuredClone(baseline);
      const wrongRecordApplication = wrongRecord.find(
        (output) =>
          output.kind === "application" &&
          output.artifact.definitionKey === "vortex.app.service_desk",
      );
      if (!wrongRecordApplication || wrongRecordApplication.kind !== "application")
        throw new Error("Expected application output");
      const wrongRecordWait = wrongRecordApplication.canonical.content.workflows
        .find((candidate) => candidate.nodes.some((node) => node.type === "wait_until"))
        ?.nodes.find((node) => node.type === "wait_until");
      const foreignDateTime = wrongRecord
        .filter((output) => output.kind === "module")
        .flatMap((output) => output.canonical.content.recordTypes)
        .filter((record) => record.recordTypeId !== waitRecordId)
        .flatMap((record) => record.fields)
        .find(
          (field) => field.type === "date_time" && field.fieldId !== wait.config.dateTimeFieldId,
        );
      if (!wrongRecordWait || wrongRecordWait.type !== "wait_until" || !foreignDateTime)
        throw new Error("Expected wait and foreign date-time field");
      wrongRecordWait.config.dateTimeFieldId = foreignDateTime.fieldId;
      refreshArtifact(wrongRecordApplication);
      expect(failureCodes(requests, wrongRecord)).toContain(
        "vortex.definition.workflow_node_references",
      );

      const noCurrentRecord = structuredClone(baseline);
      const noRecordApplication = noCurrentRecord.find(
        (output) =>
          output.kind === "application" &&
          output.artifact.definitionKey === "vortex.app.service_desk",
      );
      if (!noRecordApplication || noRecordApplication.kind !== "application")
        throw new Error("Expected application output");
      const noRecordWorkflow = noRecordApplication.canonical.content.workflows.find((candidate) =>
        candidate.nodes.some((node) => node.type === "wait_until"),
      );
      if (!noRecordWorkflow) throw new Error("Expected wait workflow");
      noRecordWorkflow.trigger = {
        kind: "schedule",
        schedule: {
          cadence: "daily",
          interval: 1,
          timeZone: "Pacific/Auckland",
          minute: 0,
          hour: 9,
        },
        inputs: [],
        condition: null,
        duplicateProtection: "required",
      };
      refreshArtifact(noRecordApplication);
      expect(failureCodes(requests, noCurrentRecord)).toContain(
        "vortex.definition.workflow_node_references",
      );
    });

    it("matches incoming-message payload declarations and trigger-input uses to the message contract", () => {
      const sourceWithIncomingPayload = (statusPayloadKey: string) => {
        const application = structuredClone(
          sources.find((source) => source.key === "vortex.app.crm"),
        );
        if (!application || application.kind !== "application")
          throw new Error("Expected application fixture");
        const workflow = application.body.workflows[0]!;
        workflow.trigger = {
          kind: "incoming_message",
          message: "delivery_status_received",
          inputs: [
            {
              key: "provider_message_id",
              type: "text",
              source: { kind: "payload", key: "provider_message_id" },
            },
            {
              key: "delivery_status",
              type: "text",
              source: { kind: "payload", key: statusPayloadKey },
            },
          ],
          condition: null,
          duplicate_protection: "required",
        };
        const call = workflow.nodes.find((node) => node.type === "call_connection");
        if (!call || call.type !== "call_connection")
          throw new Error("Expected connection-call node");
        call.config.inputs.template_key = {
          source: "trigger_input",
          input: "delivery_status",
        };
        return definitionSourceDocumentSchema.parse(application);
      };
      const validateScenario = (application: ReturnType<typeof sourceWithIncomingPayload>) => {
        const requests = sources
          .filter((source) => source.key !== application.key)
          .map(requestFor)
          .concat(requestFor(application));
        const outputs = requests.map(compileDefinition);
        const output = outputs.find(
          (candidate) =>
            candidate.kind === "application" &&
            candidate.artifact.definitionKey === application.key,
        );
        if (!output || output.kind !== "application")
          throw new Error("Expected compiled application");
        const completeFailures = failureCodes(requests, outputs);
        const workflow = output.canonical.content.workflows.find(
          (candidate) => candidate.key === "crm_qualify_lead",
        );
        const start = workflow?.nodes.find((node) => node.type === "start");
        const stop = workflow?.nodes.find((node) => node.type === "stop");
        if (!workflow || !start || !stop) throw new Error("Expected workflow endpoints");
        workflow.nodes = [start, stop];
        workflow.edges = [{ fromNodeId: start.nodeId, toNodeId: stop.nodeId }];
        refreshArtifact(output);
        return { completeFailures, isolatedTriggerFailures: failureCodes(requests, outputs) };
      };

      const validIncoming = validateScenario(sourceWithIncomingPayload("status"));
      expect(validIncoming.completeFailures).not.toContain(
        "vortex.definition.workflow_connection_inputs",
      );
      expect(validIncoming.completeFailures).not.toContain(
        "vortex.definition.workflow_action_inputs",
      );
      expect(validIncoming.isolatedTriggerFailures).not.toContain(
        "vortex.definition.workflow_trigger_values",
      );
      expect(
        validateScenario(sourceWithIncomingPayload("unknown_payload")).isolatedTriggerFailures,
      ).toContain("vortex.definition.workflow_trigger_values");

      const application = sourceWithIncomingPayload("status");
      const requests = sources
        .filter((source) => source.key !== application.key)
        .map(requestFor)
        .concat(requestFor(application));
      const outputs = structuredClone(requests.map(compileDefinition));
      const output = outputs.find(
        (candidate) =>
          candidate.kind === "application" && candidate.artifact.definitionKey === application.key,
      );
      if (!output || output.kind !== "application")
        throw new Error("Expected compiled application");
      const workflow = output.canonical.content.workflows.find(
        (candidate) => candidate.key === "crm_qualify_lead",
      );
      if (!workflow) throw new Error("Expected compiled workflow");
      const start = workflow.nodes.find((node) => node.type === "start");
      const format = workflow.nodes.find((node) => node.nodeId !== start?.nodeId);
      const stop = workflow.nodes.find((node) => node.type === "stop");
      if (!start || !format || !stop) throw new Error("Expected workflow nodes");
      workflow.nodes = [
        start,
        {
          ...format,
          type: "format_value",
          config: {
            formatterKey: "json",
            input: { source: "trigger_input", inputKey: "unknown_input" },
          },
          duplicateProtection: "not_applicable",
          activityKey: "format_value",
        },
        stop,
      ];
      workflow.edges = [
        { fromNodeId: start.nodeId, toNodeId: format.nodeId },
        { fromNodeId: format.nodeId, toNodeId: stop.nodeId },
      ];
      refreshArtifact(output);
      expect(failureCodes(requests, outputs)).toContain(
        "vortex.definition.workflow_trigger_values",
      );
    });
  });
});
