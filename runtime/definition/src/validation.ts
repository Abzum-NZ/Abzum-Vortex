import {
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
  applicationDraftV2Schema,
  calculationMaximumNestingDepth,
  protectedReadModelKeys,
  isPlatformPermissionKey,
  applicationSourceDocumentV2Schema,
  applicationCompilationRequestV2Schema,
  moduleDraftV3Schema,
  moduleSourceDocumentSchema,
  moduleCompilationRequestV3Schema,
  savedSharingConditionV3Schema,
  connectionTypeSchema,
  exactDecimalTextV2Schema,
  moneyValueV2Schema,
  sourceExactDecimalTextV2Schema,
  sourceMoneyValueV2Schema,
  moduleFieldValueV2Schemas,
  sourceModuleFieldValueV2Schemas,
  parseExactDecimal,
  jsonValueSchema,
  walkDefinitionContract,
  definitionSourceDocumentSchema,
  definitionCompilationRequestSchema,
  definitionPublicationContextSchema,
  builderKeySchema,
  platformIdSchema,
  namespacedKeySchema,
  translateDefinitionSchemaError,
  valueTypesCompatible,
  flowTaskChildLists,
  flowTaskRegistry,
  type DefinitionCompilationOutput,
  type DefinitionCompilationRequest,
  type ApplicationCompilationRequestV2,
  type ModuleCompilationRequestV3,
  type ModuleSourceDocument,
  type ModuleFieldV3,
  type ApplicationSourceDocumentV2,
  type ConditionNode,
  type DefinitionSourceDocument,
  type DefinitionPublicationContext,
  type DefinitionPublicationHistoryEvidence,
  type DefinitionRuleFailure,
  type DefinitionValidationLocation,
  type FlowDefinition,
  type FlowTask,
  type PlatformBlockReleaseV2,
  type PublishedDefinitionHistory,
  type VersionRequirement,
} from "@vortex/contracts";
import type { z } from "zod";
import {
  evaluateTypedConditionV2,
  TypedConditionEvaluationError,
  type TypedConditionParameterDeclarationV2,
} from "@vortex/rule";
import { satisfies } from "semver";
import { compileParsedDefinition } from "./compiler";
import { DefinitionCompilationError } from "./compilation-error";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "./canonical-json";
import {
  compareDefinitionVersionImpact,
  compareDefinitionVersionImpactWithEvidence,
} from "./version-impact";
import { createContractValueWalker } from "./contract-value-walker";
import { validateRuleGraph, ruleGraphValidationCodes } from "./rule-graph-validation";
import {
  applicationCatalogueRuleCodes,
  validateApplicationSourceCatalogue,
} from "./application-catalogue-validation";
import { settleDefinitionRuleFailures } from "./rule-failure-order";
import { deriveFormCommitActionKeys } from "./form-commit";

type JsonObject = Record<string, unknown>;
type Output = DefinitionCompilationOutput;
type PublicationCompilationRequest =
  | DefinitionCompilationRequest
  | ApplicationCompilationRequestV2
  | ModuleCompilationRequestV3;
type DefinitionPath = readonly (string | number)[];
type EditSaveSource = DefinitionSourceDocument | ApplicationSourceDocumentV2 | ModuleSourceDocument;

/** Registered platform block releases by exact identity; the one source of supported events. */
const registeredBlockReleases: ReadonlyMap<string, PlatformBlockReleaseV2> = new Map(
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2.releases.map((release) => [
    `${release.blockId}:${release.releaseVersion}`,
    release,
  ]),
);

const isV2ApplicationSource = (source: unknown): boolean =>
  source !== null &&
  typeof source === "object" &&
  !Array.isArray(source) &&
  (source as JsonObject).kind === "application" &&
  (source as JsonObject).source_contract_version === "2.0.0";

const isModuleSource = (source: unknown): boolean =>
  source !== null &&
  typeof source === "object" &&
  !Array.isArray(source) &&
  (source as JsonObject).kind === "module";

const parseEditSaveSource = (
  source: unknown,
):
  | Readonly<{
      success: true;
      data: EditSaveSource;
      schema: z.core.$ZodType;
    }>
  | Readonly<{ success: false; error: z.ZodError }> => {
  const schema = isV2ApplicationSource(source)
    ? applicationSourceDocumentV2Schema
    : isModuleSource(source)
      ? moduleSourceDocumentSchema
      : definitionSourceDocumentSchema;
  const parsed = schema.safeParse(source);
  return parsed.success
    ? { success: true, data: parsed.data, schema }
    : { success: false, error: parsed.error };
};

export type DefinitionValidationStage = "edit_save" | "publish" | "install" | "runtime";
export type DefinitionSemanticRule = Readonly<{
  ruleId: string;
  emittedCodes: readonly string[];
  stage: DefinitionValidationStage;
  definitionKinds: readonly ("module" | "application" | "connection_type")[];
  requiredContext: readonly (
    "source" | "resolution_snapshot" | "compiled_set" | "prior_published_version"
  )[];
  safeLocationFamily: DefinitionValidationLocation["segments"][number]["kind"];
  run: (context: DefinitionSetValidationContext) => DefinitionRuleFailure[];
}>;

export type DefinitionSetValidationContext = Readonly<{
  requests: readonly PublicationCompilationRequest[];
  outputs: readonly Output[];
  rawSources?: readonly unknown[];
  dependencyOutputs?: readonly Output[];
  publishedHistories?: readonly PublishedDefinitionHistory[];
  publishedHistoryEvidence?: readonly DefinitionPublicationHistoryEvidence[];
}>;

/**
 * Work validateDefinitionSet derives once per call and hands to the rules that would otherwise
 * repeat it per rule. A rule invoked directly with a plain context derives its own, unchanged.
 */
type PreparedValidationContext = DefinitionSetValidationContext &
  Readonly<{
    parsedSources?: readonly ReturnType<typeof parseEditSaveSource>[];
    walkCanonicalValues?: ReturnType<typeof createContractValueWalker>;
  }>;

/** The sources the edit-save rules judge, in the order their parsed results are held. */
const editSaveSources = (context: DefinitionSetValidationContext): readonly unknown[] =>
  context.rawSources ?? context.requests.map((request) => request.source);

const allValidationOutputs = (context: DefinitionSetValidationContext): readonly Output[] => [
  ...(context.dependencyOutputs ?? []),
  ...context.outputs,
];

const canonicalValueWalker = (context: DefinitionSetValidationContext) =>
  createContractValueWalker(
    allValidationOutputs(context).map((output) => ({
      schema:
        output.kind === "module"
          ? moduleDraftV3Schema
          : output.kind === "application"
            ? applicationDraftV2Schema
            : connectionTypeSchema,
      value: output.canonical,
    })),
  );

const rootLocation = (output: Output): DefinitionValidationLocation => {
  const canonical = output.canonical as unknown as JsonObject;
  const envelope = canonical.envelope as JsonObject | undefined;
  const key = String(envelope?.key ?? canonical.key);
  const kind =
    output.kind === "module"
      ? ("module" as const)
      : output.kind === "application"
        ? ("application" as const)
        : ("connection" as const);
  return {
    documentKind: output.kind,
    documentKey: key,
    segments: [{ kind, key }],
  };
};

const failure = (
  output: Output,
  ruleCode: string,
  family: DefinitionRuleFailure["family"],
  component?: DefinitionValidationLocation["segments"][number],
): DefinitionRuleFailure => ({
  ruleCode,
  family,
  location: component
    ? { ...rootLocation(output), segments: [...rootLocation(output).segments, component] }
    : rootLocation(output),
});

const object = (value: unknown) => value as JsonObject;
const array = (value: unknown) => value as JsonObject[];
const actionPermissionKeys = (action: JsonObject): string[] =>
  action.permissionKeys === undefined
    ? action.permissionKey === undefined
      ? []
      : [String(action.permissionKey)]
    : array(action.permissionKeys).map(String);
const actionPermissionsMatch = (
  action: JsonObject,
  permissionsByKey: ReadonlyMap<string, JsonObject>,
  permissionOwnersByKey?: ReadonlyMap<string, string>,
): boolean => {
  if (action.permissionKeys === undefined)
    return action.permissionKey !== undefined && permissionsByKey.has(String(action.permissionKey));
  const permissions = actionPermissionKeys(action).map((key) => permissionsByKey.get(key));
  const first = permissions[0];
  if (first === undefined || String(first.recordTypeId) !== String(action.subjectRecordTypeId))
    return false;
  const firstOwner = permissionOwnersByKey?.get(String(first.key));
  return permissions.every(
    (permission) =>
      permission !== undefined &&
      String(permission.recordTypeId) === String(action.subjectRecordTypeId) &&
      permission.actionKind === first.actionKind &&
      String(permission.namedAction ?? "") === String(first.namedAction ?? "") &&
      (first.actionKind !== "named" ||
        permissionOwnersByKey?.get(String(permission.key)) === firstOwner),
  );
};
/**
 * A `record.delete` task deletes the subject at the revision the command
 * names, so a deleting action has exactly one delete and may otherwise only copy
 * relationships (which write the target, never the subject) and announce Events.
 * A subject write or a creation can move that revision. The Record runtime
 * refuses the same combination when it composes the action (#571).
 */
const actionDeleteEffectsSupported = (action: JsonObject): boolean => {
  const types = array(action.tasks).map((task) => String(task.type));
  return (
    !types.includes("record.delete") ||
    (types.filter((type) => type === "record.delete").length === 1 &&
      types.every((type) =>
        ["record.delete", "record.changes", "event.announce"].includes(type),
      ))
  );
};

const schemaFailureFamily = {
  definition_required_value: "required_value",
  definition_invalid_value: "invalid_value",
  definition_unsupported_choice: "unsupported_choice",
  definition_unknown_property: "unknown_property",
  definition_too_few_items: "too_few_items",
  definition_too_many_items: "too_many_items",
  definition_duplicate_key: "duplicate_key",
  definition_broken_reference: "broken_reference",
  definition_unresolved_reference: "unresolved_reference",
  definition_scope_conflict: "scope_conflict",
  definition_incompatible_version: "incompatible_version",
  definition_dependency_cycle: "dependency_cycle",
  definition_unsafe_content: "unsafe_content",
  definition_incompatible_change: "incompatible_change",
  definition_more_errors: "more_errors",
  definition_validation_failed: "invalid_value",
} as const satisfies Record<string, DefinitionRuleFailure["family"]>;

const sourceCollectionLocationKind = {
  record_types: "record_type",
  fields: "field",
  relationships: "relationship",
  actions: "action",
  rules: "rule",
  events: "event",
  extension_points: "extension_point",
  pages: "page",
  blocks: "block",
  block_registrations: "block",
  workflows: "workflow",
  nodes: "workflow_node",
  pipelines: "pipeline",
  queries: "query",
  roles: "role",
  connection_bindings: "connection",
  interfaces: "interface",
  settings: "setting",
  shapes: "setting",
  operations: "setting",
  incoming_messages: "setting",
  flows: "flow",
  flow_bindings: "flow_binding",
} as const satisfies Partial<
  Record<string, DefinitionValidationLocation["segments"][number]["kind"]>
>;

const flowTaskListNames: ReadonlySet<string> = new Set([
  "tasks",
  "then",
  "else",
  "default",
  "errors",
  "finally",
]);

function sourceTranslationContext(source: unknown) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return undefined;
  const document = source as JsonObject;
  const documentKind = document.kind;
  const parsedKey = namespacedKeySchema.safeParse(document.key);
  if (
    (documentKind !== "module" &&
      documentKind !== "application" &&
      documentKind !== "connection_type") ||
    !parsedKey.success
  )
    return undefined;
  const rootKind =
    documentKind === "module"
      ? ("module" as const)
      : documentKind === "application"
        ? ("application" as const)
        : ("connection" as const);
  const rootLocation: DefinitionValidationLocation = {
    documentKind,
    documentKey: parsedKey.data,
    segments: [{ kind: rootKind, key: parsedKey.data }],
  };
  const pathMap: { sourcePath: (string | number)[]; location: DefinitionValidationLocation }[] = [
    { sourcePath: [], location: rootLocation },
  ];
  const pending: {
    value: unknown;
    path: (string | number)[];
    segments: DefinitionValidationLocation["segments"];
    collectionName?: string;
    depth: number;
  }[] = [{ value: document, path: [], segments: rootLocation.segments, depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < 50_000) {
    const current = pending.pop()!;
    if (current.depth > 32) continue;
    visited += 1;
    if (Array.isArray(current.value)) {
      for (let index = Math.min(current.value.length, 1_000) - 1; index >= 0; index -= 1)
        pending.push({
          ...current,
          value: current.value[index],
          path: [...current.path, index],
          depth: current.depth + 1,
        });
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    const entry = current.value as JsonObject;
    const insideFlow = current.segments.some((segment) => segment.kind === "flow");
    // A flow's tasks, at any depth, are located by their readable task id.
    const locationKind =
      insideFlow && current.collectionName !== undefined && flowTaskListNames.has(current.collectionName)
        ? "flow_node"
        : current.collectionName
          ? sourceCollectionLocationKind[
              current.collectionName as keyof typeof sourceCollectionLocationKind
            ]
          : undefined;
    const candidateKey = entry.key ?? entry.id;
    const parsedCandidate = namespacedKeySchema.or(builderKeySchema).safeParse(candidateKey);
    const nextSegments: DefinitionValidationLocation["segments"] =
      locationKind && parsedCandidate.success && current.segments.length < 12
        ? [...current.segments, { kind: locationKind, key: parsedCandidate.data }]
        : current.segments;
    if (nextSegments !== current.segments)
      pathMap.push({
        sourcePath: current.path,
        location: { ...rootLocation, segments: nextSegments },
      });
    const keys: string[] = [];
    for (const key in entry) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
      keys.push(key);
      if (keys.length === 1_000) break;
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      pending.push({
        value: entry[key],
        path: [...current.path, key],
        segments: nextSegments,
        collectionName: key,
        depth: current.depth + 1,
      });
    }
  }
  return { rootLocation, pathMap };
}

function leafPaths(value: unknown, path: DefinitionPath = []): DefinitionPath[] {
  if (Array.isArray(value))
    return value.flatMap((entry, index) => leafPaths(entry, [...path, index]));
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([key, entry]) => leafPaths(entry, [...path, key]));
  return [path];
}

const pathKey = (path: DefinitionPath) => JSON.stringify(path);
const outputKey = (output: Output) => {
  const canonical = object(output.canonical);
  return String(object(canonical.envelope ?? canonical).key);
};

function artifactBindingRule(context: DefinitionSetValidationContext): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const output of allValidationOutputs(context)) {
    const canonical = object(output.canonical);
    const envelope = object(canonical.envelope ?? canonical);
    const expectedContent = output.kind === "connection_type" ? canonical : canonical.content;
    const request = context.requests.find(
      (candidate) => candidate.source.key === outputKey(output),
    );
    const resolved = request?.resolution.definitions.find(
      (candidate) => candidate.kind === output.kind && candidate.key === outputKey(output),
    );
    if (
      output.artifact.kind !== output.kind ||
      output.artifact.definitionKey !== outputKey(output) ||
      output.artifact.rootId !== String(envelope.rootId ?? envelope.connectionTypeId) ||
      output.artifact.resolutionFingerprint !== output.resolutionFingerprint ||
      output.artifact.contentFingerprint !== fingerprintCanonicalValue(expectedContent) ||
      (output.kind === "connection_type" && canonical.version !== output.artifact.exactVersion) ||
      (resolved !== undefined &&
        (output.artifact.rootId !== resolved.rootId ||
          output.artifact.exactVersion !== resolved.exactVersion ||
          output.artifact.resolutionFingerprint !== request?.resolution.fingerprint))
    )
      failures.push(failure(output, "vortex.definition.artifact_binding", "incompatible_version"));
  }
  return failures;
}

function localIdentityRule(context: PreparedValidationContext): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  const values = editSaveSources(context);
  for (const [index, source] of values.entries()) {
    const sourceKey =
      source !== null && typeof source === "object" && !Array.isArray(source)
        ? (source as JsonObject).key
        : undefined;
    const output =
      context.outputs.find((candidate) => {
        const canonical = object(candidate.canonical);
        return String(object(canonical.envelope ?? canonical).key) === sourceKey;
      }) ?? context.outputs[index];
    let duplicate = false;
    const parsed = context.parsedSources?.[index] ?? parseEditSaveSource(source);
    if (!parsed.success) continue;
    walkDefinitionContract(parsed.schema, parsed.data, (schema, value) => {
      if (schema === jsonValueSchema) return;
      const definition = (schema as z.core.$ZodTypes)._zod.def;
      // A table row is user data, not a declaration: columns named id/key may repeat.
      if (
        Array.isArray(value) &&
        definition.type === "array" &&
        definition.element._zod.def.type !== "record"
      ) {
        for (const property of ["id", "key"] as const) {
          const values = value
            .filter(
              (entry): entry is JsonObject =>
                entry !== null && typeof entry === "object" && !Array.isArray(entry),
            )
            .map((entry) => entry[property])
            .filter((entry): entry is string => typeof entry === "string");
          if (new Set(values).size !== values.length) duplicate = true;
        }
      }
    });
    if (duplicate)
      failures.push(
        output
          ? failure(output, "vortex.definition.local_identity_unique", "duplicate_key")
          : {
              ruleCode: "vortex.definition.local_identity_unique",
              family: "duplicate_key",
            },
      );
  }
  return failures;
}

function sourceShapeRule(context: PreparedValidationContext): DefinitionRuleFailure[] {
  return editSaveSources(context).flatMap((source, index): DefinitionRuleFailure[] => {
    const parsed = context.parsedSources?.[index] ?? parseEditSaveSource(source);
    if (parsed.success) return [];
    const translation = sourceTranslationContext(source);
    if (!translation)
      return parsed.error.issues.map((issue) => ({
        ruleCode: "vortex.definition.source_shape",
        family:
          issue.code === "unrecognized_keys"
            ? ("unknown_property" as const)
            : issue.code === "invalid_value"
              ? ("unsupported_choice" as const)
              : issue.code === "too_small" && issue.origin === "array"
                ? ("too_few_items" as const)
                : issue.code === "too_big" && issue.origin === "array"
                  ? ("too_many_items" as const)
                  : issue.code === "invalid_type" && "input" in issue && issue.input === undefined
                    ? ("required_value" as const)
                    : ("invalid_value" as const),
      }));
    const translated = translateDefinitionSchemaError(parsed.error, {
      correlationId: "00000000-0000-4000-8000-000000000000",
      rootLocation: translation.rootLocation,
      pathMap: translation.pathMap,
      requiredPaths: parsed.error.issues
        .filter(
          (issue) => issue.code === "invalid_type" && "input" in issue && issue.input === undefined,
        )
        .map((issue) =>
          issue.path.filter((part): part is string | number => typeof part !== "symbol"),
        ),
    });
    return translated.errors.map((error) => ({
      ruleCode: "vortex.definition.source_shape",
      family: schemaFailureFamily[error.code],
      ...(error.location ? { location: error.location } : {}),
    }));
  });
}

function sourceLocalReferenceRule(context: PreparedValidationContext): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const [index, raw] of editSaveSources(context).entries()) {
    const parsed = context.parsedSources?.[index] ?? parseEditSaveSource(raw);
    if (!parsed.success) continue;
    const source = parsed.data;
    const walkValues = createContractValueWalker([{ schema: parsed.schema, value: source }]);
    const body = object(source.body);
    let valid = true;
    if (source.kind === "module") {
      const records = new Map(
        array(body.record_types).map((record) => [String(record.key), record] as const),
      );
      const dependencies = new Set(
        array(body.dependencies).map((dependency) => String(dependency.module)),
      );
      const dependencyKeys = new Set(
        array(body.dependencies).map((dependency) => String(dependency.dependency_key)),
      );
      const actions = array(body.actions);
      const actionIds = new Set(actions.map((action) => String(action.id)));
      const permissions = new Set(
        array(body.permissions).map((permission) => String(permission.key)),
      );
      const sharingConditions = new Map(
        array(body.sharing_conditions).map((condition) => [String(condition.key), condition]),
      );
      const events = new Set(array(body.events).map((event) => String(event.key)));
      const qualifiedRecordValid = (qualified: unknown): boolean => {
        const value = String(qualified);
        const split = value.lastIndexOf(":");
        if (split < 1) return false;
        const moduleKey = value.slice(0, split);
        const recordKey = value.slice(split + 1);
        return moduleKey === source.key ? records.has(recordKey) : dependencies.has(moduleKey);
      };
      const qualifiedRelationshipValid = (qualified: unknown): boolean => {
        const value = String(qualified);
        const separator = value.lastIndexOf(".");
        if (separator < 1) return false;
        const qualifiedRecord = value.slice(0, separator);
        const relationshipKey = value.slice(separator + 1);
        if (!qualifiedRecordValid(qualifiedRecord)) return false;
        const moduleSeparator = qualifiedRecord.lastIndexOf(":");
        const moduleKey = qualifiedRecord.slice(0, moduleSeparator);
        if (moduleKey !== source.key) return true;
        const record = records.get(qualifiedRecord.slice(moduleSeparator + 1));
        return (
          record !== undefined &&
          array(record.relationships).some(
            (relationship) => String(relationship.key) === relationshipKey,
          )
        );
      };
      const conditionValid = (
        condition: unknown,
        fields: ReadonlySet<string>,
        parameters: ReadonlySet<string> = new Set(),
      ): boolean => {
        const entry = object(condition);
        if (entry.all)
          return array(entry.all).every((child) => conditionValid(child, fields, parameters));
        if (entry.any)
          return array(entry.any).every((child) => conditionValid(child, fields, parameters));
        if (entry.not) return conditionValid(entry.not, fields, parameters);
        if (entry.left) {
          const operandValid = (operandValue: unknown) => {
            const operand = object(operandValue);
            if (operand.source === "field") return fields.has(String(operand.field));
            if (operand.source === "parameter") return parameters.has(String(operand.parameter));
            return operand.source === "value";
          };
          return (
            operandValid(entry.left) && (entry.right === undefined || operandValid(entry.right))
          );
        }
        return (
          fields.has(String(entry.field)) &&
          (entry.parameter === undefined || parameters.has(String(entry.parameter)))
        );
      };
      for (const record of records.values()) {
        const fields = new Set(array(record.fields).map((field) => String(field.key)));
        if (!fields.has(String(record.title_field))) valid = false;
        if ((record.custom_actions as string[]).some((id) => !actionIds.has(id))) valid = false;
        for (const relationship of array(record.relationships)) {
          if (!fields.has(String(relationship.from_field))) valid = false;
          const targets = relationship.to_record_type
            ? [relationship.to_record_type]
            : ((relationship.to_record_types as unknown[] | undefined) ?? []);
          if (targets.some((target) => !qualifiedRecordValid(target))) valid = false;
        }
        for (const field of array(record.fields)) {
          const settings = object(field.settings);
          if (field.type === "link" && !qualifiedRecordValid(settings.target)) valid = false;
          if (
            field.type === "link_to_one_of_several" &&
            (settings.targets as unknown[]).some((target) => !qualifiedRecordValid(target))
          )
            valid = false;
          if (field.type === "calculation") {
            const referenced: string[] = [];
            walkValues(settings.expression, (entry) => {
              for (const [key, candidate] of Object.entries(entry))
                if (key === "field" || key.endsWith("_field")) referenced.push(String(candidate));
              if (Array.isArray(entry.fields)) referenced.push(...entry.fields.map(String));
            });
            if (referenced.some((fieldKey) => !fields.has(fieldKey))) valid = false;
          }
          if (field.type === "total" && !qualifiedRelationshipValid(settings.relationship))
            valid = false;
          if (
            field.type === "table" &&
            array(settings.columns).some((column) => column.settings === undefined)
          )
            valid = false;
          const choiceSettings = [
            ...(["choice", "several_choices"].includes(String(field.type)) ? [settings] : []),
            ...(field.type === "table"
              ? array(settings.columns)
                  .filter((column) => column.type === "choice" && column.settings !== undefined)
                  .map((column) => object(column.settings))
              : []),
          ];
          for (const choice of choiceSettings)
            for (const option of array(choice.options)) {
              if (option.required_permission === undefined) continue;
              const requiredPermission = String(option.required_permission);
              if (
                !permissions.has(requiredPermission) &&
                ![...dependencies].some((dependency) =>
                  requiredPermission.startsWith(`${dependency}.`),
                )
              )
                valid = false;
            }
        }
      }
      for (const permission of array(body.permissions)) {
        if (permission.record_type && !records.has(String(permission.record_type))) valid = false;
        if ((permission.action_kind === "named") !== (permission.named_action !== undefined))
          valid = false;
        const scope = permission.record_scope ? object(permission.record_scope) : undefined;
        for (const route of scope ? array(scope.routes) : []) {
          if (
            route.kind === "ownership" &&
            records.get(String(permission.record_type))?.ownership_mode === "none"
          )
            valid = false;
          if (
            route.kind === "relationship" &&
            (!qualifiedRelationshipValid(route.relationship) ||
              !permissions.has(String(route.source_permission)))
          )
            valid = false;
        }
        const saved = scope?.saved_condition ? object(scope.saved_condition) : undefined;
        if (saved && !sharingConditions.has(String(saved.condition))) valid = false;
      }
      for (const action of actions) {
        const record = records.get(String(action.record_type));
        const fields = new Set(
          record ? array(record.fields).map((field) => String(field.key)) : [],
        );
        const relationships = new Set(
          record ? array(record.relationships).map((relationship) => String(relationship.key)) : [],
        );
        const inputs = new Map(
          array(action.inputs).map((input) => [String(input.key), String(input.type)]),
        );
        const actionPermissions =
          action.permission_alternatives === undefined
            ? [String(action.permission)]
            : (action.permission_alternatives as string[]);
        if (
          !record ||
          actionPermissions.length === 0 ||
          actionPermissions.some((key) => !permissions.has(key))
        )
          valid = false;
        if (
          action.precondition &&
          !conditionValid(action.precondition, fields, new Set(inputs.keys()))
        )
          valid = false;
        for (const task of array(action.tasks)) {
          const properties = object(task.properties);
          if (String(task.type) === "record.set_fields")
            for (const field of Object.keys(object(properties.values)))
              if (!fields.has(field)) valid = false;
          if (String(task.type) === "record.changes")
            for (const change of array(properties.changes))
              if (
                ((change.relationships as string[]) ?? []).some(
                  (key) => !relationships.has(key),
                ) ||
                inputs.get(String(change.target_input)) !== "record_reference"
              )
                valid = false;
          if (String(task.type) === "event.announce" && !events.has(String(properties.event)))
            valid = false;
          if (
            String(task.type) === "record.create" &&
            !qualifiedRecordValid(properties.record_type)
          )
            valid = false;
          walkValues(task, (entry) => {
            const reference = actionValueReferenceEntry(entry);
            if (
              reference?.source === "input" &&
              !inputs.has(String(reference.name)) &&
              String(reference.name) !== "record"
            )
              valid = false;
            if (reference?.source === "trigger_record" && !fields.has(String(reference.field)))
              valid = false;
          });
        }
      }
      // Task and value references are resolved by the flow compiler and validator; a save rule or
      // reaction of this Module can only be about one of its own record types, or a declared
      // dependency's, written with its definition key.
      for (const flow of array(body.flows))
        for (const trigger of array(flow.triggers))
          if (
            (trigger.type === "BeforeSave" || trigger.type === "Event") &&
            !String(trigger.recordTypeId).includes(":") &&
            !array(body.record_types).some(
              (record) => record.key === trigger.recordTypeId || record.id === trigger.recordTypeId,
            )
          )
            valid = false;
      for (const event of array(body.events)) {
        const record = records.get(String(event.record_type));
        const fields = new Set(
          record ? array(record.fields).map((field) => String(field.key)) : [],
        );
        if (!record || (event.carries as string[]).some((field) => !fields.has(field)))
          valid = false;
      }
      for (const point of array(body.extension_points))
        if (!records.has(String(point.record_type))) valid = false;
      for (const contribution of array(body.contributions ?? [])) {
        if (!dependencyKeys.has(String(contribution.dependency))) valid = false;
        if (contribution.kind === "field") {
          const record = records.get(String(contribution.record_type));
          const fields = new Set(
            record ? array(record.fields).map((field) => String(field.key)) : [],
          );
          if (!record || !fields.has(String(contribution.field))) valid = false;
        } else if (!actionIds.has(String(contribution.contributed_action))) valid = false;
      }
      for (const condition of array(body.sharing_conditions)) {
        const record = records.get(String(condition.source_record_type));
        const fields = new Set(
          record ? array(record.fields).map((field) => String(field.key)) : [],
        );
        const parameters = new Set(
          array(condition.parameters).map((parameter) => String(parameter.key)),
        );
        if (
          !record ||
          (condition.declared_fields as string[]).some((field) => !fields.has(field)) ||
          !conditionValid(condition.condition, fields, parameters)
        )
          valid = false;
      }
      for (const query of array(body.queries)) {
        // A query names one of this module's own records or a record of a declared dependency.
        // Only an own record can be checked field by field here; a dependency record is resolved
        // against the compiled dependency release by the Module reference rule.
        const authoredRecord = String(query.record_type);
        const separator = authoredRecord.lastIndexOf(":");
        const ownRecordKey =
          separator < 0
            ? authoredRecord
            : authoredRecord.slice(0, separator) === source.key
              ? authoredRecord.slice(separator + 1)
              : undefined;
        if (separator < 0 ? !records.has(authoredRecord) : !qualifiedRecordValid(authoredRecord))
          valid = false;
        const record = ownRecordKey === undefined ? undefined : records.get(ownRecordKey);
        if (record) {
          const fields = new Set(array(record.fields).map((field) => String(field.key)));
          const inputKeys = new Set(array(query.inputs).map((input) => String(input.key)));
          if ((query.select as string[]).some((field) => !fields.has(String(field)))) valid = false;
          if (array(query.group_by).some((field) => !fields.has(String(field)))) valid = false;
          if (array(query.sort).some((sort) => !fields.has(String(sort.field)))) valid = false;
          if (
            array(query.aggregates).some(
              (aggregate) => aggregate.field && !fields.has(String(aggregate.field)),
            )
          )
            valid = false;
          if (query.filter && !conditionValid(query.filter, fields, inputKeys)) valid = false;
        }
      }
    } else if (source.kind === "application") {
      const moduleBindings = new Set(
        array(body.module_bindings).map((binding) => String(binding.module)),
      );
      for (const permission of array(body.permissions)) {
        const scope = permission.record_scope ? object(permission.record_scope) : undefined;
        for (const route of scope ? array(scope.routes) : []) {
          if (route.kind !== "relationship") continue;
          const relationship = String(route.relationship);
          const separator = relationship.lastIndexOf(":");
          if (separator < 1 || !moduleBindings.has(relationship.slice(0, separator))) valid = false;
        }
      }
      const pages = new Set(array(body.pages).map((page) => String(page.key)));
      const queries = new Set(array(body.queries).map((query) => String(query.key)));
      const workflows = new Set(array(body.workflows).map((workflow) => String(workflow.key)));
      const flows = new Set(
        array(body.flows).flatMap((flow) => [String(flow.id), String(flow.key)]),
      );
      const connections = new Set(
        array(body.connection_bindings).map((binding) => String(binding.id)),
      );
      for (const page of array(body.pages)) {
        // A page binds a Module query by "module_key:query_key"; the Module must be bound here.
        if (page.query && !moduleBindings.has(String(page.query).slice(0, String(page.query).lastIndexOf(":"))))
          valid = false;
      }
      const visitNavigation = (items: JsonObject[]) => {
        for (const item of items) {
          if (item.type === "page" && !pages.has(String(item.page))) valid = false;
          if (item.type === "heading") visitNavigation(array(item.children));
        }
      };
      visitNavigation(array(body.navigation));
      if (!pages.has(String(body.home_page))) valid = false;
      for (const role of array(body.roles)) if (!pages.has(String(role.home_page))) valid = false;
      for (const pipeline of array(body.pipelines)) {
        const stages = new Set(array(pipeline.stages).map((stage) => String(stage.key)));
        for (const stage of array(pipeline.stages))
          if (
            [
              ...((stage.entry_workflows as string[]) ?? []),
              ...((stage.exit_workflows as string[]) ?? []),
            ].some((workflow) => !workflows.has(workflow))
          )
            valid = false;
        for (const transition of array(pipeline.transitions))
          if (!stages.has(String(transition.from)) || !stages.has(String(transition.to)))
            valid = false;
        if (array(pipeline.time_targets).some((target) => !stages.has(String(target.stage))))
          valid = false;
      }
      for (const definition of array(body.interfaces))
        for (const operation of array(definition.operations)) {
          const target = object(operation.target);
          // A read names a query a bound Module exposes; only the compiled Module releases hold
          // it, so the compiled application validation checks that reference.
          if (target.kind === "flow" && !flows.has(String(target.flow))) valid = false;
        }
      for (const address of array(body.public_addresses))
        if (!pages.has(String(address.page))) valid = false;
      for (const workflow of array(body.workflows))
        for (const node of array(workflow.nodes)) {
          const config = object(node.config);
          if (node.type === "request_form" && !pages.has(String(config.page))) valid = false;
          if (node.type === "query_records" && !queries.has(String(config.query))) valid = false;
          if (node.type === "start_workflow" && !workflows.has(String(config.workflow)))
            valid = false;
          if (node.type === "call_connection" && !connections.has(String(config.connection)))
            valid = false;
        }
    } else {
      const shapeKeys = new Set(array(body.shapes).map((shape) => String(shape.key)));
      const operationKeys = new Set(
        array(body.operations).map((operation) => String(operation.key)),
      );
      for (const operation of array(body.operations))
        if (!shapeKeys.has(String(operation.input)) || !shapeKeys.has(String(operation.output)))
          valid = false;
      for (const message of array(body.incoming_messages))
        if (!shapeKeys.has(String(message.input))) valid = false;
      if (
        [body.health_operation, body.revocation_operation].some(
          (key) => key !== undefined && !operationKeys.has(String(key)),
        )
      )
        valid = false;
    }
    if (!valid)
      failures.push({
        ruleCode: "vortex.definition.local_references",
        family: "broken_reference",
        location: {
          documentKind: source.kind,
          documentKey: source.key,
          segments: [
            {
              kind:
                source.kind === "module"
                  ? "module"
                  : source.kind === "application"
                    ? "application"
                    : "connection",
              key: source.key,
            },
          ],
        },
      });
  }
  return failures;
}

function sourceTypeCompatibilityRule(context: PreparedValidationContext): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const [index, raw] of editSaveSources(context).entries()) {
    const parsed = context.parsedSources?.[index] ?? parseEditSaveSource(raw);
    if (!parsed.success || parsed.data.kind !== "module") continue;
    const source = parsed.data;
    const body = object(source.body);
    const records = new Map(
      array(body.record_types).map((record) => [String(record.key), record] as const),
    );
    const fieldsFor = (record: JsonObject | undefined) =>
      new Map(
        record ? array(record.fields).map((field) => [String(field.key), field] as const) : [],
      );
    let valid = true;
    for (const [recordKey, record] of records) {
      for (const field of array(record.fields)) {
        if (field.type !== "total") continue;
        const settings = object(field.settings);
        const relationshipReference = String(settings.relationship);
        const relationshipSeparator = relationshipReference.lastIndexOf(".");
        const qualifiedRecord = relationshipReference.slice(0, relationshipSeparator);
        const recordSeparator = qualifiedRecord.lastIndexOf(":");
        if (
          relationshipSeparator < 1 ||
          recordSeparator < 1 ||
          qualifiedRecord.slice(0, recordSeparator) !== source.key
        )
          continue;
        const aggregateRecord = records.get(qualifiedRecord.slice(recordSeparator + 1));
        const aggregateFields = fieldsFor(aggregateRecord);
        const relationship = array(aggregateRecord?.relationships).find(
          (candidate) =>
            String(candidate.key) === relationshipReference.slice(relationshipSeparator + 1),
        );
        const targets = relationship?.to_record_type
          ? [String(relationship.to_record_type)]
          : array(relationship?.to_record_types).map(String);
        const ownerReference = `${source.key}:${recordKey}`;
        const aggregateField =
          settings.field === undefined ? undefined : aggregateFields.get(String(settings.field));
        const aggregateResultType = fieldDeclaredResultType(aggregateField);
        const declaredResultType = String(settings.result_type);
        const resultTypeValid =
          (settings.operation === "count" && declaredResultType === "whole_number") ||
          (settings.operation === "average" &&
            declaredResultType ===
              (aggregateResultType === "money" ? "money" : "decimal_number")) ||
          (["sum", "minimum", "maximum"].includes(String(settings.operation)) &&
            declaredResultType === aggregateResultType);
        if (
          !relationship ||
          !targets.includes(ownerReference) ||
          (settings.operation === "count"
            ? settings.field !== undefined
            : aggregateField === undefined) ||
          (["sum", "average"].includes(String(settings.operation)) &&
            !["whole_number", "decimal_number", "money"].includes(
              fieldValueTypeV2(aggregateField) ?? "",
            )) ||
          (settings.filter !== undefined &&
            !conditionTypesValidV2(settings.filter, aggregateFields, new Map(), "source")) ||
          !resultTypeValid
        )
          valid = false;
      }
    }
    for (const action of array(body.actions)) {
      const subjectFields = fieldsFor(records.get(String(action.record_type)));
      const inputs = new Map(
        array(action.inputs).map((input) => [String(input.key), input] as const),
      );
      const inputTypes = new Map(
        [...inputs].map(([key, input]) => [key, semanticFieldTypeV2(input.type) ?? ""] as const),
      );
      if (
        action.precondition &&
        !conditionTypesValidV2(action.precondition, subjectFields, inputTypes, "source")
      )
        valid = false;
      const subjectRecordType = `${source.key}:${String(action.record_type)}`;
      const sourceValueCompatible = (candidate: unknown, targetField: JsonObject | undefined) =>
        actionValueCompatibleV2(
          candidate,
          targetField,
          subjectFields,
          inputs,
          subjectRecordType,
          "source",
        );
      for (const task of array(action.tasks)) {
        const properties = object(task.properties);
        if (String(task.type) === "record.set_fields") {
          for (const [fieldKey, candidate] of Object.entries(object(properties.values)))
            if (!sourceValueCompatible(candidate, subjectFields.get(fieldKey))) valid = false;
        }
        if (String(task.type) === "record.create") {
          const qualified = String(properties.record_type);
          const split = qualified.lastIndexOf(":");
          if (split >= 0 && qualified.slice(0, split) === source.key) {
            const targetFields = fieldsFor(records.get(qualified.slice(split + 1)));
            if (
              Object.entries(object(properties.values)).some(
                ([fieldKey, candidate]) =>
                  !sourceValueCompatible(candidate, targetFields.get(fieldKey)),
              )
            )
              valid = false;
          }
        }
        if (String(task.type) === "record.changes") {
          for (const change of array(properties.changes)) {
            const targetInput = inputs.get(String(change.target_input));
            if (
              targetInput?.type !== "record_reference" ||
              !array(targetInput.record_types).map(String).includes(subjectRecordType)
            )
              valid = false;
          }
        }
      }
    }
    for (const sharingCondition of array(body.sharing_conditions)) {
      const fields = fieldsFor(records.get(String(sharingCondition.source_record_type)));
      const parameters = new Map(
        array(sharingCondition.parameters).map(
          (parameter) => [String(parameter.key), String(parameter.type)] as const,
        ),
      );
      if (!conditionTypesValidV2(sharingCondition.condition, fields, parameters, "source"))
        valid = false;
    }
    for (const query of array(body.queries)) {
      // Only an own record carries authored field types here; a dependency record's filter is
      // type-checked against the compiled dependency release by the Module reference rule.
      const authoredRecord = String(query.record_type);
      const separator = authoredRecord.lastIndexOf(":");
      if (separator >= 0 && authoredRecord.slice(0, separator) !== source.key) continue;
      const fields = fieldsFor(
        records.get(separator < 0 ? authoredRecord : authoredRecord.slice(separator + 1)),
      );
      const inputTypes = new Map(
        array(query.inputs).map(
          (input) => [String(input.key), semanticFieldTypeV2(input.type) ?? ""] as const,
        ),
      );
      if (query.filter && !conditionTypesValidV2(query.filter, fields, inputTypes, "source"))
        valid = false;
    }
    const sharingConditions = new Map(
      array(body.sharing_conditions).map((condition) => [String(condition.key), condition]),
    );
    for (const permission of array(body.permissions)) {
      const scope = permission.record_scope ? object(permission.record_scope) : undefined;
      const restriction = scope?.saved_condition ? object(scope.saved_condition) : undefined;
      if (!restriction) continue;
      const saved = sharingConditions.get(String(restriction.condition));
      const parameters = new Map(
        saved
          ? array(saved.parameters).map(
              (parameter) => [String(parameter.key), String(parameter.type)] as const,
            )
          : [],
      );
      const bindings = array(restriction.parameter_bindings);
      if (
        !saved ||
        String(saved.source_record_type) !== String(permission.record_type) ||
        bindings.length !== parameters.size ||
        new Set(bindings.map((binding) => String(binding.key))).size !== bindings.length ||
        bindings.some((binding) => {
          const expected = parameters.get(String(binding.key));
          return (
            expected === undefined ||
            (binding.source === "current_organization_account_id"
              ? !["text", "organization_account_reference"].includes(expected)
              : !valueMatchesTypeV2(binding.value, expected, "source"))
          );
        })
      )
        valid = false;
    }
    if (!valid)
      failures.push({
        ruleCode: "vortex.definition.source_type_compatibility",
        family: "invalid_value",
        location: {
          documentKind: "module",
          documentKey: source.key,
          segments: [{ kind: "module", key: source.key }],
        },
      });
  }
  return failures;
}

function provenanceRule(context: DefinitionSetValidationContext): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const [index, output] of context.outputs.entries()) {
    const request =
      context.requests.find((candidate) => candidate.source.key === outputKey(output)) ??
      context.requests[index];
    const representedSourcePaths = new Set(
      output.provenance.flatMap((entry) =>
        entry.sourcePath === undefined ? [] : [pathKey(entry.sourcePath)],
      ),
    );
    const representedCanonicalPaths = new Set(
      output.provenance.map((entry) => pathKey(entry.canonicalPath)),
    );
    const sourceLeafPaths = leafPaths(request?.source);
    const expectedSourcePaths = request
      ? sourceLeafPaths.filter(
          (path) =>
            !(path.length === 1 && (path[0] === "source_contract_version" || path[0] === "kind")),
        )
      : [];
    const expectedCanonicalPaths = leafPaths(output.canonical);
    const sourceLeafKeys = new Set(sourceLeafPaths.map(pathKey));
    const canonicalLeafKeys = new Set(expectedCanonicalPaths.map(pathKey));
    const entriesAreTraceable = output.provenance.every((entry) => {
      const sourcePathIsLeaf =
        entry.sourcePath === undefined || sourceLeafKeys.has(pathKey(entry.sourcePath));
      const canonicalPathExists =
        canonicalLeafKeys.has(pathKey(entry.canonicalPath)) ||
        entry.ruleCode === "vortex.definition.semantic_transform" ||
        entry.ruleCode === "vortex.definition.immutable_resolution";
      const transformedContainerIsDeclared =
        canonicalLeafKeys.has(pathKey(entry.canonicalPath)) ||
        entry.ruleCode === "vortex.definition.semantic_transform" ||
        entry.ruleCode === "vortex.definition.immutable_resolution";
      return sourcePathIsLeaf && canonicalPathExists && transformedContainerIsDeclared;
    });
    const sourceComplete = expectedSourcePaths.every((path) =>
      representedSourcePaths.has(pathKey(path)),
    );
    const canonicalComplete = expectedCanonicalPaths.every((path) =>
      representedCanonicalPaths.has(pathKey(path)),
    );
    if (!request || !sourceComplete || !canonicalComplete || !entriesAreTraceable)
      failures.push(failure(output, "vortex.definition.provenance_complete", "invalid_value"));
  }
  return failures;
}

function dependencyRule(context: DefinitionSetValidationContext): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  const modules = new Map(
    allValidationOutputs(context)
      .filter((output) => output.kind === "module")
      .map((output) => {
        const canonical = object(output.canonical);
        return [String(object(canonical.envelope).rootId), output] as const;
      }),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (rootId: string, output: Output) => {
    if (visiting.has(rootId)) {
      failures.push(
        failure(output, "vortex.definition.module_dependency_acyclic", "dependency_cycle"),
      );
      return;
    }
    if (visited.has(rootId)) return;
    visiting.add(rootId);
    const request = context.requests.find(
      (candidate) => candidate.source.key === output.artifact.definitionKey,
    );
    const canonicalDependencies = array(object(object(output.canonical).content).dependencies);
    const recordedDependencies = output.resolvedDependencies.filter(
      (dependency) => dependency.kind === "module",
    );
    if (
      recordedDependencies.length !== canonicalDependencies.length ||
      output.resolvedDependencies.length !== canonicalDependencies.length
    )
      failures.push(
        failure(output, "vortex.definition.module_dependency_resolved", "unresolved_reference"),
      );
    for (const dependency of canonicalDependencies) {
      const target = modules.get(String(dependency.moduleRootId));
      const snapshotDefinition = request?.resolution.definitions.find(
        (candidate) =>
          candidate.kind === "module" && candidate.key === String(dependency.moduleKey),
      );
      const recorded = recordedDependencies.filter(
        (candidate) =>
          candidate.key === dependency.moduleKey &&
          candidate.rootId === dependency.moduleRootId &&
          candidate.exactVersion === dependency.resolvedVersion,
      );
      const targetContent =
        target?.kind === "module" ? object(object(target.canonical).content) : undefined;
      const exactBinding =
        target?.kind === "module" &&
        (request === undefined ||
          (snapshotDefinition !== undefined &&
            snapshotDefinition.rootId === dependency.moduleRootId &&
            snapshotDefinition.exactVersion === dependency.resolvedVersion)) &&
        versionRequirementAccepts(
          dependency.version as VersionRequirement,
          String(dependency.resolvedVersion),
        ) &&
        recorded.length === 1 &&
        target.artifact.definitionKey === dependency.moduleKey &&
        target.artifact.rootId === dependency.moduleRootId &&
        target.artifact.exactVersion === dependency.resolvedVersion &&
        target.artifact.contentFingerprint === fingerprintCanonicalValue(targetContent) &&
        target.artifact.resolutionFingerprint === target.resolutionFingerprint;
      if (!exactBinding)
        failures.push(
          failure(output, "vortex.definition.module_dependency_resolved", "unresolved_reference"),
        );
      else if (
        context.requests.some((candidate) => candidate.source.key === target.artifact.definitionKey)
      )
        visit(String(dependency.moduleRootId), target);
    }
    visiting.delete(rootId);
    visited.add(rootId);
  };
  for (const output of context.outputs.filter((entry) => entry.kind === "module")) {
    const rootId = String(object(object(output.canonical).envelope).rootId);
    visit(rootId, output);
  }
  return failures;
}

function semanticFieldType(type: unknown): string | undefined {
  const value = String(type);
  if (["whole_number", "decimal_number", "money", "number"].includes(value)) return "number";
  if (value === "yes_no" || value === "boolean") return "boolean";
  if (value === "date" || value === "date_time") return value;
  if (["link", "link_to_one_of_several", "record_reference"].includes(value))
    return "record_reference";
  if (
    ["link_to_person", "organization_account_reference", "organisation_account_reference"].includes(
      value,
    )
  )
    return "organization_account_reference";
  if (value === "table" || value === "attachment" || value === "several_choices") return "json";
  if (
    [
      "text",
      "long_text",
      "formatted_text",
      "choice",
      "reference_number",
      "email_address",
      "phone_number",
      "web_address",
    ].includes(value)
  )
    return "text";
  return undefined;
}

function fieldDeclaredResultType(field: JsonObject | undefined): string | undefined {
  if (!field) return undefined;
  if (field.type === "calculation" || field.type === "total") {
    const settings = object(field.settings);
    const resultType = settings.resultType ?? settings.result_type;
    return typeof resultType === "string" ? resultType : undefined;
  }
  return String(field.type);
}

function fieldValueType(field: JsonObject | undefined): string | undefined {
  if (!field) return undefined;
  const type = String(field.type);
  if (type === "calculation" || type === "total")
    return semanticFieldType(fieldDeclaredResultType(field));
  if (["whole_number", "decimal_number", "money"].includes(type)) return "number";
  if (type === "yes_no") return "boolean";
  if (type === "date" || type === "date_time") return type;
  if (["link", "link_to_one_of_several"].includes(type)) return "record_reference";
  if (type === "link_to_person") return "organization_account_reference";
  if (type === "table" || type === "attachment" || type === "several_choices") return "json";
  return "text";
}

type ModuleV2ValueDialect = "source" | "canonical";
type ModuleV2ValueDeclaration = Readonly<{
  field?: JsonObject;
  type?: string;
}>;

function semanticFieldTypeV2(type: unknown): string | undefined {
  const value = String(type);
  if (
    [
      "whole_number",
      "decimal_number",
      "money",
      "number",
      "boolean",
      "date",
      "date_time",
      "record_reference",
      "organization_account_reference",
    ].includes(value)
  )
    return value;
  if (value === "yes_no") return "boolean";
  if (["link", "link_to_one_of_several"].includes(value)) return "record_reference";
  if (["link_to_person", "organisation_account_reference"].includes(value))
    return "organization_account_reference";
  if (value === "several_choices") return "text_collection";
  if (["table", "attachment", "formatted_text"].includes(value)) return "opaque_json";
  if (
    [
      "text",
      "long_text",
      "choice",
      "reference_number",
      "email_address",
      "phone_number",
      "web_address",
    ].includes(value)
  )
    return "text";
  return undefined;
}

function fieldValueTypeV2(field: JsonObject | undefined): string | undefined {
  return field ? semanticFieldTypeV2(fieldDeclaredResultType(field)) : undefined;
}

type NumericDimensionV2 = "dimensionless" | "money";

const numericDimensionV2 = (field: JsonObject | undefined): NumericDimensionV2 | undefined => {
  const type = fieldValueTypeV2(field);
  if (type === "whole_number" || type === "decimal_number") return "dimensionless";
  return type === "money" ? "money" : undefined;
};

const exactIntegerLiteralV2 = (value: unknown): boolean => {
  const parsed = parseExactDecimal(value);
  return parsed !== undefined && parsed.scale === 0;
};

const calculationDependencyFieldIdsV2 = (expression: JsonObject): string[] => {
  const dependencies: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && !dependencies.includes(value)) dependencies.push(value);
  };
  const visitCondition = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (!Array.isArray(value) && object(value).source === "field") add(object(value).fieldId);
    for (const child of Array.isArray(value) ? value : Object.values(value)) visitCondition(child);
  };
  const visitNumberValue = (value: unknown, depth: number): boolean => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (depth > calculationMaximumNestingDepth) return false;
    const entry = object(value);
    if (entry.source === "numeric") {
      const operands = array(entry.operands);
      if (operands.length < 2) return false;
      return operands.every((operand) => visitNumberValue(operand, depth + 1));
    }
    if (entry.source === "field") add(entry.fieldId);
    return true;
  };
  if (expression.kind === "join_text")
    for (const fieldId of expression.fieldIds as string[]) add(fieldId);
  if (expression.kind === "numeric")
    for (const operand of array(expression.operands))
      if (!visitNumberValue(operand, 1)) {
        dependencies.length = 0;
        break;
      }
  if (expression.kind === "condition") visitCondition(expression.condition);
  if (expression.kind === "date_offset") {
    add(expression.dateFieldId);
    const amount = object(expression.amount);
    if (amount.source === "field") add(amount.fieldId);
  }
  if (expression.kind === "deadline_passed") {
    add(expression.dueFieldId);
    add(expression.statusFieldId);
  }
  return dependencies;
};

/**
 * The money dimension one operation yields from its operands' dimensions, or undefined when a
 * dimension is unknown or the operation's dimensions are not allowed. Money divided by money is
 * refused: only a dimensionless divisor keeps the dividend's currency.
 */
const numericOperationDimensionV2 = (
  operation: string,
  dimensions: readonly (NumericDimensionV2 | undefined)[],
): NumericDimensionV2 | undefined => {
  if (dimensions.some((dimension) => dimension === undefined)) return undefined;
  const moneyPositions = dimensions.flatMap((dimension, index) =>
    dimension === "money" ? [index] : [],
  );
  const valid =
    operation === "add" || operation === "subtract"
      ? moneyPositions.length === 0 || moneyPositions.length === dimensions.length
      : operation === "multiply"
        ? moneyPositions.length <= 1
        : operation === "divide"
          ? moneyPositions.length === 0 || (moneyPositions.length === 1 && moneyPositions[0] === 0)
          : false;
  if (!valid) return undefined;
  return moneyPositions.length > 0 ? "money" : "dimensionless";
};

/** The money dimension of one numeric value, worked out through any nesting of operations. */
const numericValueDimensionV2 = (
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  depth = 1,
): NumericDimensionV2 | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (depth > calculationMaximumNestingDepth) return undefined;
  const entry = object(value);
  if (entry.source === "literal")
    return exactDecimalTextV2Schema.safeParse(entry.value).success
      ? ("dimensionless" as const)
      : undefined;
  if (entry.source === "field") return numericDimensionV2(fields.get(String(entry.fieldId)));
  if (entry.source !== "numeric") return undefined;
  const operands = array(entry.operands);
  if (operands.length < 2) return undefined;
  return numericOperationDimensionV2(
    String(entry.operation),
    operands.map((operand) => numericValueDimensionV2(operand, fields, depth + 1)),
  );
};

const numericExpressionValidV2 = (
  expression: JsonObject,
  resultType: string,
  fields: ReadonlyMap<string, JsonObject>,
): boolean => {
  const dimension = numericOperationDimensionV2(
    String(expression.operation),
    array(expression.operands).map((operand) => numericValueDimensionV2(operand, fields)),
  );
  if (dimension === undefined) return false;
  return dimension === "money"
    ? resultType === "money"
    : resultType === "whole_number" || resultType === "decimal_number";
};

function valueMatchesTypeV2(
  value: unknown,
  type: string,
  dialect: ModuleV2ValueDialect = "canonical",
): boolean {
  if (type === "text") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "whole_number") return typeof value === "number" && Number.isInteger(value);
  if (type === "decimal_number")
    return (
      dialect === "source" ? sourceExactDecimalTextV2Schema : exactDecimalTextV2Schema
    ).safeParse(value).success;
  if (type === "money")
    return (dialect === "source" ? sourceMoneyValueV2Schema : moneyValueV2Schema).safeParse(value)
      .success;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "organization_account_reference") return platformIdSchema.safeParse(value).success;
  if (type === "date") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (type === "date_time") return typeof value === "string" && !Number.isNaN(Date.parse(value));
  if (type === "record_reference")
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (dialect === "source"
        ? typeof object(value).record_type === "string" &&
          platformIdSchema.safeParse(object(value).record_id).success
        : platformIdSchema.safeParse(object(value).recordTypeId).success &&
          platformIdSchema.safeParse(object(value).recordId).success)
    );
  if (type === "text_collection")
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
  return type === "opaque_json" && jsonValueSchema.safeParse(value).success;
}

function fieldValueMatchesV2(
  value: unknown,
  field: JsonObject | undefined,
  dialect: ModuleV2ValueDialect,
): boolean {
  if (!field) return false;
  if (field.type === "calculation" || field.type === "total") {
    const resultType = fieldValueTypeV2(field);
    return resultType !== undefined && valueMatchesTypeV2(value, resultType, dialect);
  }
  const schemas =
    dialect === "source" ? sourceModuleFieldValueV2Schemas : moduleFieldValueV2Schemas;
  const schema = schemas[String(field.type) as keyof typeof schemas];
  if (schema === undefined || !schema.safeParse(value).success) return false;
  const expectedRecordTypeIds = fieldRecordTypeIds(field);
  if (expectedRecordTypeIds === undefined) return true;
  const actualRecordTypeId = object(value)[dialect === "source" ? "record_type" : "recordTypeId"];
  return (
    typeof actualRecordTypeId === "string" && expectedRecordTypeIds.includes(actualRecordTypeId)
  );
}

const conditionCollectionElementTypeV2 = (type: string | undefined): type is string =>
  type !== undefined && type !== "text_collection" && type !== "opaque_json";

function naturalLiteralTypeV2(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
    if (!Number.isNaN(Date.parse(value))) return "date_time";
    return "text";
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    return "text_collection";
  return "opaque_json";
}

function conditionTypesValidV2(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  parameters: ReadonlyMap<string, string> = new Map(),
  dialect: ModuleV2ValueDialect = "canonical",
): boolean {
  if (value === null || value === undefined) return true;
  const condition = object(value);
  const all =
    dialect === "source"
      ? condition.all
      : condition.kind === "all"
        ? condition.conditions
        : undefined;
  const any =
    dialect === "source"
      ? condition.any
      : condition.kind === "any"
        ? condition.conditions
        : undefined;
  const not =
    dialect === "source"
      ? condition.not
      : condition.kind === "not"
        ? condition.condition
        : undefined;
  if (all)
    return array(all).every((entry) => conditionTypesValidV2(entry, fields, parameters, dialect));
  if (any)
    return array(any).every((entry) => conditionTypesValidV2(entry, fields, parameters, dialect));
  if (not) return conditionTypesValidV2(not, fields, parameters, dialect);
  if (dialect === "canonical" && condition.kind !== "comparison") return false;

  const authoredLeft =
    dialect === "source" && condition.left === undefined
      ? { source: "field", field: condition.field }
      : condition.left;
  const authoredRight =
    dialect === "source" && condition.right === undefined
      ? condition.parameter !== undefined
        ? { source: "parameter", parameter: condition.parameter }
        : { source: "value", value: condition.value }
      : condition.right;
  const declaration = (operandValue: unknown): ModuleV2ValueDeclaration | undefined => {
    const operand = object(operandValue);
    if (operand.source === "field") {
      const field = fields.get(String(operand[dialect === "source" ? "field" : "fieldId"]));
      if (!field) return undefined;
      const type = fieldValueTypeV2(field);
      return { field, ...(type === undefined ? {} : { type }) };
    }
    if (operand.source === "parameter") {
      const type = parameters.get(String(operand[dialect === "source" ? "parameter" : "key"]));
      if (!type) return undefined;
      const semanticType = semanticFieldTypeV2(type);
      return semanticType === undefined ? undefined : { type: semanticType };
    }
    return operand.source === "value" ? {} : undefined;
  };
  const literal = (operandValue: unknown): unknown => {
    const operand = object(operandValue);
    return operand.source === "value" ? operand.value : undefined;
  };
  const matches = (literalValue: unknown, expected: ModuleV2ValueDeclaration | undefined) =>
    literalValue === null ||
    (expected?.field
      ? fieldValueMatchesV2(literalValue, expected.field, dialect)
      : expected?.type !== undefined && valueMatchesTypeV2(literalValue, expected.type, dialect));
  const leftDeclaration = declaration(authoredLeft);
  if (!leftDeclaration) return false;
  const operator = String(condition.operator);
  if (operator === "is_empty" || operator === "is_not_empty")
    return dialect === "source"
      ? condition.left === undefined &&
          condition.parameter === undefined &&
          condition.value === undefined
      : authoredRight === undefined;
  const rightDeclaration = declaration(authoredRight);
  if (!rightDeclaration) return false;
  const leftLiteral = literal(authoredLeft);
  const rightLiteral = literal(authoredRight);
  const leftIsLiteral = object(authoredLeft).source === "value";
  const rightIsLiteral = object(authoredRight).source === "value";

  if (["in", "not_in"].includes(operator)) {
    const elementType = leftDeclaration.type ?? naturalLiteralTypeV2(leftLiteral);
    if (!conditionCollectionElementTypeV2(elementType)) return false;
    if (!rightIsLiteral)
      return rightDeclaration.type === "text_collection" && elementType === "text";
    if (!Array.isArray(rightLiteral)) return false;
    return rightLiteral.every((entry) =>
      leftDeclaration.type
        ? matches(entry, leftDeclaration)
        : valueMatchesTypeV2(entry, elementType, dialect),
    );
  }
  if (["contains", "not_contains"].includes(operator)) {
    if (Array.isArray(leftLiteral))
      return leftLiteral.every((entry) => matches(entry, rightDeclaration));
    if (rightLiteral !== undefined) {
      if (leftDeclaration.type === "text_collection") return typeof rightLiteral === "string";
      if (leftDeclaration.type === "text") return typeof rightLiteral === "string";
    }
  }
  if (leftIsLiteral && !matches(leftLiteral, rightDeclaration)) return false;
  if (rightIsLiteral && !matches(rightLiteral, leftDeclaration)) return false;
  const leftType = leftDeclaration.type ?? rightDeclaration.type;
  const rightType = rightDeclaration.type ?? leftDeclaration.type;
  if (!leftType || !rightType) return false;
  if (["contains", "not_contains"].includes(operator))
    return (leftType === "text" && rightType === "text") || leftType === "text_collection";
  if (
    ["greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal"].includes(operator)
  )
    return (
      valueTypesCompatible(leftType, rightType, "condition") &&
      ["number", "whole_number", "decimal_number", "money", "date", "date_time", "text"].includes(
        leftType,
      )
    );
  return valueTypesCompatible(leftType, rightType, "condition");
}

function fieldRecordTypeIds(field: JsonObject | undefined): string[] | undefined {
  if (!field) return undefined;
  const settings = object(field.settings);
  if (field.type === "link")
    return [
      typeof settings.target === "string"
        ? settings.target
        : String(object(settings.target).recordTypeId),
    ];
  if (field.type === "link_to_one_of_several")
    return array(settings.targets).map((target) =>
      typeof target === "string" ? target : String(target.recordTypeId),
    );
  return undefined;
}

function literalValueType(value: unknown): string | undefined {
  if (value === null || Array.isArray(value) || typeof value === "object") return "json";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value !== "string") return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  if (!Number.isNaN(Date.parse(value))) return "date_time";
  return "text";
}

function conditionTypesValid(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  parameters: ReadonlyMap<string, string> = new Map(),
): boolean {
  if (value === null || value === undefined) return true;
  const condition = object(value);
  if (condition.kind === "all" || condition.kind === "any")
    return array(condition.conditions).every((entry) =>
      conditionTypesValid(entry, fields, parameters),
    );
  if (condition.kind === "not") return conditionTypesValid(condition.condition, fields, parameters);
  if (condition.kind !== "comparison") return false;
  const operandType = (operandValue: unknown) => {
    const operand = object(operandValue);
    if (operand.source === "field") return fieldValueType(fields.get(String(operand.fieldId)));
    if (operand.source === "parameter") return parameters.get(String(operand.key));
    return operand.source === "value" ? literalValueType(operand.value) : undefined;
  };
  const leftType = operandType(condition.left);
  if (!leftType) return false;
  if (condition.operator === "is_empty" || condition.operator === "is_not_empty")
    return condition.right === undefined;
  const rightType = operandType(condition.right);
  if (!rightType) return false;
  if (["contains", "not_contains"].includes(String(condition.operator)))
    return (
      (leftType === "text" && (rightType === "text" || rightType === "json")) ||
      (leftType === "json" && (rightType === "text" || rightType === "json"))
    );
  if (["in", "not_in"].includes(String(condition.operator))) return rightType === "json";
  if (
    ["greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal"].includes(
      String(condition.operator),
    )
  )
    return leftType === rightType && ["number", "date", "date_time", "text"].includes(leftType);
  return leftType === rightType || (leftType === "date_time" && rightType === "date");
}

/**
 * The reference sources a named-action task value may read. An action value is a flow value
 * (`{ kind: "literal", literal }` or `{ kind: "reference", reference }`); an input reference names
 * a declared action input, a trigger-record reference names a subject field by its key, and the
 * reserved `record` input is the whole subject record the compiler supplies to the action flow.
 */
const actionValueReferenceSources: ReadonlySet<string> = new Set([
  "input",
  "trigger_record",
  "execution_actor",
  "execution_now",
]);

const actionValueReference = (value: unknown): JsonObject | undefined => {
  const entry = object(value);
  return entry.kind === "reference" ? object(entry.reference) : undefined;
};

const actionValueLiteral = (value: unknown): unknown => {
  const entry = object(value);
  return entry.kind === "literal" ? object(entry.literal).value : undefined;
};

/** A task value map key names a field; source maps key by alias and canonical maps by field id. */
const actionFieldByKey = (
  fields: ReadonlyMap<string, JsonObject>,
  key: string,
): JsonObject | undefined => {
  const direct = fields.get(key);
  if (direct !== undefined) return direct;
  for (const field of fields.values()) if (String(field.key) === key) return field;
  return undefined;
};

function actionValueType(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  inputs: ReadonlyMap<string, JsonObject>,
): string | undefined {
  const entry = object(value);
  if (entry.kind === "literal") return literalValueType(actionValueLiteral(value));
  const reference = actionValueReference(value);
  if (reference === undefined) return undefined;
  if (reference.source === "input") {
    const input = inputs.get(String(reference.name));
    if (input !== undefined) return semanticFieldType(input.type);
    return String(reference.name) === "record" ? "record_reference" : undefined;
  }
  if (reference.source === "trigger_record")
    return fieldValueType(actionFieldByKey(fields, String(reference.field)));
  if (reference.source === "execution_actor") return "organization_account_reference";
  if (reference.source === "execution_now") return "date_time";
  return undefined;
}

function actionValueRecordTypeIds(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  inputs: ReadonlyMap<string, JsonObject>,
  subjectRecordTypeId: string,
): string[] | undefined {
  const reference = actionValueReference(value);
  if (reference === undefined) return undefined;
  if (reference.source === "input") {
    const input = inputs.get(String(reference.name));
    if (input === undefined) return String(reference.name) === "record" ? [subjectRecordTypeId] : undefined;
    if (input.type !== "record_reference") return undefined;
    const references = array(input.recordTypes ?? input.record_types);
    return references.map((entry) =>
      typeof entry === "string" ? entry : String(entry.recordTypeId),
    );
  }
  if (reference.source === "trigger_record")
    return fieldRecordTypeIds(actionFieldByKey(fields, String(reference.field)));
  return undefined;
}

function actionValueTypeV2(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  inputs: ReadonlyMap<string, JsonObject>,
): string | undefined {
  const reference = actionValueReference(value);
  if (reference === undefined) return undefined;
  if (reference.source === "input") {
    const input = inputs.get(String(reference.name));
    if (input === undefined) return String(reference.name) === "record" ? "record_reference" : undefined;
    return input.type === "formatted_text" ? "formatted_text" : semanticFieldTypeV2(input.type);
  }
  if (reference.source === "trigger_record") {
    const field = actionFieldByKey(fields, String(reference.field));
    return ["formatted_text", "table", "attachment"].includes(String(field?.type))
      ? String(field!.type)
      : fieldValueTypeV2(field);
  }
  if (reference.source === "execution_actor") return "organization_account_reference";
  if (reference.source === "execution_now") return "date_time";
  return undefined;
}

function actionValueCompatibleV2(
  value: unknown,
  targetField: JsonObject | undefined,
  fields: ReadonlyMap<string, JsonObject>,
  inputs: ReadonlyMap<string, JsonObject>,
  subjectRecordTypeId: string,
  dialect: ModuleV2ValueDialect = "canonical",
): boolean {
  const entry = object(value);
  const expectedType = ["formatted_text", "table", "attachment"].includes(String(targetField?.type))
    ? String(targetField!.type)
    : fieldValueTypeV2(targetField);
  const compatible =
    entry.kind === "literal"
      ? fieldValueMatchesV2(actionValueLiteral(value), targetField, dialect)
      : valueTypesCompatible(actionValueTypeV2(value, fields, inputs), expectedType, "exact");
  const expectedRecordTypeIds = fieldRecordTypeIds(targetField);
  if (!compatible || expectedRecordTypeIds === undefined) return compatible;
  if (entry.kind === "literal") return compatible;
  const actualRecordTypeIds = actionValueRecordTypeIds(value, fields, inputs, subjectRecordTypeId);
  return (
    actualRecordTypeIds !== undefined &&
    actualRecordTypeIds.length > 0 &&
    actualRecordTypeIds.every((recordTypeId) => expectedRecordTypeIds.includes(recordTypeId))
  );
}

function actionValueCompatible(
  value: unknown,
  targetField: JsonObject | undefined,
  fields: ReadonlyMap<string, JsonObject>,
  inputs: ReadonlyMap<string, JsonObject>,
  subjectRecordTypeId: string,
): boolean {
  const compatible = valueTypesCompatible(
    actionValueType(value, fields, inputs),
    fieldValueType(targetField),
    "value",
  );
  const expectedRecordTypeIds = fieldRecordTypeIds(targetField);
  if (!compatible || expectedRecordTypeIds === undefined) return compatible;
  if (object(value).kind === "literal") return compatible;
  const actualRecordTypeIds = actionValueRecordTypeIds(value, fields, inputs, subjectRecordTypeId);
  return (
    actualRecordTypeIds !== undefined &&
    actualRecordTypeIds.length > 0 &&
    actualRecordTypeIds.every((recordTypeId) => expectedRecordTypeIds.includes(recordTypeId))
  );
}

type ApplicationFieldValuePair = Readonly<{
  field: JsonObject;
  moduleV2: boolean;
}>;

const applicationFieldType = (pair: ApplicationFieldValuePair | undefined): string | undefined => {
  if (!pair) return undefined;
  if (pair.moduleV2 && ["formatted_text", "table", "attachment"].includes(String(pair.field.type)))
    return String(pair.field.type);
  return pair.moduleV2 ? fieldValueTypeV2(pair.field) : fieldValueType(pair.field);
};

const crossFormatFieldTypesCompatible = (
  source: ApplicationFieldValuePair,
  target: ApplicationFieldValuePair,
): boolean => {
  if (
    fieldDeclaredResultType(source.field) === "whole_number" &&
    fieldDeclaredResultType(target.field) === "whole_number"
  )
    return true;
  return valueTypesCompatible(
    applicationFieldType(source),
    applicationFieldType(target),
    "cross_format",
  );
};

const actionValueReferenceEntry = (entry: JsonObject): JsonObject | undefined =>
  actionValueReferenceSources.has(String(entry.source))
    ? entry
    : actionValueReference(entry);

function applicationActionValueCompatible(
  value: unknown,
  target: ApplicationFieldValuePair | undefined,
  subjectFields: ReadonlyMap<string, JsonObject>,
  subjectModuleV2: boolean,
  inputs: ReadonlyMap<string, JsonObject>,
  subjectRecordTypeId: string,
): boolean {
  if (!target) return false;
  const entry = object(value);
  if (entry.kind === "literal")
    return target.moduleV2
      ? fieldValueMatchesV2(actionValueLiteral(value), target.field, "canonical")
      : valueTypesCompatible(
          literalValueType(actionValueLiteral(value)),
          fieldValueType(target.field),
          "value",
        );
  const reference = actionValueReference(value);
  if (reference?.source === "trigger_record" && subjectModuleV2 !== target.moduleV2) {
    const sourceField = actionFieldByKey(subjectFields, String(reference.field));
    if (
      !sourceField ||
      !crossFormatFieldTypesCompatible({ field: sourceField, moduleV2: subjectModuleV2 }, target)
    )
      return false;
  }
  if (
    target.moduleV2 &&
    reference?.source === "input" &&
    (inputs.get(String(reference.name))?.type === "formatted_text" ||
      (inputs.get(String(reference.name))?.type === "number" &&
        ["decimal_number", "money"].includes(applicationFieldType(target) ?? "")))
  )
    return false;
  if (
    target.moduleV2 &&
    !valueTypesCompatible(
      actionValueTypeV2(value, subjectFields, inputs),
      applicationFieldType(target),
      "mapping",
    )
  )
    return false;
  return target.moduleV2
    ? actionValueCompatibleV2(value, target.field, subjectFields, inputs, subjectRecordTypeId)
    : actionValueCompatible(value, target.field, subjectFields, inputs, subjectRecordTypeId);
}

function applicationConditionUsesLossyInput(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  inputTypes: ReadonlyMap<string, string>,
): boolean {
  if (value === null || value === undefined) return false;
  const condition = object(value);
  if (condition.kind === "all" || condition.kind === "any")
    return array(condition.conditions).some((entry) =>
      applicationConditionUsesLossyInput(entry, fields, inputTypes),
    );
  if (condition.kind === "not")
    return applicationConditionUsesLossyInput(condition.condition, fields, inputTypes);
  if (condition.kind !== "comparison") return false;
  const exactFieldType = (operandValue: unknown) => {
    const operand = object(operandValue);
    if (operand.source !== "field") return undefined;
    const type = fieldValueTypeV2(fields.get(String(operand.fieldId)));
    return type === "decimal_number" || type === "money" ? type : undefined;
  };
  const isLegacyNumberInput = (operandValue: unknown) => {
    const operand = object(operandValue);
    return operand.source === "parameter" && inputTypes.get(String(operand.key)) === "number";
  };
  return (
    (exactFieldType(condition.left) !== undefined && isLegacyNumberInput(condition.right)) ||
    (exactFieldType(condition.right) !== undefined && isLegacyNumberInput(condition.left))
  );
}

const applicationConditionTypesValid = (
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  moduleV2: boolean,
  inputTypes: ReadonlyMap<string, string> = new Map(),
): boolean =>
  moduleV2
    ? !applicationConditionUsesLossyInput(value, fields, inputTypes) &&
      conditionTypesValidV2(value, fields, inputTypes)
    : conditionTypesValid(value, fields, inputTypes);

const applicationInterfaceFieldType = (
  pair: ApplicationFieldValuePair | undefined,
): string | undefined => {
  const type = applicationFieldType(pair);
  if (!pair?.moduleV2) return type;
  if (type === "whole_number" || type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (["text", "date", "date_time", "record_reference"].includes(String(type))) return type;
  return undefined;
};

function permissionRecordScopesValid(
  permissions: readonly JsonObject[],
  records: ReadonlyMap<string, JsonObject>,
  relationships: ReadonlyMap<string, JsonObject>,
  sharingConditions: ReadonlyMap<string, JsonObject> = new Map(),
  savedConditionsAllowed = false,
  availablePermissions: readonly JsonObject[] = permissions,
  v2SavedConditionIds: ReadonlySet<string> = new Set(),
): boolean {
  const permissionsById = new Map(
    availablePermissions.map((permission) => [String(permission.permissionId), permission]),
  );
  const relationshipSources = new Map<string, string[]>();
  let valid = true;
  for (const permission of permissions) {
    const recordTypeId =
      permission.recordTypeId === undefined ? undefined : String(permission.recordTypeId);
    const scope = permission.recordScope ? object(permission.recordScope) : undefined;
    const fieldPolicy = permission.fieldPolicy ? object(permission.fieldPolicy) : undefined;
    if (
      (recordTypeId === undefined) !== (scope === undefined) ||
      (recordTypeId === undefined) !== (fieldPolicy === undefined)
    ) {
      valid = false;
      continue;
    }
    if (!scope || !fieldPolicy || recordTypeId === undefined) continue;
    const record = records.get(recordTypeId);
    if (!record) {
      valid = false;
      continue;
    }
    const fieldIds = new Set(array(record.fields).map((field) => String(field.fieldId)));
    if (
      [...array(fieldPolicy.readableFieldIds), ...array(fieldPolicy.changeableFieldIds)].some(
        (fieldId) => !fieldIds.has(String(fieldId)),
      )
    )
      valid = false;
    const sources: string[] = [];
    for (const route of array(scope.routes)) {
      if (route.kind === "ownership" && record.ownershipMode === "none") valid = false;
      if (route.kind !== "relationship") continue;
      const relationship = relationships.get(String(route.relationshipId));
      const sourcePermission = permissionsById.get(String(route.sourcePermissionId));
      const targets = relationship?.toRecordType
        ? [relationship.toRecordType]
        : array(relationship?.toRecordTypes);
      if (
        !relationship ||
        !sourcePermission ||
        sourcePermission.actionKind !== "read" ||
        String(sourcePermission.recordTypeId) !== String(relationship.fromRecordTypeId) ||
        !targets.some(
          (target) =>
            object(target).state === "resolved" &&
            String(object(target).recordTypeId) === recordTypeId,
        )
      )
        valid = false;
      else sources.push(String(sourcePermission.permissionId));
    }
    relationshipSources.set(String(permission.permissionId), sources);
    const restriction = scope.savedCondition ? object(scope.savedCondition) : undefined;
    if (!restriction) continue;
    const saved = sharingConditions.get(String(restriction.conditionId));
    const declaredParameters = new Map(
      saved
        ? array(saved.parameters).map(
            (parameter) => [String(parameter.key), String(parameter.type)] as const,
          )
        : [],
    );
    const bindings = array(restriction.parameterBindings);
    const savedConditionV2 = v2SavedConditionIds.has(String(restriction.conditionId));
    if (
      !savedConditionsAllowed ||
      !saved ||
      String(saved.sourceRecordTypeId) !== recordTypeId ||
      saved.publishedRevision !== restriction.publishedRevision ||
      saved.contractFingerprint !== restriction.contractFingerprint ||
      bindings.length !== declaredParameters.size ||
      new Set(bindings.map((binding) => String(binding.key))).size !== bindings.length ||
      bindings.some((binding) => {
        const expected = declaredParameters.get(String(binding.key));
        return (
          expected === undefined ||
          (binding.source === "current_organization_account_id"
            ? !["text", "organization_account_reference"].includes(expected)
            : !(savedConditionV2
                ? expected === "decimal_number"
                  ? exactDecimalTextV2Schema.safeParse(binding.value).success
                  : expected === "money"
                    ? moneyValueV2Schema.safeParse(binding.value).success
                    : valueMatchesType(binding.value, expected)
                : valueMatchesType(binding.value, expected)))
        );
      })
    )
      valid = false;
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (permissionId: string): boolean => {
    if (visiting.has(permissionId)) return false;
    if (visited.has(permissionId)) return true;
    visiting.add(permissionId);
    const acyclic = (relationshipSources.get(permissionId) ?? []).every(visit);
    visiting.delete(permissionId);
    visited.add(permissionId);
    return acyclic;
  };
  if (!permissions.map((permission) => String(permission.permissionId)).every(visit)) valid = false;
  return valid;
}

function moduleReferenceRule(context: PreparedValidationContext): DefinitionRuleFailure[] {
  const walkValues = context.walkCanonicalValues ?? canonicalValueWalker(context);
  const failures: DefinitionRuleFailure[] = [];
  const moduleOutputs = context.outputs.filter((output) => output.kind === "module");
  const availableModuleOutputs = allValidationOutputs(context).filter(
    (output) => output.kind === "module",
  );
  const permissionOwnersById = new Map<string, Set<string>>();
  for (const output of availableModuleOutputs) {
    const canonical = object(output.canonical);
    const moduleRootId = String(object(canonical.envelope).rootId);
    for (const permission of array(object(canonical.content).permissions)) {
      const permissionId = String(permission.permissionId);
      const owners = permissionOwnersById.get(permissionId) ?? new Set<string>();
      owners.add(moduleRootId);
      permissionOwnersById.set(permissionId, owners);
    }
  }
  const recordIdentity = (moduleRootId: string, recordTypeId: string): string =>
    `${moduleRootId}:${recordTypeId}`;
  const records = new Map<
    string,
    { record: JsonObject; moduleRootId: string; allowedModuleRoots: ReadonlySet<string> }
  >();
  const moduleContentByRootId = new Map<string, JsonObject>();
  for (const output of availableModuleOutputs) {
    const canonical = object(output.canonical);
    const content = object(canonical.content);
    const moduleRootId = String(object(canonical.envelope).rootId);
    moduleContentByRootId.set(moduleRootId, content);
    const allowedModuleRoots = new Set([
      moduleRootId,
      ...array(content.dependencies).map((dependency) => String(dependency.moduleRootId)),
    ]);
    for (const record of array(content.recordTypes))
      records.set(recordIdentity(moduleRootId, String(record.recordTypeId)), {
        record,
        moduleRootId,
        allowedModuleRoots,
      });
  }
  const recordReference = (
    reference: unknown,
    allowedModuleRoots: ReadonlySet<string>,
  ): JsonObject | undefined => {
    const resolved = object(reference);
    if (resolved.state !== "resolved") return undefined;
    const target = records.get(
      recordIdentity(String(resolved.moduleRootId), String(resolved.recordTypeId)),
    );
    if (!target || !allowedModuleRoots.has(target.moduleRootId)) return undefined;
    return target.record;
  };
  const inheritedOwnershipValid = (moduleRootId: string, record: JsonObject): boolean => {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (currentModuleRootId: string, currentRecord: JsonObject): boolean => {
      const identity = recordIdentity(currentModuleRootId, String(currentRecord.recordTypeId));
      if (visiting.has(identity)) return false;
      if (visited.has(identity)) return true;
      if (["organization_account", "group"].includes(String(currentRecord.ownershipMode))) {
        visited.add(identity);
        return true;
      }
      if (currentRecord.ownershipMode !== "inherited") return false;
      const relationship = array(currentRecord.relationships).find(
        (candidate) =>
          String(candidate.relationshipId) === String(currentRecord.ownershipRelationshipId),
      );
      const current = records.get(identity);
      const targets = relationship?.toRecordType
        ? [relationship.toRecordType]
        : array(relationship?.toRecordTypes);
      if (
        !relationship ||
        !current ||
        String(relationship.fromRecordTypeId) !== String(currentRecord.recordTypeId) ||
        targets.length === 0
      )
        return false;
      visiting.add(identity);
      const valid = targets.every((targetReference) => {
        const target = object(targetReference);
        if (target.state !== "resolved") return false;
        const targetModuleRootId = String(target.moduleRootId);
        const targetRecord = records.get(
          recordIdentity(targetModuleRootId, String(target.recordTypeId)),
        );
        return (
          current.allowedModuleRoots.has(targetModuleRootId) &&
          targetRecord !== undefined &&
          visit(targetModuleRootId, targetRecord.record)
        );
      });
      visiting.delete(identity);
      if (valid) visited.add(identity);
      return valid;
    };
    return visit(moduleRootId, record);
  };
  const fieldReferencesValid = (value: unknown, fields: ReadonlySet<string>): boolean => {
    let valid = true;
    walkValues(value, (entry) => {
      for (const [key, candidate] of Object.entries(entry))
        if ((key === "fieldId" || key.endsWith("FieldId")) && !fields.has(String(candidate)))
          valid = false;
    });
    return valid;
  };
  /**
   * Every field of one record type that the engines must work out when a record is read. A
   * deadline-passed calculation is read-time by its expression, and any calculation that
   * depends on a read-time calculation is itself read-time. Stored values may never depend on
   * one, so publication refuses a calculation declared `stored` in this set, and a total whose
   * aggregate source or filter reads it. Content without an evaluation is classified here.
   */
  const readTimeFieldIdsFor = (recordFields: readonly JsonObject[]): ReadonlySet<string> => {
    const fieldById = new Map(recordFields.map((field) => [String(field.fieldId), field] as const));
    const classification = new Map<string, boolean>();
    const isReadTime = (fieldId: string, visiting: ReadonlySet<string>): boolean => {
      const cached = classification.get(fieldId);
      if (cached !== undefined) return cached;
      const field = fieldById.get(fieldId);
      if (!field || field.type !== "calculation" || visiting.has(fieldId)) return false;
      const settings = object(field.settings);
      const expression = object(settings.expression);
      const nextVisiting = new Set(visiting).add(fieldId);
      const readTime =
        expression.kind === "deadline_passed" ||
        settings.evaluation === "read_time" ||
        array(settings.dependencyFieldIds).some((dependency) =>
          isReadTime(String(dependency), nextVisiting),
        );
      classification.set(fieldId, readTime);
      return readTime;
    };
    const result = new Set<string>();
    for (const field of recordFields) {
      const fieldId = String(field.fieldId);
      if (isReadTime(fieldId, new Set())) result.add(fieldId);
    }
    return result;
  };
  const conditionReadsReadTime = (
    value: unknown,
    readTimeFieldIds: ReadonlySet<string>,
  ): boolean => {
    let found = false;
    walkValues(value, (entry) => {
      if (entry.source === "field" && readTimeFieldIds.has(String(entry.fieldId))) found = true;
    });
    return found;
  };

  for (const output of moduleOutputs) {
    const canonical = object(output.canonical);
    const envelope = object(canonical.envelope);
    const content = object(canonical.content);
    const moduleRootId = String(envelope.rootId);
    const allowedModuleRoots = new Set([
      moduleRootId,
      ...array(content.dependencies).map((dependency) => String(dependency.moduleRootId)),
    ]);
    const declaredDependencies = new Set(
      array(content.dependencies).map((dependency) => fingerprintCanonicalValue(dependency)),
    );
    const choicePermissionValid = (permissionId: unknown): boolean => {
      const owners = permissionOwnersById.get(String(permissionId));
      return owners !== undefined && owners.size === 1 && allowedModuleRoots.has([...owners][0]!);
    };
    const moduleRecords = new Map(
      array(content.recordTypes).map((record) => [String(record.recordTypeId), record]),
    );
    const modulePermissions = array(content.permissions);
    const modulePermissionsByKey = new Map(
      modulePermissions.map((permission) => [String(permission.key), permission]),
    );
    const actionsById = new Map(
      array(content.actions).map((action) => [String(action.actionId), action]),
    );
    const events = new Set(array(content.events).map((event) => String(event.key)));
    const relationships = new Map(
      [...moduleRecords.values()].flatMap((record) =>
        array(record.relationships).map(
          (relationship) => [String(relationship.relationshipId), relationship] as const,
        ),
      ),
    );
    const sharingConditions = new Map(
      array(content.sharingConditions).map(
        (condition) => [String(condition.conditionId), condition] as const,
      ),
    );
    if (
      !permissionRecordScopesValid(
        modulePermissions,
        moduleRecords,
        relationships,
        sharingConditions,
        true,
        modulePermissions,
        new Set(sharingConditions.keys()),
      )
    )
      failures.push(
        failure(output, "vortex.definition.module_record_references", "scope_conflict"),
      );

    if (
      [...moduleRecords.values()].some(
        (record) =>
          record.ownershipMode === "inherited" && !inheritedOwnershipValid(moduleRootId, record),
      )
    )
      failures.push(
        failure(output, "vortex.definition.module_record_references", "scope_conflict"),
      );

    for (const record of moduleRecords.values()) {
      const recordId = String(record.recordTypeId);
      const fieldMap = new Map(array(record.fields).map((field) => [String(field.fieldId), field]));
      const fields = new Set(fieldMap.keys());
      const relationships = new Set(
        array(record.relationships).map((relationship) => String(relationship.relationshipId)),
      );
      if (
        !fields.has(String(record.titleFieldId)) ||
        (record.ownershipRelationshipId &&
          !relationships.has(String(record.ownershipRelationshipId))) ||
        (record.customActionIds as string[]).some((actionId) => !actionsById.has(actionId))
      )
        failures.push(
          failure(output, "vortex.definition.module_record_references", "broken_reference"),
        );
      for (const relationship of array(record.relationships)) {
        const fromField = array(record.fields).find(
          (field) => String(field.fieldId) === String(relationship.fromFieldId),
        );
        const targets = relationship.toRecordType
          ? [relationship.toRecordType]
          : (relationship.toRecordTypes as unknown[]);
        const fieldTargets =
          fromField?.type === "link"
            ? [object(fromField.settings).target]
            : fromField?.type === "link_to_one_of_several"
              ? (object(fromField.settings).targets as unknown[])
              : [];
        const targetIds = targets
          .map((target) => String(object(target).recordTypeId))
          .sort(compareCanonicalStrings);
        const fieldTargetIds = fieldTargets
          .map((target) => String(object(target).recordTypeId))
          .sort(compareCanonicalStrings);
        if (
          String(relationship.fromRecordTypeId) !== recordId ||
          !fromField ||
          JSON.stringify(targetIds) !== JSON.stringify(fieldTargetIds) ||
          object(fromField.settings).onParentDelete !== relationship.onParentDelete ||
          targets.some((target) => !recordReference(target, allowedModuleRoots))
        )
          failures.push(
            failure(output, "vortex.definition.module_relationship_references", "broken_reference"),
          );
      }
      const readTimeFieldIds = readTimeFieldIdsFor(array(record.fields));
      for (const field of array(record.fields)) {
        const settings = object(field.settings);
        let valid = true;
        const choiceSettings = [
          ...(["choice", "several_choices"].includes(String(field.type)) ? [settings] : []),
          ...(field.type === "table"
            ? array(settings.columns)
                .filter((column) => column.type === "choice" && column.settings !== undefined)
                .map((column) => object(column.settings))
            : []),
        ];
        if (
          choiceSettings.some((choice) =>
            array(choice.options).some(
              (option) =>
                option.requiredPermissionId !== undefined &&
                !choicePermissionValid(option.requiredPermissionId),
            ),
          ) ||
          (field.type === "table" &&
            array(settings.columns).some((column) => column.settings === undefined))
        )
          valid = false;
        if (field.type === "link")
          valid = recordReference(settings.target, allowedModuleRoots) !== undefined;
        if (field.type === "link_to_one_of_several")
          valid = (settings.targets as unknown[]).every(
            (target) => recordReference(target, allowedModuleRoots) !== undefined,
          );
        if (field.type === "calculation") {
          const expression = object(settings.expression);
          const expectedDependencies = calculationDependencyFieldIdsV2(expression);
          valid =
            (settings.dependencyFieldIds as string[]).every((fieldId) => fields.has(fieldId)) &&
            fieldReferencesValid(settings.expression, fields) &&
            JSON.stringify([...new Set(settings.dependencyFieldIds as string[])]) ===
              JSON.stringify(expectedDependencies) &&
            (["decimal_number", "money"].includes(String(settings.resultType))
              ? settings.decimalPlaces !== undefined
              : settings.decimalPlaces === undefined);
          if (settings.evaluation === "stored" && readTimeFieldIds.has(String(field.fieldId)))
            valid = false;
          if (expression.kind === "join_text")
            valid =
              valid &&
              (expression.fieldIds as string[]).every((id) =>
                ["text", "choice"].includes(fieldValueTypeV2(fieldMap.get(id)) ?? ""),
              );
          if (expression.kind === "numeric")
            valid =
              valid && numericExpressionValidV2(expression, String(settings.resultType), fieldMap);
          if (expression.kind === "condition")
            valid = valid && conditionTypesValidV2(expression.condition, fieldMap);
          if (expression.kind === "date_offset") {
            const amount = object(expression.amount);
            valid =
              valid &&
              ["date", "date_time"].includes(
                fieldValueTypeV2(fieldMap.get(String(expression.dateFieldId))) ?? "",
              ) &&
              fieldValueTypeV2(fieldMap.get(String(expression.dateFieldId))) ===
                settings.resultType &&
              ((amount.source === "literal" && exactIntegerLiteralV2(amount.value)) ||
                (amount.source === "field" &&
                  fieldValueTypeV2(fieldMap.get(String(amount.fieldId))) === "whole_number"));
          }
          if (expression.kind === "deadline_passed") {
            const statusField =
              expression.statusFieldId === undefined
                ? undefined
                : fieldMap.get(String(expression.statusFieldId));
            valid =
              valid &&
              ["date", "date_time"].includes(
                fieldValueTypeV2(fieldMap.get(String(expression.dueFieldId))) ?? "",
              ) &&
              (expression.statusFieldId === undefined ||
                ["text", "choice"].includes(fieldValueTypeV2(statusField) ?? "")) &&
              (expression.statusFieldId !== undefined ||
                array(expression.terminalStatusValues).length === 0) &&
              (statusField === undefined ||
                array(expression.terminalStatusValues).every((value) =>
                  fieldValueMatchesV2(value, statusField, "canonical"),
                ));
          }
        }
        if (field.type === "total") {
          const aggregateRelationship = [...records.values()]
            .filter((entry) => allowedModuleRoots.has(entry.moduleRootId))
            .flatMap((entry) =>
              array(entry.record.relationships).map((relationship) => ({
                relationship,
                sourceRecord: entry.record,
              })),
            )
            .find(
              (entry) =>
                String(entry.relationship.relationshipId) === String(settings.relationshipId),
            );
          const targets = aggregateRelationship?.relationship.toRecordType
            ? [aggregateRelationship.relationship.toRecordType]
            : ((aggregateRelationship?.relationship.toRecordTypes as unknown[] | undefined) ?? []);
          const reachesCurrentRecord =
            aggregateRelationship !== undefined &&
            targets.some(
              (target) => String(object(target).recordTypeId) === String(record.recordTypeId),
            );
          const aggregateFieldMap = new Map(
            aggregateRelationship
              ? array(aggregateRelationship.sourceRecord.fields).map((candidate) => [
                  String(candidate.fieldId),
                  candidate,
                ])
              : [],
          );
          const aggregateFields = new Set(aggregateFieldMap.keys());
          const aggregateField =
            settings.fieldId === undefined
              ? undefined
              : aggregateFieldMap.get(String(settings.fieldId));
          const aggregateResultType = fieldDeclaredResultType(aggregateField);
          const filterValid =
            settings.filter === undefined ||
            (fieldReferencesValid(settings.filter, aggregateFields) &&
              conditionTypesValidV2(settings.filter, aggregateFieldMap));
          const currencyValid =
            settings.currency === undefined ||
            (settings.operation === "sum" && aggregateResultType === "money");
          const aggregateReadTimeFieldIds = aggregateRelationship
            ? readTimeFieldIdsFor(array(aggregateRelationship.sourceRecord.fields))
            : new Set<string>();
          const readTimeDependent =
            (settings.fieldId !== undefined &&
              aggregateReadTimeFieldIds.has(String(settings.fieldId))) ||
            (settings.filter !== undefined &&
              conditionReadsReadTime(settings.filter, aggregateReadTimeFieldIds));
          valid =
            aggregateRelationship !== undefined &&
            reachesCurrentRecord &&
            filterValid &&
            !readTimeDependent &&
            currencyValid &&
            (settings.operation === "count"
              ? settings.fieldId === undefined
              : aggregateField !== undefined) &&
            (!["sum", "average"].includes(String(settings.operation)) ||
              ["whole_number", "decimal_number", "money"].includes(
                fieldValueTypeV2(aggregateField) ?? "",
              ));
          const declaredResultType = String(settings.resultType);
          const resultTypeValid =
            (settings.operation === "count" && declaredResultType === "whole_number") ||
            (settings.operation === "average" &&
              declaredResultType ===
                (aggregateResultType === "money" ? "money" : "decimal_number")) ||
            (["sum", "minimum", "maximum"].includes(String(settings.operation)) &&
              declaredResultType === aggregateResultType);
          const precisionValid =
            settings.operation === "average"
              ? settings.decimalPlaces !== undefined
              : settings.decimalPlaces === undefined;
          valid = valid && resultTypeValid && precisionValid;
        }
        if (!valid)
          failures.push(
            failure(output, "vortex.definition.module_field_references", "broken_reference"),
          );
      }
      const calculationIds = new Set(
        array(record.fields)
          .filter((field) => field.type === "calculation")
          .map((field) => String(field.fieldId)),
      );
      const calculationDependencies = new Map(
        array(record.fields)
          .filter((field) => field.type === "calculation")
          .map((field) => [
            String(field.fieldId),
            (object(field.settings).dependencyFieldIds as string[]).filter((fieldId) =>
              calculationIds.has(fieldId),
            ),
          ]),
      );
      const visitingCalculations = new Set<string>();
      const visitedCalculations = new Set<string>();
      let calculationCycle = false;
      const visitCalculation = (fieldId: string) => {
        if (visitingCalculations.has(fieldId)) {
          calculationCycle = true;
          return;
        }
        if (visitedCalculations.has(fieldId)) return;
        visitingCalculations.add(fieldId);
        for (const dependency of calculationDependencies.get(fieldId) ?? [])
          visitCalculation(dependency);
        visitingCalculations.delete(fieldId);
        visitedCalculations.add(fieldId);
      };
      [...calculationDependencies.keys()].sort(compareCanonicalStrings).forEach(visitCalculation);
      if (calculationCycle)
        failures.push(
          failure(output, "vortex.definition.module_calculation_acyclic", "dependency_cycle"),
        );
    }

    for (const action of actionsById.values()) {
      const subject = moduleRecords.get(String(action.subjectRecordTypeId));
      const fieldMap = new Map(
        subject ? array(subject.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      const fields = new Set(fieldMap.keys());
      const relationships = new Set(
        subject
          ? array(subject.relationships).map((relationship) => String(relationship.relationshipId))
          : [],
      );
      const inputMap = new Map(array(action.inputs).map((input) => [String(input.key), input]));
      const inputKeys = new Set(inputMap.keys());
      const inputTypes = new Map(
        [...inputMap].map(([key, input]) => [
          key,
          semanticFieldTypeV2(input.type) ?? "",
        ]),
      );
      let valid =
        subject !== undefined &&
        actionPermissionKeys(action).length > 0 &&
        actionPermissionsMatch(action, modulePermissionsByKey) &&
        fieldReferencesValid(action.precondition, fields) &&
        (action.precondition === undefined ||
          conditionTypesValidV2(action.precondition, fieldMap, inputTypes));
      for (const input of array(action.inputs))
        if (
          input.type === "record_reference" &&
          (input.recordTypes as unknown[]).some(
            (reference) => !recordReference(reference, allowedModuleRoots),
          )
        )
          valid = false;
      for (const task of array(action.tasks)) {
        const properties = object(task.properties);
        if (String(task.type) === "record.set_fields") {
          for (const [id, value] of Object.entries(object(properties.values)))
            if (
              !fields.has(id) ||
              !actionValueCompatibleV2(
                value,
                fieldMap.get(id),
                fieldMap,
                inputMap,
                String(action.subjectRecordTypeId),
              )
            )
              valid = false;
        }
        if (String(task.type) === "record.changes") {
          for (const change of array(properties.changes)) {
            if (
              (change.relationshipIds as string[]).some((id) => !relationships.has(id)) ||
              inputMap.get(String(change.targetInputKey))?.type !== "record_reference" ||
              !array(inputMap.get(String(change.targetInputKey))?.recordTypes)
                .map((reference) => String(reference.recordTypeId))
                .includes(String(action.subjectRecordTypeId))
            )
              valid = false;
          }
        }
        if (String(task.type) === "event.announce" && !events.has(String(properties.eventKey)))
          valid = false;
        if (String(task.type) === "record.create") {
          const target = recordReference(properties.recordType, allowedModuleRoots);
          const targetFields = new Map(
            target ? array(target.fields).map((field) => [String(field.fieldId), field]) : [],
          );
          if (
            !target ||
            Object.entries(object(properties.values)).some(
              ([id, value]) =>
                !targetFields.has(id) ||
                !actionValueCompatibleV2(
                  value,
                  targetFields.get(id),
                  fieldMap,
                  inputMap,
                  String(action.subjectRecordTypeId),
                ),
            )
          )
            valid = false;
        }
        walkValues(task, (entry) => {
          const reference = actionValueReferenceEntry(entry);
          if (
            reference?.source === "input" &&
            !inputKeys.has(String(reference.name)) &&
            String(reference.name) !== "record"
          )
            valid = false;
          if (
            reference?.source === "trigger_record" &&
            actionFieldByKey(fieldMap, String(reference.field)) === undefined
          )
            valid = false;
        });
      }
      if (!valid)
        failures.push(
          failure(output, "vortex.definition.module_action_references", "broken_reference"),
        );
      if (!actionDeleteEffectsSupported(action))
        failures.push(
          failure(output, "vortex.definition.module_action_references", "unsupported_choice"),
        );
    }
    for (const event of array(content.events)) {
      const record = moduleRecords.get(String(event.recordTypeId));
      const fields = new Map(
        record ? array(record.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      if (
        !record ||
        (event.carriedFieldIds as string[]).some(
          (fieldId) => !fields.has(fieldId) || fields.get(fieldId)?.personalData !== "none",
        )
      )
        failures.push(
          failure(output, "vortex.definition.module_event_references", "broken_reference"),
        );
    }
    for (const point of array(content.extensionPoints)) {
      const location = { kind: "extension_point" as const, key: String(point.key) };
      if (!moduleRecords.has(String(point.recordTypeId)))
        failures.push(
          failure(
            output,
            "vortex.definition.module_extension_references",
            "broken_reference",
            location,
          ),
        );
      // V1 releases remain readable through their historical contract. New authoring uses V2/V3
      // publication, where the module specification permits only additive fields and actions.
      if (
        "validationContractVersion" in output &&
        (point.accepts as string[]).some((kind) => kind !== "field" && kind !== "action")
      )
        failures.push(
          failure(
            output,
            "vortex.definition.module_extension_capabilities",
            "unsupported_choice",
            location,
          ),
        );
    }
    const contributionIds = new Set<string>();
    for (const contribution of array(content.contributions ?? [])) {
      const targetModule = object(contribution.targetModule);
      const targetRootId = String(targetModule.moduleRootId);
      const targetContent = moduleContentByRootId.get(targetRootId);
      const location = {
        kind: "extension_point" as const,
        key: String(targetModule.moduleKey),
      };
      // A contribution must target exactly one of this module's declared dependency entries,
      // never the contributing module, and that release must declare the extension point it claims.
      if (
        targetRootId === moduleRootId ||
        !declaredDependencies.has(fingerprintCanonicalValue(targetModule)) ||
        targetContent === undefined
      ) {
        failures.push(
          failure(
            output,
            "vortex.definition.module_extension_references",
            "broken_reference",
            location,
          ),
        );
        continue;
      }
      const point = array(targetContent.extensionPoints).find(
        (candidate) =>
          String(candidate.extensionPointId) === String(contribution.targetExtensionPointId),
      );
      if (point === undefined) {
        failures.push(
          failure(
            output,
            "vortex.definition.module_extension_references",
            "broken_reference",
            location,
          ),
        );
        continue;
      }
      if (!(point.accepts as string[]).includes(String(contribution.kind)))
        failures.push(
          failure(
            output,
            "vortex.definition.module_extension_capabilities",
            "unsupported_choice",
            location,
          ),
        );
      const contributedValid =
        contribution.kind === "field"
          ? (() => {
              const record = moduleRecords.get(String(contribution.recordTypeId));
              return (
                record !== undefined &&
                array(record.fields).some(
                  (field) => String(field.fieldId) === String(contribution.fieldId),
                )
              );
            })()
          : actionsById.has(String(contribution.actionId));
      if (!contributedValid)
        failures.push(
          failure(
            output,
            "vortex.definition.module_extension_references",
            "broken_reference",
            location,
          ),
        );
      const contributionId = String(contribution.contributionId);
      if (contributionIds.has(contributionId))
        failures.push(
          failure(
            output,
            "vortex.definition.module_extension_references",
            "duplicate_key",
            location,
          ),
        );
      contributionIds.add(contributionId);
    }
    for (const condition of array(content.sharingConditions)) {
      const record = moduleRecords.get(String(condition.sourceRecordTypeId));
      const fieldMap = new Map(
        record ? array(record.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      const fields = new Set(fieldMap.keys());
      const parameterTypes = new Map(
        array(condition.parameters).map((parameter) => [
          String(parameter.key),
          String(parameter.type),
        ]),
      );
      let valid =
        record !== undefined &&
        (condition.declaredFieldIds as string[]).every((fieldId) => fields.has(fieldId)) &&
        fieldReferencesValid(condition.condition, fields) &&
        conditionTypesValidV2(condition.condition, fieldMap, parameterTypes);
      try {
        for (const publicationTest of array(condition.publicationTests))
          if (
            evaluateSavedSharingCondition(
              condition,
              object(publicationTest.fieldValues),
              object(publicationTest.parameters),
              [...fieldMap.values()] as ModuleFieldV3[],
            ) !== publicationTest.expected
          )
            valid = false;
      } catch {
        valid = false;
      }
      if (!valid)
        failures.push(
          failure(output, "vortex.definition.module_sharing_condition", "broken_reference"),
        );
    }
    // Module-owned queries exist only in the current Module contract, so they always read field
    // meaning through its exact value types rather than the superseded module value model.
    for (const query of array(content.queries)) {
      const location = { kind: "query" as const, key: String(query.key) };
      const targetRecord = recordReference(query.recordType, allowedModuleRoots);
      if (!targetRecord) {
        failures.push(
          failure(
            output,
            "vortex.definition.module_query_references",
            "broken_reference",
            location,
          ),
        );
        continue;
      }
      const fieldMap = new Map(
        array(targetRecord.fields).map((field) => [String(field.fieldId), field]),
      );
      const fields = new Set(fieldMap.keys());
      const selectedFieldIds = (query.selectedFieldIds as string[]).map(String);
      const groupByFieldIds = (query.groupByFieldIds as string[]).map(String);
      const sortFieldIds = array(query.sort).map((sort) => String(sort.fieldId));
      const aggregateFieldIds = array(query.aggregates).flatMap((aggregate) =>
        aggregate.fieldId === undefined ? [] : [String(aggregate.fieldId)],
      );
      const aggregateAliases = array(query.aggregates).map((aggregate) => String(aggregate.alias));
      const selectedFieldKeys = selectedFieldIds.map((id) => String(fieldMap.get(id)?.key));
      const unique = (values: readonly string[]) => new Set(values).size === values.length;
      // Grouping decides the row shape, so a grouped query returns and orders by its grouping
      // keys only, and a total needs a grouping key to belong to.
      const groupingValid =
        groupByFieldIds.length > 0
          ? selectedFieldIds.every((id) => groupByFieldIds.includes(id)) &&
            sortFieldIds.every((id) => groupByFieldIds.includes(id))
          : aggregateAliases.length === 0;
      const aggregatesValid = array(query.aggregates).every((aggregate) => {
        if (aggregate.operation === "count") return aggregate.fieldId === undefined;
        if (aggregate.fieldId === undefined) return false;
        const field = fieldMap.get(String(aggregate.fieldId));
        if (!field) return false;
        if (aggregate.operation === "sum" || aggregate.operation === "average")
          return ["whole_number", "decimal_number", "money"].includes(fieldValueTypeV2(field) ?? "");
        return !["formatted_text", "table", "attachment", "link_to_one_of_several"].includes(
          String(field.type),
        );
      });
      const filterValid =
        !query.filter ||
        (fieldReferencesValid(query.filter, fields) &&
          conditionTypesValidV2(
            query.filter,
            fieldMap,
            new Map(
              array(query.inputs).map((input) => [
                String(input.key),
                semanticFieldTypeV2(input.type) ?? "",
              ]),
            ),
          ));
      if (
        [...selectedFieldIds, ...groupByFieldIds, ...sortFieldIds, ...aggregateFieldIds].some(
          (id) => !fields.has(id),
        ) ||
        !unique(selectedFieldIds) ||
        !unique(groupByFieldIds) ||
        !unique(sortFieldIds) ||
        // Every returned column needs one unambiguous name in the result row.
        !unique([...selectedFieldKeys, ...aggregateAliases]) ||
        !groupingValid ||
        !aggregatesValid ||
        !filterValid
      )
        failures.push(
          failure(
            output,
            "vortex.definition.module_query_references",
            "broken_reference",
            location,
          ),
        );
    }
  }
  return failures;
}

function applicationRule(context: PreparedValidationContext): DefinitionRuleFailure[] {
  const walkValues = context.walkCanonicalValues ?? canonicalValueWalker(context);
  const failures: DefinitionRuleFailure[] = [];
  const availableOutputs = allValidationOutputs(context);
  const modules = availableOutputs.filter((output) => output.kind === "module");
  const connections = availableOutputs.filter((output) => output.kind === "connection_type");
  for (const output of context.outputs.filter((entry) => entry.kind === "application")) {
    const content = object(object(output.canonical).content);
    const bindings = array(content.moduleBindings);
    const connectionBindingEntries = array(content.connectionBindings);
    const request = context.requests.find(
      (candidate) => candidate.source.key === outputKey(output),
    );
    const expectedManifest = [
      ...bindings.map((binding) =>
        request?.resolution.definitions.find(
          (definition) =>
            definition.kind === "module" && definition.rootId === binding.moduleRootId,
        ),
      ),
      ...connectionBindingEntries.map((binding) =>
        request?.resolution.definitions.find(
          (definition) =>
            definition.kind === "connection_type" && definition.rootId === binding.connectionTypeId,
        ),
      ),
    ];
    const expectedManifestFingerprints = expectedManifest
      .filter((entry) => entry !== undefined)
      .map((entry) => fingerprintCanonicalValue(entry))
      .sort(compareCanonicalStrings);
    const recordedManifestFingerprints = output.resolvedDependencies
      .map((entry) => fingerprintCanonicalValue(entry))
      .sort(compareCanonicalStrings);
    if (
      expectedManifest.some((entry) => entry === undefined) ||
      expectedManifestFingerprints.length !== recordedManifestFingerprints.length ||
      expectedManifestFingerprints.some(
        (fingerprint, index) => fingerprint !== recordedManifestFingerprints[index],
      )
    )
      failures.push(
        failure(output, "vortex.definition.application_dependency_manifest", "broken_reference"),
      );
    const boundRoots = new Set(bindings.map((binding) => String(binding.moduleRootId)));
    const boundModules = modules.filter((module) => {
      const rootId = String(object(object(module.canonical).envelope).rootId);
      const expected = request?.resolution.definitions.find(
        (definition) => definition.kind === "module" && definition.rootId === rootId,
      );
      return (
        boundRoots.has(rootId) &&
        expected?.key === module.artifact.definitionKey &&
        expected.exactVersion === module.artifact.exactVersion &&
        module.artifact.rootId === rootId &&
        module.artifact.resolutionFingerprint === module.resolutionFingerprint &&
        module.artifact.contentFingerprint ===
          fingerprintCanonicalValue(object(module.canonical).content)
      );
    });
    const recordTypes = boundModules.flatMap((module) =>
      array(object(object(module.canonical).content).recordTypes),
    );
    const records = new Map(recordTypes.map((record) => [String(record.recordTypeId), record]));
    const recordValuePairs = new Map<string, ApplicationFieldValuePair["moduleV2"]>(
      boundModules.flatMap((module) =>
        array(object(object(module.canonical).content).recordTypes).map(
          (record) => [String(record.recordTypeId), "validationContractVersion" in module] as const,
        ),
      ),
    );
    const allFields = new Map(
      recordTypes.flatMap((record) =>
        array(record.fields).map((field) => [String(field.fieldId), field] as const),
      ),
    );
    const fieldValuePairs = new Map<string, ApplicationFieldValuePair>(
      boundModules.flatMap((module) =>
        array(object(object(module.canonical).content).recordTypes).flatMap((record) =>
          array(record.fields).map(
            (field) =>
              [
                String(field.fieldId),
                { field, moduleV2: "validationContractVersion" in module },
              ] as const,
          ),
        ),
      ),
    );
    const relationshipMap = new Map(
      recordTypes.flatMap((record) =>
        array(record.relationships).map(
          (relationship) => [String(relationship.relationshipId), relationship] as const,
        ),
      ),
    );
    const allRelationships = new Set(relationshipMap.keys());
    const fieldRecordTypes = new Map(
      recordTypes.flatMap((record) =>
        array(record.fields).map(
          (field) => [String(field.fieldId), String(record.recordTypeId)] as const,
        ),
      ),
    );
    const permissionEntries = [
      ...array(content.permissions),
      ...boundModules.flatMap((module) =>
        array(object(object(module.canonical).content).permissions),
      ),
    ];
    const permissionMap = new Map(
      permissionEntries.map((permission) => [String(permission.key), permission]),
    );
    const applicationRootId = String(object(object(output.canonical).envelope).rootId);
    const permissionOwnersByKey = new Map([
      ...array(content.permissions).map(
        (permission) => [String(permission.key), `application:${applicationRootId}`] as const,
      ),
      ...boundModules.flatMap((module) =>
        array(object(object(module.canonical).content).permissions).map(
          (permission) => [String(permission.key), `module:${module.artifact.rootId}`] as const,
        ),
      ),
    ]);
    const permissions = new Set(permissionMap.keys());
    // A page access requirement or navigation item may name an exact application or bound-Module
    // permission, or an exact platform administration permission from the shipped platform
    // catalogue. Every other permission requirement stays limited to the application's own
    // permissions, so a key this release cannot enforce is refused rather than accepted.
    const pageNavigationPermissionKnown = (permissionKey: unknown): boolean => {
      const key = String(permissionKey);
      return permissions.has(key) || isPlatformPermissionKey(key);
    };
    // A requirement key names exactly one permission, and the runtime reads a platform catalogue
    // key as platform authority. An application or bound-Module permission reusing a platform key
    // would make that reference ambiguous, so it is refused.
    if ([...permissions].some(isPlatformPermissionKey))
      failures.push(
        failure(output, "vortex.definition.application_identity_unique", "duplicate_key"),
      );
    const applicationPermissions = new Map(
      array(content.permissions).map((permission) => [String(permission.key), permission]),
    );
    const savedConditionEntries = boundModules.flatMap((module) =>
      array(object(object(module.canonical).content).sharingConditions),
    );
    const savedConditions = new Map(
      savedConditionEntries.map((condition) => [String(condition.conditionId), condition] as const),
    );
    const v2SavedConditionIds = new Set(
      boundModules
        .filter((module) => "validationContractVersion" in module)
        .flatMap((module) =>
          array(object(object(module.canonical).content).sharingConditions).map((condition) =>
            String(condition.conditionId),
          ),
        ),
    );
    if (savedConditions.size !== savedConditionEntries.length)
      failures.push(
        failure(output, "vortex.definition.application_action_references", "scope_conflict"),
      );
    if (
      !permissionRecordScopesValid(
        [...applicationPermissions.values()],
        records,
        relationshipMap,
        savedConditions,
        true,
        permissionEntries,
        v2SavedConditionIds,
      )
    )
      failures.push(
        failure(output, "vortex.definition.application_action_references", "scope_conflict"),
      );
    const actions = new Map(
      [
        ...array(content.actions),
        ...boundModules.flatMap((module) =>
          array(object(object(module.canonical).content).actions),
        ),
      ].map((action) => [String(action.key), action]),
    );
    const moduleActionValuePairs = new Map(
      boundModules.flatMap((module) =>
        array(object(object(module.canonical).content).actions).map(
          (action) =>
            [
              String(action.key),
              { action, moduleV2: "validationContractVersion" in module },
            ] as const,
        ),
      ),
    );
    const publicPermissionSafe = (permissionKey: unknown) => {
      const permission = permissionMap.get(String(permissionKey));
      return permission !== undefined && permission.administrative !== true;
    };
    const publicFieldIds = (record: JsonObject | undefined) =>
      new Set(
        record
          ? array(record.fields)
              .filter((field) => field.publicDisplay === "allowed")
              .map((field) => String(field.fieldId))
          : [],
      );
    const publicActionSafe = (
      actionKey: unknown,
      expectedSubjectRecordId?: string,
      restrictedSubjectFieldIds?: ReadonlySet<string>,
      allowedRelationshipIds: ReadonlySet<string> = new Set(),
    ) => {
      const action = actions.get(String(actionKey));
      const subjectRecord = action ? records.get(String(action.subjectRecordTypeId)) : undefined;
      const subjectFieldIds = restrictedSubjectFieldIds ?? publicFieldIds(subjectRecord);
      if (
        !action ||
        action.sharing !== "allowed" ||
        !subjectRecord ||
        (expectedSubjectRecordId !== undefined &&
          String(action.subjectRecordTypeId) !== expectedSubjectRecordId) ||
        actionPermissionKeys(action).length === 0 ||
        !actionPermissionKeys(action).every(publicPermissionSafe)
      )
        return false;

      let safe = true;
      const subjectFieldIdsByKey = new Map(
        subjectRecord
          ? array(subjectRecord.fields).map(
              (field) => [String(field.key), String(field.fieldId)] as const,
            )
          : [],
      );
      const inspectSubjectReferences = (value: unknown) => {
        walkValues(value, (entry) => {
          const reference = actionValueReferenceEntry(entry);
          if (reference?.source === "trigger_record") {
            const fieldId = subjectFieldIdsByKey.get(String(reference.field));
            if (fieldId === undefined || !subjectFieldIds.has(fieldId)) safe = false;
          }
          if (entry.source === "field" && !subjectFieldIds.has(String(entry.fieldId))) safe = false;
        });
      };
      inspectSubjectReferences(action.precondition);
      for (const task of array(action.tasks)) {
        const properties = object(task.properties);
        if (String(task.type) === "record.set_fields") {
          for (const [fieldId, value] of Object.entries(object(properties.values))) {
            if (!subjectFieldIds.has(fieldId)) safe = false;
            inspectSubjectReferences(value);
          }
        }
        if (String(task.type) === "record.create") {
          const targetRecord = records.get(String(object(properties.recordType).recordTypeId));
          const targetRecordId = String(object(properties.recordType).recordTypeId);
          const targetPublicFields =
            expectedSubjectRecordId !== undefined
              ? (restrictedSubjectFieldIds ?? new Set<string>())
              : publicFieldIds(targetRecord);
          if (
            !targetRecord ||
            (expectedSubjectRecordId !== undefined && targetRecordId !== expectedSubjectRecordId) ||
            Object.keys(object(properties.values)).some(
              (fieldId) => !targetPublicFields.has(fieldId),
            )
          )
            safe = false;
          for (const value of Object.values(object(properties.values)))
            inspectSubjectReferences(value);
        }
        if (
          String(task.type) === "record.changes" &&
          array(properties.changes).some((change) =>
            array(change.relationshipIds).some((id) => !allowedRelationshipIds.has(String(id))),
          )
        )
          safe = false;
      }
      return safe;
    };
    const queryFieldIds = (query: JsonObject) => {
      const usedFields = new Set<string>([
        ...(query.selectedFieldIds as string[]),
        ...(query.groupByFieldIds as string[]),
        ...array(query.sort).map((sort) => String(sort.fieldId)),
        ...array(query.aggregates).flatMap((aggregate) =>
          aggregate.fieldId ? [String(aggregate.fieldId)] : [],
        ),
      ]);
      walkValues(query.filter, (entry) => {
        if (entry.source === "field") usedFields.add(String(entry.fieldId));
      });
      return usedFields;
    };
    const publicQuerySafe = (
      query: JsonObject | undefined,
      expectedRecordTypeId?: string,
      restrictedFieldIds?: ReadonlySet<string>,
    ) => {
      if (!query) return false;
      const recordTypeId = String(object(query.recordType).recordTypeId);
      if (expectedRecordTypeId !== undefined && recordTypeId !== expectedRecordTypeId) return false;
      const allowedFields = restrictedFieldIds ?? publicFieldIds(records.get(String(recordTypeId)));
      return [...queryFieldIds(query)].every((fieldId) => allowedFields.has(fieldId));
    };
    const actionKeys = new Set(actions.keys());
    const standardActionRecordTypes = new Map<string, string>(
      boundModules.flatMap((module) => {
        const canonical = object(module.canonical);
        const moduleKey = String(object(canonical.envelope).key);
        return array(object(canonical.content).recordTypes).flatMap((record) =>
          (record.standardActions as string[]).map(
            (action) =>
              [
                `${moduleKey}.${String(record.key)}.${action}`,
                String(record.recordTypeId),
              ] as const,
          ),
        );
      }),
    );
    const standardActionKeys = new Set(standardActionRecordTypes.keys());
    const standardActionKeysByRecordAction = new Map(
      [...standardActionRecordTypes].map(
        ([key, recordTypeId]) =>
          [`${recordTypeId}:${key.slice(key.lastIndexOf(".") + 1)}`, key] as const,
      ),
    );
    const flowsForCommits = new Map(
      array(content.flows).map((flow) => [String(flow.id), flow as unknown as FlowDefinition]),
    );
    const executableActionKeys = new Set([...actionKeys, ...standardActionKeys]);
    // The record type a committed executable action belongs to: a bound Module's standard record
    // action resolves by its declared record, and a named action by its subject record.
    const commitActionRecordType = (key: string): string | undefined =>
      standardActionRecordTypes.get(key) ??
      (actions.get(key)?.subjectRecordTypeId === undefined
        ? undefined
        : String(actions.get(key)!.subjectRecordTypeId));
    const events = new Map(
      [
        ...array(content.events),
        ...boundModules.flatMap((module) => array(object(object(module.canonical).content).events)),
      ].map((event) => [String(event.key), event]),
    );
    const pages = new Map(array(content.pages).map((page) => [String(page.pageId), page]));
    const shells = new Map(array(content.shells).map((shell) => [String(shell.shellId), shell]));
    const collectPlacementEntriesV2 = (
      slotValue: unknown,
      entries: [string, JsonObject][] = [],
    ): [string, JsonObject][] => {
      const slot = object(slotValue);
      for (const [placementId, placementValue] of Object.entries(object(slot.placements))) {
        const placement = object(placementValue);
        entries.push([placementId, placement]);
        for (const childSlot of Object.values(object(placement.slots)))
          collectPlacementEntriesV2(childSlot, entries);
      }
      return entries;
    };
    const pageContentPlacementEntriesV2 = (page: JsonObject): [string, JsonObject][] => {
      const composition = object(page.composition);
      if ("main" in composition) return collectPlacementEntriesV2(composition.main);
      if ("content" in composition)
        return Object.values(object(composition.content)).flatMap((slotValue) =>
          collectPlacementEntriesV2(slotValue),
        );
      if (composition.shellKind === "default")
        return Object.values(object(composition.stepContent)).flatMap((slotValue) =>
          collectPlacementEntriesV2(slotValue),
        );
      return Object.values(object(composition.stepContent)).flatMap((stepValue) =>
        Object.values(object(stepValue)).flatMap((slotValue) =>
          collectPlacementEntriesV2(slotValue),
        ),
      );
    };
    const pageShellPlacementEntriesV2 = (page: JsonObject): [string, JsonObject][] => {
      const composition = object(page.composition);
      if (composition.shellKind !== "application") return [];
      return collectPlacementEntriesV2(shells.get(String(composition.shellId))?.layout);
    };
    const queries = new Map(array(content.queries).map((query) => [String(query.queryId), query]));
    // The queries a page or placement binds are the ones a bound Module exposes, by exact identity.
    const moduleQueries = new Map(
      boundModules.flatMap((module) =>
        array(object(object(module.canonical).content).queries).map(
          (query) => [String(query.queryId), query] as const,
        ),
      ),
    );
    const pipelines = new Map(
      array(content.pipelines).map((pipeline) => [String(pipeline.pipelineId), pipeline]),
    );
    const connectionMap = new Map(
      connections
        .filter((connection) => {
          const canonical = object(connection.canonical);
          const expected = request?.resolution.definitions.find(
            (definition) =>
              definition.kind === "connection_type" &&
              definition.rootId === canonical.connectionTypeId,
          );
          return (
            expected?.key === connection.artifact.definitionKey &&
            expected.exactVersion === connection.artifact.exactVersion &&
            connection.artifact.rootId === canonical.connectionTypeId &&
            connection.artifact.resolutionFingerprint === connection.resolutionFingerprint &&
            connection.artifact.contentFingerprint === fingerprintCanonicalValue(canonical)
          );
        })
        .map((connection) => [
          String(object(connection.canonical).connectionTypeId),
          object(connection.canonical),
        ]),
    );
    if (
      boundRoots.size !== bindings.length ||
      bindings.some((binding) => {
        const available = request?.resolution.definitions.find(
          (definition) =>
            definition.kind === "module" && definition.rootId === binding.moduleRootId,
        );
        const dependency = modules.find(
          (module) =>
            module.artifact.kind === "module" &&
            module.artifact.rootId === binding.moduleRootId &&
            module.artifact.definitionKey === available?.key &&
            module.artifact.exactVersion === binding.resolvedVersion &&
            module.artifact.resolutionFingerprint === module.resolutionFingerprint &&
            module.artifact.contentFingerprint ===
              fingerprintCanonicalValue(object(module.canonical).content),
        );
        return (
          !available ||
          available.exactVersion !== binding.resolvedVersion ||
          !versionRequirementAccepts(
            binding.version as VersionRequirement,
            String(binding.resolvedVersion),
          ) ||
          !dependency
        );
      })
    )
      failures.push(
        failure(output, "vortex.definition.application_module_bindings", "broken_reference"),
      );
    const applicationFieldReferencesValid = (
      value: unknown,
      fields: ReadonlySet<string>,
    ): boolean => {
      let valid = true;
      walkValues(value, (entry) => {
        for (const [key, candidate] of Object.entries(entry))
          if ((key === "fieldId" || key.endsWith("FieldId")) && !fields.has(String(candidate)))
            valid = false;
      });
      return valid;
    };
    for (const action of array(content.actions)) {
      const subject = records.get(String(action.subjectRecordTypeId));
      const subjectModuleV2 = recordValuePairs.get(String(action.subjectRecordTypeId)) ?? false;
      const fieldMap = new Map(
        subject ? array(subject.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      const fields = new Set(fieldMap.keys());
      const relationships = new Set(
        subject
          ? array(subject.relationships).map((relationship) => String(relationship.relationshipId))
          : [],
      );
      const inputMap = new Map(array(action.inputs).map((input) => [String(input.key), input]));
      const inputs = new Set(inputMap.keys());
      const inputTypes = new Map(
        [...inputMap].map(([key, input]) => [key, semanticFieldType(input.type) ?? ""]),
      );
      // A record action changes a record under a record-scoped permission, so a platform
      // administration permission cannot gate it: the runtime record-access decision refuses
      // platform authority for a record target. The reference is refused here rather than
      // compiled into a release that cannot enforce it.
      const usesPlatformPermission = actionPermissionKeys(action).some(isPlatformPermissionKey);
      if (usesPlatformPermission)
        failures.push(
          failure(output, "vortex.definition.application_action_references", "unsupported_choice"),
        );
      let valid =
        subject !== undefined &&
        actionPermissionKeys(action).length > 0 &&
        permissionEntries.length === permissionMap.size &&
        (usesPlatformPermission ||
          actionPermissionsMatch(action, permissionMap, permissionOwnersByKey)) &&
        applicationFieldReferencesValid(action.precondition, fields) &&
        (action.precondition === undefined ||
          applicationConditionTypesValid(
            action.precondition,
            fieldMap,
            subjectModuleV2,
            inputTypes,
          ));
      for (const task of array(action.tasks)) {
        const properties = object(task.properties);
        if (String(task.type) === "record.set_fields") {
          for (const [id, value] of Object.entries(object(properties.values)))
            if (
              !fields.has(id) ||
              !applicationActionValueCompatible(
                value,
                fieldValuePairs.get(id),
                fieldMap,
                subjectModuleV2,
                inputMap,
                String(action.subjectRecordTypeId),
              )
            )
              valid = false;
        }
        if (String(task.type) === "record.changes") {
          for (const change of array(properties.changes))
            if (
              (change.relationshipIds as string[]).some((id) => !relationships.has(id)) ||
              inputMap.get(String(change.targetInputKey))?.type !== "record_reference" ||
              !array(inputMap.get(String(change.targetInputKey))?.recordTypes)
                .map((reference) => String(reference.recordTypeId))
                .includes(String(action.subjectRecordTypeId))
            )
              valid = false;
        }
        if (String(task.type) === "event.announce" && !events.has(String(properties.eventKey)))
          valid = false;
        if (String(task.type) === "record.create") {
          const target = records.get(String(object(properties.recordType).recordTypeId));
          const targetFields = new Map(
            target ? array(target.fields).map((field) => [String(field.fieldId), field]) : [],
          );
          if (
            !target ||
            Object.entries(object(properties.values)).some(
              ([id, value]) =>
                !targetFields.has(id) ||
                !applicationActionValueCompatible(
                  value,
                  fieldValuePairs.get(id),
                  fieldMap,
                  subjectModuleV2,
                  inputMap,
                  String(action.subjectRecordTypeId),
                ),
            )
          )
            valid = false;
        }
        walkValues(task, (entry) => {
          const reference = actionValueReferenceEntry(entry);
          if (
            reference?.source === "input" &&
            !inputs.has(String(reference.name)) &&
            String(reference.name) !== "record"
          )
            valid = false;
          if (
            reference?.source === "trigger_record" &&
            actionFieldByKey(fieldMap, String(reference.field)) === undefined
          )
            valid = false;
        });
      }
      if (!valid)
        failures.push(
          failure(output, "vortex.definition.application_action_references", "broken_reference"),
        );
      if (!actionDeleteEffectsSupported(action))
        failures.push(
          failure(output, "vortex.definition.application_action_references", "unsupported_choice"),
        );
    }
    for (const event of array(content.events)) {
      const record = records.get(String(event.recordTypeId));
      const fields = new Map(
        record ? array(record.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      if (
        !record ||
        (event.carriedFieldIds as string[]).some(
          (id) => !fields.has(id) || fields.get(id)?.personalData !== "none",
        )
      )
        failures.push(
          failure(output, "vortex.definition.application_event_references", "broken_reference"),
        );
    }
    const applicationPlacementEntries = [
      ...[...shells.values()].flatMap((shell) => collectPlacementEntriesV2(shell.layout)),
      ...[...pages.values()].flatMap(pageContentPlacementEntriesV2),
    ];
    const applicationPlacementIds = new Set(
      applicationPlacementEntries.map(([placementId]) => placementId),
    );
    const identityCollections: readonly (readonly [JsonObject[], string, string])[] = [
      [array(content.pages), "pageId", "key"],
      [array(content.roles), "roleId", "key"],
      [array(content.queries), "queryId", "key"],
      [array(content.pipelines), "pipelineId", "key"],
      [array(content.permissions), "permissionId", "key"],
      [array(content.actions), "actionId", "key"],
      [array(content.events), "eventId", "key"],
      [array(content.connectionBindings), "bindingId", "key"],
      [array(content.interfaces), "interfaceId", "key"],
      [array(content.publicAddresses), "addressId", "path"],
      [array(content.flows), "id", "key"],
    ] as const;
    for (const [collection, idProperty, keyProperty] of identityCollections) {
      const ids = collection.map((entry) => String(entry[idProperty]));
      const keys = collection.map((entry) => String(entry[keyProperty]));
      if (new Set(ids).size !== ids.length || new Set(keys).size !== keys.length)
        failures.push(
          failure(output, "vortex.definition.application_identity_unique", "duplicate_key"),
        );
    }
    const flowBindingKeys = array(content.flowBindings).map(
      (binding) => `${binding.controlId}\0${binding.eventId}`,
    );
    if (new Set(flowBindingKeys).size !== flowBindingKeys.length)
      failures.push(
        failure(output, "vortex.definition.application_identity_unique", "duplicate_key"),
      );
    const flowBindingIds = array(content.flowBindings).map((binding) => String(binding.bindingId));
    if (new Set(flowBindingIds).size !== flowBindingIds.length)
      failures.push(
        failure(output, "vortex.definition.application_identity_unique", "duplicate_key"),
      );
    const navigationIds: string[] = [];
    const collectNavigationIds = (items: JsonObject[]) => {
      for (const item of items) {
        navigationIds.push(String(item.id));
        if (item.type === "heading") collectNavigationIds(array(item.children));
      }
    };
    collectNavigationIds(array(content.navigation));
    const placementIds = [...applicationPlacementIds];
    const guidedStepIds = [...pages.values()].flatMap((page) =>
      page.type === "guided_form" ? array(page.steps).map((step) => String(step.id)) : [],
    );
    if (
      new Set(navigationIds).size !== navigationIds.length ||
      new Set(placementIds).size !== placementIds.length ||
      new Set(guidedStepIds).size !== guidedStepIds.length
    )
      failures.push(
        failure(output, "vortex.definition.application_identity_unique", "duplicate_key"),
      );
    if (!pages.has(String(content.homePageId)))
      failures.push(failure(output, "vortex.definition.application_home_page", "broken_reference"));
    for (const role of array(content.roles)) {
      const rolePermissionKeys = role.permissionKeys as string[];
      const permissionSelection = object(role.permissionSelection);
      const expectedWildcardPermissions = [...applicationPermissions.values()]
        .filter((permission) => permission.administrative === false)
        .sort((left, right) => compareCanonicalStrings(String(left.key), String(right.key)));
      const expectedWildcardKeys = expectedWildcardPermissions.map((permission) =>
        String(permission.key),
      );
      const wildcardSelectionValid =
        permissionSelection.kind !== "application_wildcard" ||
        (rolePermissionKeys.length > 0 &&
          rolePermissionKeys.length === expectedWildcardKeys.length &&
          rolePermissionKeys.every((key, index) => key === expectedWildcardKeys[index]) &&
          permissionSelection.catalogueFingerprint ===
            fingerprintCanonicalValue(expectedWildcardPermissions));
      if (
        !pages.has(String(role.homePageId)) ||
        rolePermissionKeys.some((key) => !permissions.has(key)) ||
        !wildcardSelectionValid
      )
        failures.push(
          failure(output, "vortex.definition.application_role_references", "broken_reference"),
        );
    }
    walkValues(content.navigation, (item) => {
      if (
        item.type === "page" &&
        (!pages.has(String(item.pageId)) || !pageNavigationPermissionKnown(item.permissionKey))
      )
        failures.push(
          failure(
            output,
            "vortex.definition.application_navigation_references",
            "broken_reference",
          ),
        );
    });
    for (const query of queries.values()) {
      const record = object(query.recordType);
      const recordType = records.get(String(record.recordTypeId));
      const moduleV2 = recordValuePairs.get(String(record.recordTypeId)) ?? false;
      const fieldMap = new Map(
        recordType ? array(recordType.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      const fields = new Set(fieldMap.keys());
      const used = [
        ...(query.selectedFieldIds as string[]),
        ...(query.groupByFieldIds as string[]),
        ...array(query.sort).map((sort) => String(sort.fieldId)),
        ...array(query.aggregates).flatMap((aggregate) =>
          aggregate.fieldId ? [String(aggregate.fieldId)] : [],
        ),
      ];
      let filterFieldsValid = true;
      walkValues(query.filter, (entry) => {
        if (entry.source === "field" && !fields.has(String(entry.fieldId)))
          filterFieldsValid = false;
      });
      const aggregatesValid = array(query.aggregates).every((aggregate) => {
        if (aggregate.operation === "count") return aggregate.fieldId === undefined;
        if (!aggregate.fieldId) return false;
        const field = allFields.get(String(aggregate.fieldId));
        if (!field) return false;
        if (aggregate.operation === "sum" || aggregate.operation === "average")
          return ["number", "whole_number", "decimal_number", "money"].includes(
            applicationFieldType(fieldValuePairs.get(String(aggregate.fieldId))) ?? "",
          );
        return !["formatted_text", "table", "attachment", "link_to_one_of_several"].includes(
          String(field.type),
        );
      });
      if (
        !recordType ||
        used.some((fieldId) => !fields.has(fieldId)) ||
        !filterFieldsValid ||
        (query.filter !== undefined &&
          !applicationConditionTypesValid(query.filter, fieldMap, moduleV2)) ||
        !aggregatesValid
      )
        failures.push(
          failure(output, "vortex.definition.application_query_references", "broken_reference"),
        );
    }
    for (const page of pages.values()) {
      const pageRecordId = page.recordType
        ? String(object(page.recordType).recordTypeId)
        : undefined;
      const pageQuery = page.queryId ? moduleQueries.get(String(page.queryId)) : undefined;
      const pageQueryRecordId = pageQuery
        ? String(object(pageQuery.recordType).recordTypeId)
        : undefined;
      if (!pageNavigationPermissionKnown(page.accessPermissionKey))
        failures.push(
          failure(output, "vortex.definition.application_page_permission", "broken_reference"),
        );
      if (
        page.queryId &&
        (!pageQuery || (pageRecordId !== undefined && pageQueryRecordId !== pageRecordId))
      )
        failures.push(
          failure(output, "vortex.definition.application_page_query", "broken_reference"),
        );
      const pageRecord = page.recordType ? records.get(pageRecordId!) : undefined;
      if (page.recordType && !pageRecord)
        failures.push(
          failure(output, "vortex.definition.application_page_references", "broken_reference"),
        );
      const placements = [
        ...pageContentPlacementEntriesV2(page).map(([, placement]) => placement),
        ...pageShellPlacementEntriesV2(page).map(([, placement]) => placement),
      ];
      // A placement reads one data source: a declared protected read model or a query, never both.
      if (
        placements.some(
          (placement) =>
            placement.readModel !== undefined &&
            (placement.queryId !== undefined ||
              !(protectedReadModelKeys as readonly string[]).includes(
                String(object(placement.readModel).key),
              )),
        )
      )
        failures.push(
          failure(output, "vortex.definition.application_block_references", "broken_reference"),
        );
      if (page.type === "public") {
        const record = page.recordType
          ? records.get(String(object(page.recordType).recordTypeId))
          : undefined;
        const publicFields = new Set(
          record
            ? array(record.fields)
                .filter((field) => field.publicDisplay === "allowed")
                .map((field) => String(field.fieldId))
            : [],
        );
        const pagePublicFields = new Set(page.publicFieldIds as string[]);
        let publicBlockReferencesSafe = true;
        for (const placement of placements) {
          if (
            (placement.viewPermissionKey !== undefined &&
              !publicPermissionSafe(placement.viewPermissionKey)) ||
            (placement.usePermissionKey && !publicPermissionSafe(placement.usePermissionKey))
          )
            publicBlockReferencesSafe = false;
          walkValues(placement.visibilityCondition, (entry) => {
            if (entry.source === "field" && !pagePublicFields.has(String(entry.fieldId)))
              publicBlockReferencesSafe = false;
          });
          const inspectPublicSetting = (setting: JsonObject) => {
            if (
              setting.kind === "field_reference" &&
              !pagePublicFields.has(String(setting.fieldId))
            )
              publicBlockReferencesSafe = false;
            if (setting.kind === "relationship_reference" || setting.kind === "record_reference")
              publicBlockReferencesSafe = false;
            if (
              setting.kind === "action_reference" &&
              (setting.actionKey !== page.publicActionKey ||
                !publicActionSafe(setting.actionKey, pageRecordId, pagePublicFields))
            )
              publicBlockReferencesSafe = false;
            if (
              setting.kind === "page_reference" &&
              pages.get(String(setting.pageId))?.type !== "public"
            )
              publicBlockReferencesSafe = false;
            if (setting.kind === "pipeline_reference") publicBlockReferencesSafe = false;
            if (setting.kind === "query_reference") {
              const query = moduleQueries.get(String(setting.queryId));
              if (!publicQuerySafe(query, pageRecordId, pagePublicFields))
                publicBlockReferencesSafe = false;
            }
          };
          walkValues(placement.settings, inspectPublicSetting);
          if (placement.readModel !== undefined) publicBlockReferencesSafe = false;
          if (placement.queryId) {
            const query = moduleQueries.get(String(placement.queryId));
            if (!publicQuerySafe(query, pageRecordId, pagePublicFields))
              publicBlockReferencesSafe = false;
          }
        }
        if (
          (page.publicFieldIds as string[]).some((id) => !publicFields.has(id)) ||
          !publicPermissionSafe(page.accessPermissionKey) ||
          (page.queryId &&
            !publicQuerySafe(moduleQueries.get(String(page.queryId)), pageRecordId, pagePublicFields)) ||
          (page.publicActionKey &&
            !publicActionSafe(page.publicActionKey, pageRecordId, pagePublicFields)) ||
          !publicBlockReferencesSafe
        )
          failures.push(
            failure(output, "vortex.definition.application_public_surface", "unsafe_content"),
          );
      }
    }
    for (const pipeline of array(content.pipelines)) {
      const record = records.get(String(object(pipeline.recordType).recordTypeId));
      const moduleV2 =
        recordValuePairs.get(String(object(pipeline.recordType).recordTypeId)) ?? false;
      const stageField =
        record && array(record.fields).find((field) => field.fieldId === pipeline.stageFieldId);
      if (!stageField || stageField.type !== "choice")
        failures.push(
          failure(output, "vortex.definition.application_pipeline_stage", "broken_reference"),
        );
      const stageOptions = new Set(
        stageField?.type === "choice"
          ? array(object(stageField.settings).options).map((option) => String(option.value))
          : [],
      );
      if (array(pipeline.stages).some((stage) => !stageOptions.has(String(stage.key))))
        failures.push(
          failure(output, "vortex.definition.application_pipeline_stage", "broken_reference"),
        );
      for (const stage of array(pipeline.stages)) {
        if (
          [...(stage.entryActionKeys as string[]), ...(stage.exitActionKeys as string[])].some(
            (key) => !executableActionKeys.has(key),
          ) ||
          // Application content no longer carries node-and-edge workflows (#1086), so a stage
          // workflow cannot resolve until stage hooks start durable flows.
          (stage.entryWorkflowIds as string[]).length > 0 ||
          (stage.exitWorkflowIds as string[]).length > 0
        )
          failures.push(
            failure(
              output,
              "vortex.definition.application_pipeline_references",
              "broken_reference",
            ),
          );
      }
      const pipelineFields = new Map(
        record ? array(record.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      for (const transition of array(pipeline.transitions))
        if (
          (transition.permissionKey && !permissions.has(String(transition.permissionKey))) ||
          (transition.actionKey && !executableActionKeys.has(String(transition.actionKey))) ||
          (transition.gate !== undefined &&
            !applicationConditionTypesValid(transition.gate, pipelineFields, moduleV2))
        )
          failures.push(
            failure(
              output,
              "vortex.definition.application_pipeline_references",
              "broken_reference",
            ),
          );
      for (const target of array(pipeline.timeTargets))
        if (
          !events.has(String(target.escalationEventKey)) ||
          !record ||
          array(record.fields).find((field) => field.fieldId === target.dateTimeFieldId)?.type !==
            "date_time"
        )
          failures.push(
            failure(
              output,
              "vortex.definition.application_pipeline_references",
              "broken_reference",
            ),
          );
    }
    for (const binding of connectionBindingEntries) {
      const connection = connectionMap.get(String(binding.connectionTypeId));
      const available = request?.resolution.definitions.find(
        (definition) =>
          definition.kind === "connection_type" && definition.rootId === binding.connectionTypeId,
      );
      const resolvedOperations = new Set(
        available?.kind === "connection_type" ? available.operationKeys : [],
      );
      const canonicalOperations = new Set(
        connection ? array(connection.operations).map((operation) => String(operation.key)) : [],
      );
      const operationSetsMatch =
        resolvedOperations.size === canonicalOperations.size &&
        [...resolvedOperations].every((key) => canonicalOperations.has(key));
      if (
        !available ||
        !connection ||
        available.exactVersion !== binding.resolvedVersion ||
        !versionRequirementAccepts(
          binding.version as VersionRequirement,
          String(binding.resolvedVersion),
        ) ||
        !operationSetsMatch ||
        (binding.requiredOperationKeys as string[]).some(
          (key) => !resolvedOperations.has(key) || !canonicalOperations.has(key),
        )
      )
        failures.push(
          failure(
            output,
            "vortex.definition.application_connection_operations",
            "broken_reference",
          ),
        );
    }
    const publicPaths = array(content.publicAddresses).map((address) => String(address.path));
    if (new Set(publicPaths).size !== publicPaths.length)
      failures.push(failure(output, "vortex.definition.application_public_paths", "duplicate_key"));
    for (const address of array(content.publicAddresses))
      if (pages.get(String(address.pageId))?.type !== "public")
        failures.push(
          failure(output, "vortex.definition.application_public_paths", "broken_reference"),
        );
    const allInterfacePaths = array(content.interfaces).flatMap((definition) =>
      array(definition.operations).map((operation) => String(operation.path)),
    );
    const allInterfaceOperationKeys = array(content.interfaces).flatMap((definition) =>
      array(definition.operations).map((operation) => String(operation.key)),
    );
    // An interface read names a bound Module's query by its key; a key two bound Modules share
    // is ambiguous and resolves to no query.
    const queriesByKey = new Map<string, JsonObject | undefined>();
    for (const query of moduleQueries.values())
      queriesByKey.set(
        String(query.key),
        queriesByKey.has(String(query.key)) ? undefined : query,
      );
    const interfaceActionInputType = (type: unknown, moduleV2 = false): string | undefined => {
      const value = String(type);
      if (moduleV2 && ["decimal_number", "money"].includes(value)) return undefined;
      if (moduleV2 && value === "formatted_text") return "formatted_text";
      if (["text", "formatted_text", "choice"].includes(value)) return "text";
      if (["number", "whole_number", "decimal_number", "money"].includes(value)) return "number";
      if (value === "yes_no") return "boolean";
      if (value === "date" || value === "date_time") return value;
      if (["record_reference", "organization_account_reference"].includes(value))
        return "record_reference";
      return undefined;
    };
    if (
      new Set(allInterfacePaths).size !== allInterfacePaths.length ||
      new Set(allInterfaceOperationKeys).size !== allInterfaceOperationKeys.length
    )
      failures.push(
        failure(output, "vortex.definition.application_interface_unique", "duplicate_key"),
      );
    for (const definition of array(content.interfaces)) {
      const operationIds = array(definition.operations).map((operation) =>
        String(operation.operationId),
      );
      const operationKeys = array(definition.operations).map((operation) => String(operation.key));
      const operationPaths = array(definition.operations).map((operation) =>
        String(operation.path),
      );
      if (
        new Set(operationIds).size !== operationIds.length ||
        new Set(operationKeys).size !== operationKeys.length ||
        new Set(operationPaths).size !== operationPaths.length
      )
        failures.push(
          failure(output, "vortex.definition.application_interface_unique", "duplicate_key"),
        );
      for (const operation of array(definition.operations)) {
        const target = object(operation.target);
        // A change or background start names one application-owned interactive flow entry point.
        // The flow commits exactly one piece of work besides pure and read steps, which decides
        // the shape: a Call protected operation task naming a named action is a named-action
        // entry point, and a Run background flow task is an interface-started flow. A read names
        // a declared query.
        const targetQuery =
          target.kind === "query" ? queriesByKey.get(String(target.key)) : undefined;
        const targetFlow =
          target.kind === "flow" ? flowsForCommits.get(String(target.flowId)) : undefined;
        const targetFlowTasks: FlowTask[] = [];
        const collectTargetFlowTasks = (tasks: readonly FlowTask[]): void => {
          for (const task of tasks) {
            targetFlowTasks.push(task);
            for (const child of flowTaskChildLists(task)) collectTargetFlowTasks(child.tasks);
          }
        };
        if (targetFlow !== undefined) {
          collectTargetFlowTasks(targetFlow.tasks);
          collectTargetFlowTasks(targetFlow.errors);
          collectTargetFlowTasks(targetFlow.finally);
        }
        // Running another flow, or any task that is not a pure or read step (an unregistered one
        // included), is work the operation commits.
        const committingTasks = targetFlowTasks.filter(
          (task) =>
            task.type === "run_flow" ||
            !Object.hasOwn(flowTaskRegistry, task.type) ||
            !["pure", "read"].includes(
              flowTaskRegistry[task.type as keyof typeof flowTaskRegistry].effect,
            ),
        );
        const committingTask = committingTasks.length === 1 ? committingTasks[0] : undefined;
        const committingLiteral = (name: string): string | undefined => {
          const properties = (
            committingTask as { properties?: Record<string, JsonObject> } | undefined
          )?.properties;
          const value = properties?.[name];
          return value?.kind === "literal" && typeof object(value.literal).value === "string"
            ? String(object(value.literal).value)
            : undefined;
        };
        const calledOperationKey =
          committingTask?.type === "operation.call" ? committingLiteral("operation") : undefined;
        const targetAction =
          calledOperationKey === undefined ? undefined : actions.get(calledOperationKey);
        const targetActionPair =
          calledOperationKey === undefined
            ? undefined
            : moduleActionValuePairs.get(calledOperationKey);
        const startedFlowId =
          committingTask?.type === "flow.run_background" ? committingLiteral("flow") : undefined;
        const targetKind: "action" | "query" | "start" | undefined =
          target.kind === "query"
            ? "query"
            : targetFlow === undefined
              ? undefined
              : targetAction !== undefined
                ? "action"
                : startedFlowId !== undefined && flowsForCommits.has(startedFlowId)
                  ? "start"
                  : undefined;
        const targetExists =
          target.kind === "query"
            ? targetQuery !== undefined
            : targetFlow !== undefined && targetFlow.execution === "interactive";
        if (
          !targetExists ||
          (operation.permissionKey && !permissions.has(String(operation.permissionKey)))
        )
          failures.push(
            failure(
              output,
              "vortex.definition.application_interface_references",
              "broken_reference",
            ),
          );
        if (
          (operation.visibility === "public" && operation.authentication !== "public") ||
          (operation.visibility === "partner" && operation.authentication !== "partner_token") ||
          (operation.visibility === "organization_private" &&
            operation.authentication !== "organization_token")
        )
          failures.push(
            failure(output, "vortex.definition.application_interface_exposure", "unsafe_content"),
          );
        if (
          (target.kind === "query" && operation.method !== "GET") ||
          (target.kind !== "query" && operation.method === "GET")
        )
          failures.push(
            failure(output, "vortex.definition.application_interface_method", "scope_conflict"),
          );

        const inputShape = object(operation.inputShape);
        const outputShape = object(operation.outputShape);
        let shapeMatchesTarget = targetExists && targetKind !== undefined;
        if (targetKind === "action") {
          const subjectBindings = Object.values(inputShape).filter(
            (descriptor) => object(object(descriptor).targetBinding).kind === "action_subject",
          );
          const actionInputBindings = Object.values(inputShape).filter(
            (descriptor) => object(object(descriptor).targetBinding).kind === "action_input",
          );
          const declaredInputs = targetAction ? array(targetAction.inputs) : [];
          const bindingsByInputKey = new Map<string, JsonObject[]>();
          for (const descriptor of actionInputBindings) {
            const key = String(object(object(descriptor).targetBinding).key);
            bindingsByInputKey.set(key, [
              ...(bindingsByInputKey.get(key) ?? []),
              object(descriptor),
            ]);
          }
          shapeMatchesTarget =
            targetAction !== undefined &&
            Object.keys(outputShape).length === 0 &&
            subjectBindings.length === 1 &&
            object(subjectBindings[0]).type === "record_reference" &&
            object(subjectBindings[0]).required === true &&
            [...bindingsByInputKey.values()].every(
              (bindingsForInput) => bindingsForInput.length === 1,
            ) &&
            [...bindingsByInputKey.keys()].every((key) =>
              declaredInputs.some((input) => input.key === key),
            ) &&
            declaredInputs.every((input) => {
              const bindingsForInput = bindingsByInputKey.get(String(input.key));
              if (!bindingsForInput) return input.required !== true;
              const descriptor = bindingsForInput[0];
              return (
                descriptor?.required === input.required &&
                descriptor?.type ===
                  interfaceActionInputType(input.type, targetActionPair?.moduleV2 ?? false)
              );
            });
          // The interface supplies the flow's inputs, which the flow passes to the named action by
          // name, so every bound input is a flow input of the same type and every required flow
          // input is bound.
          if (targetFlow !== undefined) {
            const flowInputs = Object.entries(targetFlow.inputs);
            shapeMatchesTarget =
              shapeMatchesTarget &&
              [...bindingsByInputKey].every(([key, bindingsForInput]) => {
                const declaration = targetFlow.inputs[key];
                return (
                  declaration !== undefined &&
                  object(bindingsForInput[0]).type ===
                    interfaceActionInputType(declaration.type, targetActionPair?.moduleV2 ?? false)
                );
              }) &&
              flowInputs.every(
                ([key, declaration]) => !declaration.required || bindingsByInputKey.has(key),
              );
          }
        }
        if (targetKind === "query") {
          const selectedFields = new Set(
            targetQuery ? (targetQuery.selectedFieldIds as string[]) : [],
          );
          const outputBindings = Object.values(outputShape);
          const queryFieldIds = outputBindings
            .filter((descriptor) => object(object(descriptor).targetBinding).kind === "query_field")
            .map((descriptor) => String(object(object(descriptor).targetBinding).fieldId));
          const pageInformation = outputBindings
            .filter(
              (descriptor) =>
                object(object(descriptor).targetBinding).kind === "query_page_information",
            )
            .map((descriptor) => String(object(object(descriptor).targetBinding).value));
          shapeMatchesTarget =
            targetQuery !== undefined &&
            Object.keys(inputShape).length === 0 &&
            queryFieldIds.length > 0 &&
            new Set(queryFieldIds).size === queryFieldIds.length &&
            new Set(pageInformation).size === pageInformation.length &&
            queryFieldIds.every((fieldId) => {
              const descriptor = outputBindings.find(
                (candidate) =>
                  object(object(candidate).targetBinding).kind === "query_field" &&
                  object(object(candidate).targetBinding).fieldId === fieldId,
              );
              return (
                selectedFields.has(fieldId) &&
                descriptor !== undefined &&
                object(descriptor).type ===
                  applicationInterfaceFieldType(fieldValuePairs.get(fieldId))
              );
            });
        }
        if (targetKind === "start") {
          const outputs = Object.values(outputShape);
          shapeMatchesTarget =
            startedFlowId !== undefined &&
            Object.keys(targetFlow?.inputs ?? {}).length === 0 &&
            Object.keys(inputShape).length === 0 &&
            outputs.length === 1 &&
            object(object(outputs[0]).targetBinding).kind === "workflow_run_id" &&
            object(outputs[0]).type === "text" &&
            object(outputs[0]).required === true;
        }
        if (!shapeMatchesTarget)
          failures.push(
            failure(output, "vortex.definition.application_interface_shape", "scope_conflict"),
          );
        // The flow's own invocation permission is checked before any start, so an interface
        // operation must require exactly that permission and can never start the flow without it.
        if (
          targetFlow?.invocationPermissionId !== undefined &&
          String(permissionMap.get(String(operation.permissionKey))?.permissionId) !==
            String(targetFlow.invocationPermissionId)
        )
          failures.push(
            failure(output, "vortex.definition.application_interface_exposure", "unsafe_content"),
          );

        if (operation.visibility === "public") {
          if (
            !publicPermissionSafe(operation.permissionKey) ||
            (targetKind === "action" &&
              calledOperationKey !== undefined &&
              !publicActionSafe(calledOperationKey))
          )
            failures.push(
              failure(output, "vortex.definition.application_interface_exposure", "unsafe_content"),
            );
          if (
            targetKind === "query" &&
            (!publicQuerySafe(targetQuery) ||
              Object.values(outputShape).some((descriptor) => {
                const binding = object(object(descriptor).targetBinding);
                return (
                  binding.kind === "query_field" &&
                  allFields.get(String(binding.fieldId))?.publicDisplay !== "allowed"
                );
              }))
          )
            failures.push(
              failure(output, "vortex.definition.application_interface_exposure", "unsafe_content"),
            );
        }
      }
    }

    // The flow compiler judged every flow with the one flow validator (`flow-validation.ts`) before
    // it produced this content, so only what binds to them is judged here.
    const flows = array(content.flows) as unknown as FlowDefinition[];
    const flowsById = new Map(flows.map((flow) => [String(flow.id), flow]));
    const eventIds = new Set(array(content.events).map((event) => String(event.eventId)));
    for (const binding of array(content.flowBindings)) {
      const bindingFailure = (ruleCode: string, family: DefinitionRuleFailure["family"]) =>
        failure(output, ruleCode, family, {
          kind: "flow_binding",
          key: String(binding.bindingId),
        });
      const flowReference = object(binding.flow);
      const flow = flowsById.get(String(flowReference.flowId));
      // A binding starts an interactive flow of this release, from a control and event it declares.
      if (
        flow === undefined ||
        flow.execution !== "interactive" ||
        !applicationPlacementIds.has(String(binding.controlId)) ||
        !eventIds.has(String(binding.eventId))
      )
        failures.push(
          bindingFailure("vortex.definition.application_flow_binding_target", "broken_reference"),
        );
      if (flow === undefined) continue;
      const inputs = object(flowReference.inputs ?? {});
      if (Object.keys(inputs).some((name) => !Object.hasOwn(flow.inputs, name)))
        failures.push(
          bindingFailure("vortex.definition.application_flow_binding_inputs", "unknown_property"),
        );
      if (
        Object.entries(flow.inputs).some(
          ([name, declaration]) => declaration.required && !Object.hasOwn(inputs, name),
        )
      )
        failures.push(
          bindingFailure("vortex.definition.application_flow_binding_inputs", "required_value"),
        );
    }

    // A form declares no commit of its own: it commits what its bound `form_submit` flows commit.
    // A form or guided-form page whose flows commit nothing, or a commit that resolves to no
    // executable action, is refused rather than published as a page that cannot save; a commit of
    // an action outside the page's record type is refused as out of the form's scope.
    const formCommits = deriveFormCommitActionKeys(
      {
        pages: array(content.pages),
        shells: array(content.shells),
        flows: array(content.flows),
        flowBindings: array(content.flowBindings),
      },
      { standardActionKeysByRecordAction, executableActionKeys },
    );
    for (const page of pages.values()) {
      if (page.type !== "form" && page.type !== "guided_form") continue;
      const recordTypeId = page.recordType
        ? String(object(page.recordType).recordTypeId)
        : undefined;
      const committed = formCommits.get(String(page.pageId)) ?? [];
      if (
        recordTypeId === undefined ||
        committed.length === 0 ||
        committed.some((key) => !executableActionKeys.has(key))
      )
        failures.push(
          failure(output, "vortex.definition.application_page_references", "broken_reference"),
        );
      else if (committed.some((key) => commitActionRecordType(key) !== recordTypeId))
        failures.push(
          failure(output, "vortex.definition.application_page_references", "scope_conflict"),
        );
    }
  }
  return failures;
}

const moduleRuleCodes = [
  "vortex.definition.module_dependency_acyclic",
  "vortex.definition.module_dependency_resolved",
  "vortex.definition.module_record_references",
  "vortex.definition.module_relationship_references",
  "vortex.definition.module_field_references",
  "vortex.definition.module_calculation_acyclic",
  "vortex.definition.module_action_references",
  "vortex.definition.module_event_references",
  "vortex.definition.module_extension_capabilities",
  "vortex.definition.module_extension_references",
  "vortex.definition.module_sharing_condition",
  "vortex.definition.module_query_references",
] as const;
const applicationRuleCodes = [
  "vortex.definition.application_identity_unique",
  "vortex.definition.application_dependency_manifest",
  "vortex.definition.application_module_bindings",
  "vortex.definition.application_action_references",
  "vortex.definition.application_event_references",
  "vortex.definition.application_home_page",
  "vortex.definition.application_role_references",
  "vortex.definition.application_navigation_references",
  "vortex.definition.application_query_references",
  "vortex.definition.application_page_permission",
  "vortex.definition.application_page_query",
  "vortex.definition.application_page_references",
  "vortex.definition.application_layout_complete",
  "vortex.definition.application_block_references",
  "vortex.definition.application_block_settings",
  "vortex.definition.application_public_surface",
  "vortex.definition.application_pipeline_stage",
  "vortex.definition.application_pipeline_references",
  "vortex.definition.application_connection_operations",
  "vortex.definition.application_public_paths",
  "vortex.definition.application_interface_references",
  "vortex.definition.application_interface_shape",
  "vortex.definition.application_interface_exposure",
  "vortex.definition.application_interface_unique",
  "vortex.definition.application_interface_method",
  "vortex.definition.workflow_single_start",
  "vortex.definition.workflow_edges_unique",
  "vortex.definition.workflow_edge_endpoints",
  "vortex.definition.workflow_reachable",
  "vortex.definition.workflow_stop_terminal",
  "vortex.definition.workflow_outcomes_complete",
  "vortex.definition.workflow_output_exists",
  "vortex.definition.workflow_output_dominates",
  "vortex.definition.workflow_termination",
  "vortex.definition.workflow_cycles_bounded",
  "vortex.definition.workflow_trigger_values",
  "vortex.definition.workflow_trigger_reference",
  "vortex.definition.workflow_permission",
  "vortex.definition.workflow_node_references",
  "vortex.definition.workflow_node_values",
  "vortex.definition.workflow_action_inputs",
  "vortex.definition.workflow_connection_inputs",
  "vortex.definition.workflow_child_acyclic",
  "vortex.definition.workflow_child_depth",
  "vortex.definition.workflow_child_reference",
  "vortex.definition.application_flow_binding_target",
  "vortex.definition.application_flow_binding_inputs",
] as const;

const connectionRuleCodes = [
  "vortex.definition.connection_shapes_unique",
  "vortex.definition.connection_shape_fields_unique",
  "vortex.definition.connection_operations_unique",
  "vortex.definition.connection_messages_unique",
  "vortex.definition.connection_operation_shapes",
  "vortex.definition.connection_message_shape",
  "vortex.definition.connection_lifecycle_operations",
] as const;

function connectionRule(context: DefinitionSetValidationContext): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const output of context.outputs.filter(
    (candidate) => candidate.kind === "connection_type",
  )) {
    const connection = object(output.canonical);
    const shapes = array(connection.shapes);
    const operations = array(connection.operations);
    const messages = array(connection.incomingMessages);
    const shapeKeys = shapes.map((shape) => String(shape.key));
    const operationKeys = operations.map((operation) => String(operation.key));
    if (new Set(shapeKeys).size !== shapeKeys.length)
      failures.push(failure(output, "vortex.definition.connection_shapes_unique", "duplicate_key"));
    if (
      shapes.some((shape) => {
        const keys = array(shape.fields).map((field) => String(field.key));
        return new Set(keys).size !== keys.length;
      })
    )
      failures.push(
        failure(output, "vortex.definition.connection_shape_fields_unique", "duplicate_key"),
      );
    if (new Set(operationKeys).size !== operationKeys.length)
      failures.push(
        failure(output, "vortex.definition.connection_operations_unique", "duplicate_key"),
      );
    const messageKeys = messages.map((message) => String(message.key));
    if (new Set(messageKeys).size !== messageKeys.length)
      failures.push(
        failure(output, "vortex.definition.connection_messages_unique", "duplicate_key"),
      );
    const knownShapes = new Set(shapeKeys);
    if (
      operations.some(
        (operation) =>
          !knownShapes.has(String(operation.inputShapeKey)) ||
          !knownShapes.has(String(operation.outputShapeKey)),
      )
    )
      failures.push(
        failure(output, "vortex.definition.connection_operation_shapes", "broken_reference"),
      );
    if (messages.some((message) => !knownShapes.has(String(message.inputShapeKey))))
      failures.push(
        failure(output, "vortex.definition.connection_message_shape", "broken_reference"),
      );
    const knownOperations = new Set(operationKeys);
    if (
      [connection.healthOperationKey, connection.revocationOperationKey].some(
        (key) => key !== undefined && !knownOperations.has(String(key)),
      )
    )
      failures.push(
        failure(output, "vortex.definition.connection_lifecycle_operations", "broken_reference"),
      );
  }
  return failures;
}

function versionRequirementAccepts(requirement: VersionRequirement, version: string): boolean {
  return requirement.selection === "exact"
    ? requirement.version === version
    : satisfies(version, requirement.expression, { includePrerelease: false });
}

function publicationCompatibilityRule(
  context: DefinitionSetValidationContext,
): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const output of context.outputs.filter(
    (candidate) => candidate.kind === "module" || candidate.kind === "application",
  )) {
    const key = outputKey(output);
    const history = context.publishedHistories?.find(
      (candidate) => candidate.definitionKey === key && candidate.kind === output.kind,
    );
    const historyEvidence = context.publishedHistoryEvidence?.find(
      (candidate) => candidate.definitionKey === key && candidate.kind === output.kind,
    );
    if (!history && !historyEvidence) {
      failures.push(
        failure(output, "vortex.definition.prior_published_version_required", "required_value"),
      );
      continue;
    }
    try {
      const result = historyEvidence
        ? compareDefinitionVersionImpactWithEvidence({
            kind: output.kind as "module" | "application",
            ...("validationContractVersion" in output
              ? { validationContractVersion: output.validationContractVersion }
              : {}),
            historyEvidence,
            candidate: output.canonical,
          })
        : output.kind === "module" && history?.kind === "module"
          ? compareDefinitionVersionImpact({
              kind: "module",
              ...("validationContractVersion" in output
                ? { validationContractVersion: output.validationContractVersion }
                : {}),
              history: history.history,
              candidate: output.canonical,
            })
          : output.kind === "application" && history?.kind === "application"
            ? compareDefinitionVersionImpact({
                kind: "application",
                ...("validationContractVersion" in output
                  ? { validationContractVersion: "2.0.0" as const }
                  : {}),
                history: history.history,
                candidate: output.canonical,
              })
            : undefined;
      if (!result) {
        failures.push(
          failure(output, "vortex.definition.prior_published_version_invalid", "invalid_value"),
        );
        continue;
      }
      if (result.outcome === "no_change") {
        failures.push(
          failure(output, "vortex.definition.publication_change_required", "invalid_value"),
        );
        continue;
      }
      const candidateVersion = result.assignedVersion;
      if (output.artifact.exactVersion !== candidateVersion) {
        failures.push(
          failure(output, "vortex.definition.candidate_version_binding", "incompatible_version"),
        );
        continue;
      }
    } catch {
      failures.push(
        failure(output, "vortex.definition.prior_published_version_invalid", "invalid_value"),
      );
    }
  }
  return failures;
}

function publicationContextRule(context: DefinitionSetValidationContext): DefinitionRuleFailure[] {
  const publishesVersionedDefinition = context.outputs.some(
    (output) => output.kind === "module" || output.kind === "application",
  );
  if (
    context.requests.length > 0 &&
    context.outputs.length > 0 &&
    (!publishesVersionedDefinition ||
      context.publishedHistories !== undefined ||
      context.publishedHistoryEvidence !== undefined)
  )
    return [];
  const output = context.outputs[0];
  return [
    output
      ? failure(output, "vortex.definition.publication_context_required", "required_value")
      : {
          ruleCode: "vortex.definition.publication_context_required",
          family: "required_value",
        },
  ];
}

function semanticAggregateRule(
  ruleId: string,
  emittedCodes: readonly string[],
  stage: DefinitionValidationStage,
  definitionKinds: DefinitionSemanticRule["definitionKinds"],
  requiredContext: DefinitionSemanticRule["requiredContext"],
  safeLocationFamily: DefinitionSemanticRule["safeLocationFamily"],
  aggregateRunner: DefinitionSemanticRule["run"],
): DefinitionSemanticRule {
  return {
    ruleId,
    emittedCodes,
    stage,
    definitionKinds,
    requiredContext,
    safeLocationFamily,
    run: aggregateRunner,
  };
}

function moduleRuleGraphRule(context: DefinitionSetValidationContext): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const output of context.outputs) {
    if (
      output.kind !== "module" ||
      !("validationContractVersion" in output) ||
      output.validationContractVersion !== "3.0.0"
    )
      continue;
    const content = output.canonical.content;
    const allowedRoots = new Set([
      output.canonical.envelope.rootId,
      ...content.dependencies.map((dependency) => dependency.moduleRootId),
    ]);
    const availableRecordTypeIds = new Set(
      allValidationOutputs(context).flatMap((dependency) =>
        dependency.kind === "module" && allowedRoots.has(dependency.canonical.envelope.rootId)
          ? dependency.canonical.content.recordTypes.map((record) => String(record.recordTypeId))
          : [],
      ),
    );
    for (const graph of content.rules) {
      const subjectRecordType = content.recordTypes.find(
        (record) => record.recordTypeId === graph.subjectRecordTypeId,
      );
      if (!subjectRecordType) {
        failures.push(
          failure(output, ruleGraphValidationCodes.references, "broken_reference", {
            kind: "rule",
            key: graph.key,
          }),
        );
        continue;
      }
      for (const issue of validateRuleGraph({ graph, subjectRecordType, availableRecordTypeIds }))
        failures.push(
          failure(output, issue.ruleCode, issue.family, { kind: "rule", key: graph.key }),
        );
    }
  }
  return failures;
}

function applicationCatalogueRule(context: PreparedValidationContext): DefinitionRuleFailure[] {
  return editSaveSources(context).flatMap((source, index) => {
    const parsed = context.parsedSources?.[index] ?? parseEditSaveSource(source);
    return parsed.success && isV2ApplicationSource(parsed.data)
      ? validateApplicationSourceCatalogue(parsed.data as ApplicationSourceDocumentV2)
      : [];
  });
}

type PlacedApplicationBlock = Readonly<{ placement: JsonObject; pageType: string | undefined }>;

/**
 * Every block placed in an Application source by its application-unique alias: shell layouts,
 * page content and guided-form step content at any depth, with the type of the page that places
 * it (none for a shell).
 */
const placedApplicationBlocks = (body: JsonObject): ReadonlyMap<string, PlacedApplicationBlock> => {
  const placed = new Map<string, PlacedApplicationBlock>();
  const visitSlot = (slotValue: unknown, pageType?: string): void => {
    for (const [alias, placementValue] of Object.entries(object(object(slotValue).placements))) {
      const placement = object(placementValue);
      placed.set(alias, { placement, pageType });
      for (const child of Object.values(object(placement.slots))) visitSlot(child, pageType);
    }
  };
  for (const shell of array(body.shells)) visitSlot(shell.layout);
  for (const page of array(body.pages)) {
    const composition = object(page.composition);
    const pageType = String(page.type);
    if (composition.step_content !== undefined) {
      for (const stepValue of Object.values(object(composition.step_content))) {
        if (composition.shell_kind === "default") visitSlot(stepValue, pageType);
        else for (const slot of Object.values(object(stepValue))) visitSlot(slot, pageType);
      }
    } else if (composition.shell_kind === "default") {
      visitSlot(composition.main, pageType);
    } else {
      for (const slot of Object.values(object(composition.content))) visitSlot(slot, pageType);
    }
  }
  return placed;
};

/**
 * Refuses, at draft save and again before publication compiles, a flow binding whose event the
 * bound placement's registered release does not declare. An unknown placement or unregistered
 * release is refused by the reference and catalogue rules instead.
 */
function applicationFlowBindingEventRule(
  context: PreparedValidationContext,
): DefinitionRuleFailure[] {
  return editSaveSources(context).flatMap((raw, index): DefinitionRuleFailure[] => {
    const parsed = context.parsedSources?.[index] ?? parseEditSaveSource(raw);
    if (!parsed.success || !isV2ApplicationSource(parsed.data)) return [];
    const source = parsed.data as ApplicationSourceDocumentV2;
    const body = object(source.body);
    const placedBlocks = placedApplicationBlocks(body);
    const failures: DefinitionRuleFailure[] = [];
    for (const binding of array(body.flow_bindings)) {
      const placed = placedBlocks.get(String(binding.control));
      const block = placed ? object(placed.placement.block) : undefined;
      const release = block
        ? registeredBlockReleases.get(`${String(block.block_id)}:${String(block.release_version)}`)
        : undefined;
      if (release === undefined || release.supportedEvents.some((event) => event === binding.event))
        continue;
      const bindingKey = builderKeySchema.safeParse(binding.id);
      const bindingSegment = bindingKey.success
        ? [{ kind: "flow_binding" as const, key: bindingKey.data }]
        : [];
      failures.push({
        ruleCode: "vortex.definition.application_flow_binding_event",
        family: "unsupported_choice",
        location: {
          documentKind: "application",
          documentKey: source.key,
          segments: [{ kind: "application", key: source.key }, ...bindingSegment],
        },
      });
    }
    return failures;
  });
}

/** Block keys whose placements carry a control that submits or acts. */
const formContainerBlockKey = "platform.form.container";
const actionButtonBlockKey = "platform.action.button";

/**
 * One authored block setting of the given kind, read as the renderer reads it: a setting of any
 * other kind is not that setting, so a button's action kind falls back to its `action` default.
 */
const sourceBlockSetting = (placement: JsonObject, key: string, kind: string): unknown => {
  const setting: unknown = object(placement.settings)[key];
  return setting !== null && typeof setting === "object" && object(setting).kind === kind
    ? object(setting).value
    : undefined;
};

/** The registered key of a placement's exact block release, or undefined for an unknown release. */
const sourceBlockKey = (placement: JsonObject): string | undefined => {
  const block = object(placement.block);
  return registeredBlockReleases.get(
    `${String(block.block_id)}:${String(block.release_version)}`,
  )?.key;
};

/** A button's authored action kind, `action` when it declares none. */
const sourceButtonActionKind = (placement: JsonObject): unknown =>
  sourceBlockSetting(placement, "action_kind", "choice") ?? "action";

/** Whether a form container holds, at any depth, a button that submits the enclosing form. */
const containsSubmitButton = (placement: JsonObject): boolean =>
  Object.values(object(placement.slots)).some((slotValue) =>
    Object.values(object(object(slotValue).placements)).some((childValue) => {
      const child = object(childValue);
      return (
        (sourceBlockKey(child) === actionButtonBlockKey &&
          sourceButtonActionKind(child) === "submit") ||
        containsSubmitButton(child)
      );
    }),
  );

/**
 * Refuses, before an Application publishes, a control that would render enabled but run nothing.
 * A form container with a submit path needs a `form_submit` binding: it holds a Submit button at
 * any depth, or it sits on a form or guided-form page. An action button needs an `action` binding
 * unless its `disabled` setting is the literal `true`.
 *
 * Presentation-only is derived, never marked: a form container with no submit path only collects
 * the inputs an action button in it passes to that button's bound flow. Its one other submission,
 * Enter in a field, emits a `form_submit` with no binding, which runs nothing and commits nothing,
 * so it cannot carry an unbound commit. A submit or reset button outside a form container is
 * refused when it renders. A button without a choice-valued action kind is judged as an action
 * button, the renderer's default.
 */
function applicationControlBindingRule(
  context: PreparedValidationContext,
): DefinitionRuleFailure[] {
  return editSaveSources(context).flatMap((raw, index): DefinitionRuleFailure[] => {
    const parsed = context.parsedSources?.[index] ?? parseEditSaveSource(raw);
    if (!parsed.success || !isV2ApplicationSource(parsed.data)) return [];
    const source = parsed.data as ApplicationSourceDocumentV2;
    const body = object(source.body);
    const boundEvents = new Map<string, Set<string>>();
    for (const binding of array(body.flow_bindings)) {
      const control = String(binding.control);
      const events = boundEvents.get(control) ?? new Set<string>();
      events.add(String(binding.event));
      boundEvents.set(control, events);
    }
    const failures: DefinitionRuleFailure[] = [];
    for (const [alias, { placement, pageType }] of placedApplicationBlocks(body)) {
      const blockKey = sourceBlockKey(placement);
      const bound = boundEvents.get(alias) ?? new Set<string>();
      const unbound =
        blockKey === formContainerBlockKey
          ? (containsSubmitButton(placement) ||
              pageType === "form" ||
              pageType === "guided_form") &&
            !bound.has("form_submit")
          : blockKey === actionButtonBlockKey &&
            sourceButtonActionKind(placement) !== "submit" &&
            sourceButtonActionKind(placement) !== "reset" &&
            sourceBlockSetting(placement, "disabled", "boolean") !== true &&
            !bound.has("action");
      if (!unbound) continue;
      const placementKey = builderKeySchema.safeParse(alias);
      failures.push({
        ruleCode: "vortex.definition.application_control_binding",
        family: "required_value",
        location: {
          documentKind: "application",
          documentKey: source.key,
          segments: [
            { kind: "application", key: source.key },
            ...(placementKey.success ? [{ kind: "block" as const, key: placementKey.data }] : []),
          ],
        },
      });
    }
    return failures;
  });
}

export const definitionSemanticRules: readonly DefinitionSemanticRule[] = Object.freeze([
  {
    ruleId: "vortex.definition.source_shape",
    emittedCodes: ["vortex.definition.source_shape"],
    stage: "edit_save",
    definitionKinds: ["module", "application", "connection_type"],
    requiredContext: ["source"],
    safeLocationFamily: "document",
    run: sourceShapeRule,
  },
  {
    ruleId: "vortex.definition.local_identity_unique",
    emittedCodes: ["vortex.definition.local_identity_unique"],
    stage: "edit_save",
    definitionKinds: ["module", "application", "connection_type"],
    requiredContext: ["source"],
    safeLocationFamily: "document",
    run: localIdentityRule,
  },
  {
    ruleId: "vortex.definition.local_references",
    emittedCodes: ["vortex.definition.local_references"],
    stage: "edit_save",
    definitionKinds: ["module", "application", "connection_type"],
    requiredContext: ["source"],
    safeLocationFamily: "document",
    run: sourceLocalReferenceRule,
  },
  {
    ruleId: "vortex.definition.source_type_compatibility",
    emittedCodes: ["vortex.definition.source_type_compatibility"],
    stage: "edit_save",
    definitionKinds: ["module"],
    requiredContext: ["source"],
    safeLocationFamily: "document",
    run: sourceTypeCompatibilityRule,
  },
  {
    ruleId: "vortex.definition.application_catalogue",
    emittedCodes: applicationCatalogueRuleCodes,
    stage: "edit_save",
    definitionKinds: ["application"],
    requiredContext: ["source"],
    safeLocationFamily: "application",
    run: applicationCatalogueRule,
  },
  {
    ruleId: "vortex.definition.application_flow_binding_events",
    emittedCodes: ["vortex.definition.application_flow_binding_event"],
    stage: "edit_save",
    definitionKinds: ["application"],
    requiredContext: ["source"],
    safeLocationFamily: "flow_binding",
    run: applicationFlowBindingEventRule,
  },
  {
    ruleId: "vortex.definition.application_control_bindings",
    emittedCodes: ["vortex.definition.application_control_binding"],
    stage: "publish",
    definitionKinds: ["application"],
    requiredContext: ["source"],
    safeLocationFamily: "block",
    run: applicationControlBindingRule,
  },
  {
    ruleId: "vortex.definition.publication_context_required",
    emittedCodes: ["vortex.definition.publication_context_required"],
    stage: "publish",
    definitionKinds: ["module", "application", "connection_type"],
    requiredContext: ["compiled_set"],
    safeLocationFamily: "document",
    run: publicationContextRule,
  },
  semanticAggregateRule(
    "vortex.definition.artifact_binding",
    ["vortex.definition.artifact_binding"],
    "publish",
    ["module", "application", "connection_type"],
    ["compiled_set"],
    "document",
    artifactBindingRule,
  ),
  semanticAggregateRule(
    "vortex.definition.module_dependencies",
    ["vortex.definition.module_dependency_acyclic", "vortex.definition.module_dependency_resolved"],
    "publish",
    ["module"],
    ["compiled_set"],
    "module",
    dependencyRule,
  ),
  semanticAggregateRule(
    "vortex.definition.module_rule_graphs",
    Object.values(ruleGraphValidationCodes),
    "publish",
    ["module"],
    ["compiled_set"],
    "rule",
    moduleRuleGraphRule,
  ),
  semanticAggregateRule(
    "vortex.definition.module_references",
    moduleRuleCodes.filter((code) => !code.startsWith("vortex.definition.module_dependency_")),
    "publish",
    ["module"],
    ["compiled_set"],
    "module",
    moduleReferenceRule,
  ),
  {
    ruleId: "vortex.definition.provenance_complete",
    emittedCodes: ["vortex.definition.provenance_complete"],
    stage: "publish",
    definitionKinds: ["module", "application", "connection_type"],
    requiredContext: ["source", "resolution_snapshot", "compiled_set"],
    safeLocationFamily: "document",
    run: provenanceRule,
  },
  semanticAggregateRule(
    "vortex.definition.application_semantics",
    applicationRuleCodes,
    "publish",
    ["application"],
    ["source", "resolution_snapshot", "compiled_set"],
    "application",
    applicationRule,
  ),
  semanticAggregateRule(
    "vortex.definition.connection_semantics",
    connectionRuleCodes,
    "publish",
    ["connection_type"],
    ["compiled_set"],
    "connection",
    connectionRule,
  ),
  semanticAggregateRule(
    "vortex.definition.publication_compatibility",
    [
      "vortex.definition.prior_published_version_required",
      "vortex.definition.prior_published_version_invalid",
      "vortex.definition.publication_change_required",
      "vortex.definition.candidate_version_binding",
    ],
    "publish",
    ["module", "application"],
    ["compiled_set", "prior_published_version"],
    "document",
    publicationCompatibilityRule,
  ),
]);

const validationStageRank: Readonly<Record<DefinitionValidationStage, number>> = {
  edit_save: 0,
  publish: 1,
  install: 2,
  runtime: 3,
};

function hasRequiredContext(
  context: DefinitionSetValidationContext,
  required: DefinitionSemanticRule["requiredContext"],
): boolean {
  return required.every((item) => {
    if (item === "source") return context.rawSources !== undefined || context.requests.length > 0;
    if (item === "resolution_snapshot") return context.requests.length > 0;
    if (item === "compiled_set") return context.outputs.length > 0;
    if (item === "prior_published_version")
      return (
        context.publishedHistories !== undefined || context.publishedHistoryEvidence !== undefined
      );
    return false;
  });
}

export function validateDefinitionSet(
  context: DefinitionSetValidationContext,
  stage: DefinitionValidationStage = "publish",
) {
  const eligibleRules = definitionSemanticRules
    .filter((rule) => validationStageRank[rule.stage] <= validationStageRank[stage])
    .filter((rule) => hasRequiredContext(context, rule.requiredContext));
  // Each source is parsed once here instead of once per edit-save rule. The canonical walker is
  // built on first use, so a call whose rules never walk the compiled set still builds none.
  let canonicalWalker: ReturnType<typeof createContractValueWalker> | undefined;
  const preparedContext: PreparedValidationContext = {
    ...context,
    parsedSources: editSaveSources(context).map((source) => parseEditSaveSource(source)),
    walkCanonicalValues: (value, visit) =>
      (canonicalWalker ??= canonicalValueWalker(context))(value, visit),
  };
  const failures: DefinitionRuleFailure[] = [];
  for (const rule of eligibleRules) failures.push(...rule.run(preparedContext));
  const sorted = settleDefinitionRuleFailures(failures);
  return { valid: sorted.length === 0, failures: sorted } as const;
}

export function validateDefinitionSource(source: unknown) {
  return validateDefinitionSet({ requests: [], outputs: [], rawSources: [source] }, "edit_save");
}

function valueMatchesType(value: unknown, type: string): boolean {
  if (type === "text") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "organization_account_reference") return platformIdSchema.safeParse(value).success;
  if (type === "date") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function evaluateSavedSharingCondition(
  input: unknown,
  fieldValues: Readonly<Record<string, unknown>>,
  parameters: Readonly<Record<string, unknown>>,
  sourceRecordFields: readonly ModuleFieldV3[],
): boolean {
  const candidate = object(input);
  let result: boolean;
  try {
    result = evaluateTypedConditionV2({
      condition: candidate.condition as ConditionNode,
      sourceRecordFields,
      declaredFieldIds: candidate.declaredFieldIds as string[],
      parameterDeclarations: candidate.parameters as TypedConditionParameterDeclarationV2[],
      fieldValues,
      parameterValues: parameters,
    });
  } catch (error) {
    if (!(error instanceof TypedConditionEvaluationError)) throw error;
    const mapping = {
      input_refused: "vortex.definition.sharing_condition_input_refused",
      field_refused: "vortex.definition.sharing_condition_field_refused",
      parameter_refused: "vortex.definition.sharing_condition_parameter_refused",
      operator_refused: "vortex.definition.sharing_condition_operator_refused",
    } as const;
    throw new DefinitionCompilationError(
      mapping[error.reason],
      error.reason === "operator_refused" ? "unsupported_choice" : "scope_conflict",
    );
  }
  if (!savedSharingConditionV3Schema.safeParse(input).success)
    throw new DefinitionCompilationError(
      "vortex.definition.sharing_condition_input_refused",
      "scope_conflict",
    );
  return result;
}

function dependencyKeys(request: PublicationCompilationRequest): string[] {
  const source = request.source as unknown as JsonObject;
  const body = object(source.body);
  if (source.kind === "module")
    return array(body.dependencies).map((entry) => String(entry.module));
  if (source.kind === "application")
    return [
      ...array(body.module_bindings).map((entry) => String(entry.module)),
      ...array(body.connection_bindings).map((entry) => String(entry.connection_type)),
    ];
  return [];
}

export function compileDefinitionSet(
  inputs: readonly PublicationCompilationRequest[],
  options?: DefinitionPublicationContext,
): Output[] {
  if (!Array.isArray(inputs))
    throw new DefinitionCompilationError(
      "vortex.definition.invalid_compilation_request",
      "invalid_value",
    );
  if (options === undefined)
    throw new DefinitionCompilationError(
      "vortex.definition.publication_context_required",
      "required_value",
    );
  const parsedContext = definitionPublicationContextSchema.safeParse(options);
  if (!parsedContext.success)
    throw new DefinitionCompilationError(
      "vortex.definition.invalid_publication_context",
      "invalid_value",
    );
  const publicationContext = parsedContext.data;
  const parsedInputs = inputs.map((input) => {
    const source = object(input).source;
    if (isModuleSource(source)) return moduleCompilationRequestV3Schema.safeParse(input);
    if (isV2ApplicationSource(source))
      return applicationCompilationRequestV2Schema.safeParse(input);
    return definitionCompilationRequestSchema.safeParse(input);
  });
  if (parsedInputs.some((result) => !result.success))
    throw new DefinitionCompilationError(
      "vortex.definition.invalid_compilation_request",
      "invalid_value",
    );
  const requests = parsedInputs.flatMap((result) => (result.success ? [result.data] : []));
  const byKey = new Map(requests.map((input) => [input.source.key, input]));
  if (byKey.size !== requests.length)
    throw new DefinitionCompilationError("vortex.definition.duplicate_source_key", "duplicate_key");
  const ordered: PublicationCompilationRequest[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key))
      throw new DefinitionCompilationError(
        "vortex.definition.dependency_cycle",
        "dependency_cycle",
      );
    if (visited.has(key)) return;
    const input = byKey.get(key);
    if (!input) return;
    visiting.add(key);
    dependencyKeys(input).sort(compareCanonicalStrings).forEach(visit);
    visiting.delete(key);
    visited.add(key);
    ordered.push(input);
  };
  [...byKey.keys()].sort(compareCanonicalStrings).forEach(visit);
  const dependencyOutputs = publicationContext.dependencyOutputs ?? [];
  const inputKeys = new Set(ordered.map((request) => request.source.key));
  if (dependencyOutputs.some((output) => inputKeys.has(output.artifact.definitionKey)))
    throw new DefinitionCompilationError("vortex.definition.duplicate_source_key", "duplicate_key");
  const outputs: Output[] = [];
  // Each request was parsed above and the dependency outputs came out of the publication context
  // schema, so the compiler is not asked to parse either a second time.
  const compilePublicationRequest = compileParsedDefinition as (
    request: PublicationCompilationRequest,
    dependencyOutputs: readonly Output[],
  ) => Output;
  for (const request of ordered)
    outputs.push(compilePublicationRequest(request, [...dependencyOutputs, ...outputs]));
  const validation = validateDefinitionSet({
    requests: ordered,
    outputs,
    ...(dependencyOutputs.length === 0 ? {} : { dependencyOutputs }),
    publishedHistories: publicationContext.publishedHistories,
  });
  if (!validation.valid) {
    const first = validation.failures[0]!;
    throw new DefinitionCompilationError(first.ruleCode, first.family, first.location);
  }
  return outputs;
}
