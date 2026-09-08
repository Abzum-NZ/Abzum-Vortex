import {
  applicationDraftSchema,
  applicationDraftV2Schema,
  applicationSourceDocumentV2Schema,
  applicationCompilationRequestV2Schema,
  moduleDraftSchema,
  moduleDraftV2Schema,
  moduleSourceDocumentV2Schema,
  moduleCompilationRequestV2Schema,
  savedSharingConditionV2Schema,
  savedSharingConditionSchema,
  connectionTypeSchema,
  exactDecimalTextV2Schema,
  moneyValueV2Schema,
  sourceExactDecimalTextV2Schema,
  sourceMoneyValueV2Schema,
  moduleFieldValueV2Schemas,
  sourceModuleFieldValueV2Schemas,
  parseExactDecimal,
  workflowDefinitionSchema,
  jsonValueSchema,
  walkDefinitionContract,
  definitionSourceDocumentSchema,
  definitionCompilationRequestSchema,
  definitionPublicationContextSchema,
  builderKeySchema,
  platformIdSchema,
  blockSettingReferenceKindByControl,
  namespacedKeySchema,
  translateDefinitionSchemaError,
  workflowNodeOutputKeysByType,
  workflowNodeOutputsByType,
  type DefinitionCompilationOutput,
  type DefinitionCompilationRequest,
  type ApplicationCompilationRequestV2,
  type ModuleCompilationRequestV2,
  type ModuleSourceDocumentV2,
  type ModuleFieldV2,
  type ApplicationSourceDocumentV2,
  type ConditionNode,
  type DefinitionSourceDocument,
  type DefinitionPublicationContext,
  type DefinitionRuleFailure,
  type DefinitionValidationLocation,
  type FieldDefinition,
  type PublishedDefinitionHistory,
  type VersionRequirement,
} from "@vortex/contracts";
import type { z } from "zod";
import {
  evaluateTypedCondition,
  evaluateTypedConditionV2,
  TypedConditionEvaluationError,
  type TypedConditionParameterDeclaration,
  type TypedConditionParameterDeclarationV2,
} from "@vortex/rule";
import { satisfies } from "semver";
import { compileDefinitionWithContext } from "./compiler";
import { DefinitionCompilationError } from "./compilation-error";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "./canonical-json";
import { compareDefinitionVersionImpact } from "./version-impact";
import { createContractValueWalker } from "./contract-value-walker";

type JsonObject = Record<string, unknown>;
type Output = DefinitionCompilationOutput;
type PublicationCompilationRequest =
  DefinitionCompilationRequest | ApplicationCompilationRequestV2 | ModuleCompilationRequestV2;
type DefinitionPath = readonly (string | number)[];
type EditSaveSource =
  DefinitionSourceDocument | ApplicationSourceDocumentV2 | ModuleSourceDocumentV2;

const isV2ApplicationSource = (source: unknown): boolean =>
  source !== null &&
  typeof source === "object" &&
  !Array.isArray(source) &&
  (source as JsonObject).kind === "application" &&
  (source as JsonObject).source_contract_version === "2.0.0";

const isV2ModuleSource = (source: unknown): boolean =>
  source !== null &&
  typeof source === "object" &&
  !Array.isArray(source) &&
  (source as JsonObject).kind === "module" &&
  (source as JsonObject).source_contract_version === "2.0.0";

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
    : isV2ModuleSource(source)
      ? moduleSourceDocumentV2Schema
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
}>;

const allValidationOutputs = (context: DefinitionSetValidationContext): readonly Output[] => [
  ...(context.dependencyOutputs ?? []),
  ...context.outputs,
];

const canonicalValueWalker = (context: DefinitionSetValidationContext) =>
  createContractValueWalker(
    allValidationOutputs(context).map((output) => ({
      schema:
        output.kind === "module"
          ? "validationContractVersion" in output
            ? moduleDraftV2Schema
            : moduleDraftSchema
          : output.kind === "application"
            ? "validationContractVersion" in output
              ? applicationDraftV2Schema
              : applicationDraftSchema
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
  definition_validation_failed: "invalid_value",
} as const satisfies Record<string, DefinitionRuleFailure["family"]>;

const sourceCollectionLocationKind = {
  record_types: "record_type",
  fields: "field",
  relationships: "relationship",
  actions: "action",
  rules: "rule",
  events: "event",
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
} as const satisfies Partial<
  Record<string, DefinitionValidationLocation["segments"][number]["kind"]>
>;

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
  const visit = (
    value: unknown,
    path: (string | number)[],
    segments: DefinitionValidationLocation["segments"],
    collectionName?: string,
  ) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index], segments, collectionName));
      return;
    }
    if (value === null || typeof value !== "object") return;
    const entry = value as JsonObject;
    const locationKind = collectionName
      ? sourceCollectionLocationKind[collectionName as keyof typeof sourceCollectionLocationKind]
      : undefined;
    const candidateKey = entry.key ?? entry.id;
    const parsedCandidate = namespacedKeySchema.or(builderKeySchema).safeParse(candidateKey);
    const nextSegments =
      locationKind && parsedCandidate.success
        ? [...segments, { kind: locationKind, key: parsedCandidate.data }]
        : segments;
    if (nextSegments !== segments)
      pathMap.push({
        sourcePath: path,
        location: { ...rootLocation, segments: nextSegments },
      });
    for (const [key, child] of Object.entries(entry))
      visit(child, [...path, key], nextSegments, key);
  };
  visit(document, [], rootLocation.segments);
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

function localIdentityRule(context: DefinitionSetValidationContext): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  const values = context.rawSources ?? context.requests.map((request) => request.source);
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
    const parsed = parseEditSaveSource(source);
    if (!parsed.success) continue;
    walkDefinitionContract(parsed.schema, parsed.data, (schema, value) => {
      if (schema === jsonValueSchema) return;
      if (Array.isArray(value)) {
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

function sourceShapeRule(context: DefinitionSetValidationContext): DefinitionRuleFailure[] {
  return (context.rawSources ?? context.requests.map((request) => request.source)).flatMap(
    (source): DefinitionRuleFailure[] => {
      const parsed = parseEditSaveSource(source);
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
            (issue) =>
              issue.code === "invalid_type" && "input" in issue && issue.input === undefined,
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
    },
  );
}

function sourceLocalReferenceRule(
  context: DefinitionSetValidationContext,
): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const raw of context.rawSources ?? context.requests.map((request) => request.source)) {
    const parsed = parseEditSaveSource(raw);
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
        for (const effect of array(action.effects)) {
          if (effect.kind === "set_field" && !fields.has(String(effect.field))) valid = false;
          if (
            effect.kind === "copy_relationships" &&
            (((effect.relationships as string[]) ?? []).some((key) => !relationships.has(key)) ||
              inputs.get(String(effect.target_input)) !== "record_reference")
          )
            valid = false;
          if (effect.kind === "announce_event" && !events.has(String(effect.event))) valid = false;
          if (effect.kind === "create_record" && !qualifiedRecordValid(effect.record_type))
            valid = false;
          walkValues(effect, (entry) => {
            if (entry.source === "input" && !inputs.has(String(entry.input))) valid = false;
            if (entry.source === "subject_field" && !fields.has(String(entry.field))) valid = false;
          });
        }
      }
      for (const rule of array(body.rules)) {
        const record = records.get(String(rule.record_type));
        const fields = new Set(
          record ? array(record.fields).map((field) => String(field.key)) : [],
        );
        if (!record || !conditionValid(rule.condition, fields)) valid = false;
        const effect = object(rule.effect);
        if (
          ["set_value", "require"].includes(String(effect.kind)) &&
          !fields.has(String(effect.field))
        )
          valid = false;
      }
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
    } else if (source.kind === "application") {
      const usesV2Composition = source.source_contract_version === "2.0.0";
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
      const blocks = usesV2Composition
        ? new Set<string>()
        : new Set(array(body.block_registrations).map((block) => String(block.id)));
      const workflows = new Set(array(body.workflows).map((workflow) => String(workflow.key)));
      const connections = new Set(
        array(body.connection_bindings).map((binding) => String(binding.id)),
      );
      const pagePlacements = (page: JsonObject): JsonObject[] =>
        page.type === "guided_form"
          ? array(page.steps).flatMap((step) => array(step.blocks))
          : page.blocks
            ? array(page.blocks)
            : [];
      for (const page of array(body.pages)) {
        if (page.query && !queries.has(String(page.query))) valid = false;
        if (usesV2Composition) continue;
        const placements = pagePlacements(page);
        if (placements.some((placement) => !blocks.has(String(placement.block)))) valid = false;
        const placementIds = new Set(placements.map((placement) => String(placement.id)));
        const layout = object(page.layout);
        for (const order of [
          (object(layout.desktop).component_order as string[]) ?? [],
          (object(layout.phone).component_order as string[]) ?? [],
        ])
          if (
            order.length !== placementIds.size ||
            order.some((id) => !placementIds.has(id)) ||
            new Set(order).size !== order.length
          )
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
          if (target.kind === "query" && !queries.has(String(target.key))) valid = false;
          if (target.kind === "workflow" && !workflows.has(String(target.key))) valid = false;
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

function sourceConditionTypesValid(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  parameters: ReadonlyMap<string, string> = new Map(),
): boolean {
  const condition = object(value);
  if (condition.all)
    return array(condition.all).every((entry) =>
      sourceConditionTypesValid(entry, fields, parameters),
    );
  if (condition.any)
    return array(condition.any).every((entry) =>
      sourceConditionTypesValid(entry, fields, parameters),
    );
  if (condition.not) return sourceConditionTypesValid(condition.not, fields, parameters);
  const operandType = (operandValue: unknown): string | undefined => {
    const operand = object(operandValue);
    if (operand.source === "field") return fieldValueType(fields.get(String(operand.field)));
    if (operand.source === "parameter") return parameters.get(String(operand.parameter));
    return operand.source === "value" ? literalValueType(operand.value) : undefined;
  };
  const leftType = condition.left
    ? operandType(condition.left)
    : fieldValueType(fields.get(String(condition.field)));
  if (!leftType) return false;
  if (condition.operator === "is_empty" || condition.operator === "is_not_empty")
    return (
      condition.right === undefined &&
      condition.parameter === undefined &&
      condition.value === undefined
    );
  const rightType = condition.left
    ? operandType(condition.right)
    : condition.parameter !== undefined
      ? parameters.get(String(condition.parameter))
      : literalValueType(condition.value);
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

function sourceTypeCompatibilityRule(
  context: DefinitionSetValidationContext,
): DefinitionRuleFailure[] {
  const failures: DefinitionRuleFailure[] = [];
  for (const raw of context.rawSources ?? context.requests.map((request) => request.source)) {
    const parsed = parseEditSaveSource(raw);
    if (!parsed.success || parsed.data.kind !== "module") continue;
    const source = parsed.data;
    const moduleV2 = source.source_contract_version === "2.0.0";
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
            (moduleV2
              ? !["whole_number", "decimal_number", "money"].includes(
                  fieldValueTypeV2(aggregateField) ?? "",
                )
              : fieldValueType(aggregateField) !== "number")) ||
          (settings.filter !== undefined &&
            !(moduleV2
              ? conditionTypesValidV2(settings.filter, aggregateFields, new Map(), "source")
              : sourceConditionTypesValid(settings.filter, aggregateFields))) ||
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
        [...inputs].map(
          ([key, input]) =>
            [
              key,
              (moduleV2 ? semanticFieldTypeV2(input.type) : semanticFieldType(input.type)) ?? "",
            ] as const,
        ),
      );
      if (
        action.precondition &&
        !(moduleV2
          ? conditionTypesValidV2(action.precondition, subjectFields, inputTypes, "source")
          : sourceConditionTypesValid(action.precondition, subjectFields, inputTypes))
      )
        valid = false;
      const valueType = (candidate: unknown): string | undefined => {
        const value = object(candidate);
        if (value.source === "literal") return literalValueType(value.value);
        if (value.source === "input") {
          return semanticFieldType(inputs.get(String(value.input))?.type);
        }
        if (value.source === "subject_field")
          return fieldValueType(subjectFields.get(String(value.field)));
        if (value.source === "subject_record") return "record_reference";
        if (value.source === "current_actor") return "organization_account_reference";
        if (value.source === "current_time") return "date_time";
        return undefined;
      };
      const subjectRecordType = `${source.key}:${String(action.record_type)}`;
      const valueRecordTypes = (candidate: unknown): string[] | undefined => {
        const value = object(candidate);
        if (value.source === "input") {
          const input = inputs.get(String(value.input));
          return input?.type === "record_reference"
            ? array(input.record_types).map(String)
            : undefined;
        }
        if (value.source === "subject_field")
          return fieldRecordTypeIds(subjectFields.get(String(value.field)));
        if (value.source === "subject_record") return [subjectRecordType];
        return undefined;
      };
      const sourceValueCompatible = (candidate: unknown, targetField: JsonObject | undefined) => {
        if (moduleV2)
          return actionValueCompatibleV2(
            candidate,
            targetField,
            subjectFields,
            inputs,
            subjectRecordType,
            "source",
          );
        const compatible = valueTypeCompatible(valueType(candidate), fieldValueType(targetField));
        const expectedRecordTypes = fieldRecordTypeIds(targetField);
        if (!compatible || expectedRecordTypes === undefined) return compatible;
        const actualRecordTypes = valueRecordTypes(candidate);
        return (
          actualRecordTypes !== undefined &&
          actualRecordTypes.length > 0 &&
          actualRecordTypes.every((recordType) => expectedRecordTypes.includes(recordType))
        );
      };
      for (const effect of array(action.effects)) {
        if (
          effect.kind === "set_field" &&
          !sourceValueCompatible(effect.value, subjectFields.get(String(effect.field)))
        )
          valid = false;
        if (effect.kind === "create_record") {
          const qualified = String(effect.record_type);
          const split = qualified.lastIndexOf(":");
          if (split >= 0 && qualified.slice(0, split) === source.key) {
            const targetFields = fieldsFor(records.get(qualified.slice(split + 1)));
            if (
              Object.entries(object(effect.values)).some(
                ([fieldKey, candidate]) =>
                  !sourceValueCompatible(candidate, targetFields.get(fieldKey)),
              )
            )
              valid = false;
          }
        }
        if (effect.kind === "copy_relationships") {
          const targetInput = inputs.get(String(effect.target_input));
          if (
            targetInput?.type !== "record_reference" ||
            !array(targetInput.record_types).map(String).includes(subjectRecordType)
          )
            valid = false;
        }
      }
    }
    for (const rule of array(body.rules)) {
      const fields = fieldsFor(records.get(String(rule.record_type)));
      if (
        !(moduleV2
          ? conditionTypesValidV2(rule.condition, fields, new Map(), "source")
          : sourceConditionTypesValid(rule.condition, fields))
      )
        valid = false;
      const effect = object(rule.effect);
      if (
        effect.kind === "set_value" &&
        !(moduleV2
          ? fieldValueMatchesV2(effect.value, fields.get(String(effect.field)), "source")
          : valueTypeCompatible(
              literalValueType(effect.value),
              fieldValueType(fields.get(String(effect.field))),
            ))
      )
        valid = false;
    }
    for (const sharingCondition of array(body.sharing_conditions)) {
      const fields = fieldsFor(records.get(String(sharingCondition.source_record_type)));
      const parameters = new Map(
        array(sharingCondition.parameters).map(
          (parameter) => [String(parameter.key), String(parameter.type)] as const,
        ),
      );
      if (
        !(moduleV2
          ? conditionTypesValidV2(sharingCondition.condition, fields, parameters, "source")
          : sourceConditionTypesValid(sharingCondition.condition, fields, parameters))
      )
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
              : !(moduleV2
                  ? valueMatchesTypeV2(binding.value, expected, "source")
                  : valueMatchesType(binding.value, expected)))
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
    const expectedSourcePaths = request
      ? leafPaths(request.source).filter(
          (path) =>
            !(path.length === 1 && (path[0] === "source_contract_version" || path[0] === "kind")),
        )
      : [];
    const expectedCanonicalPaths = leafPaths(output.canonical);
    const sourceLeafKeys = new Set(leafPaths(request?.source).map(pathKey));
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
  if (expression.kind === "join_text")
    for (const fieldId of expression.fieldIds as string[]) add(fieldId);
  if (expression.kind === "numeric")
    for (const operand of array(expression.operands))
      if (operand.source === "field") add(operand.fieldId);
  if (expression.kind === "subtract_percentage") {
    add(expression.amountFieldId);
    add(expression.percentageFieldId);
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

const numericExpressionValidV2 = (
  expression: JsonObject,
  resultType: string,
  fields: ReadonlyMap<string, JsonObject>,
): boolean => {
  const operands = array(expression.operands);
  const dimensions = operands.map((operand) =>
    operand.source === "literal"
      ? exactDecimalTextV2Schema.safeParse(operand.value).success
        ? ("dimensionless" as const)
        : undefined
      : numericDimensionV2(fields.get(String(operand.fieldId))),
  );
  if (dimensions.some((dimension) => dimension === undefined)) return false;
  const moneyPositions = dimensions.flatMap((dimension, index) =>
    dimension === "money" ? [index] : [],
  );
  const operation = String(expression.operation);
  const dimensionValid =
    operation === "add" || operation === "subtract"
      ? moneyPositions.length === 0 || moneyPositions.length === dimensions.length
      : operation === "multiply"
        ? moneyPositions.length <= 1
        : operation === "divide"
          ? moneyPositions.length === 0 || (moneyPositions.length === 1 && moneyPositions[0] === 0)
          : false;
  if (!dimensionValid) return false;
  const resultIsMoney = moneyPositions.length > 0;
  return resultIsMoney
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

const typesCompatibleV2 = (actual: string | undefined, expected: string | undefined): boolean =>
  actual !== undefined &&
  expected !== undefined &&
  (actual === expected || (expected === "text" && (actual === "date" || actual === "date_time")));

const conditionTypesCompatibleV2 = (left: string | undefined, right: string | undefined): boolean =>
  left !== undefined &&
  right !== undefined &&
  (left === right ||
    (["number", "whole_number", "decimal_number"].includes(left) &&
      ["number", "whole_number", "decimal_number"].includes(right)));

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
      conditionTypesCompatibleV2(leftType, rightType) &&
      ["number", "whole_number", "decimal_number", "money", "date", "date_time", "text"].includes(
        leftType,
      )
    );
  return conditionTypesCompatibleV2(leftType, rightType);
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

function actionValueType(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  inputs: ReadonlyMap<string, JsonObject>,
): string | undefined {
  const entry = object(value);
  if (entry.source === "literal") return literalValueType(entry.value);
  if (entry.source === "input") {
    const type = inputs.get(String(entry.inputKey))?.type;
    return semanticFieldType(type);
  }
  if (entry.source === "subject_field") return fieldValueType(fields.get(String(entry.fieldId)));
  if (entry.source === "subject_record") return "record_reference";
  if (entry.source === "current_actor") return "organization_account_reference";
  if (entry.source === "current_time") return "date_time";
  return undefined;
}

function actionValueRecordTypeIds(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  inputs: ReadonlyMap<string, JsonObject>,
  subjectRecordTypeId: string,
): string[] | undefined {
  const entry = object(value);
  if (entry.source === "input") {
    const input = inputs.get(String(entry.inputKey ?? entry.input));
    if (input?.type !== "record_reference") return undefined;
    const references = array(input.recordTypes ?? input.record_types);
    return references.map((reference) =>
      typeof reference === "string" ? reference : String(reference.recordTypeId),
    );
  }
  if (entry.source === "subject_field")
    return fieldRecordTypeIds(fields.get(String(entry.fieldId ?? entry.field)));
  if (entry.source === "subject_record") return [subjectRecordTypeId];
  return undefined;
}

function actionValueTypeV2(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  inputs: ReadonlyMap<string, JsonObject>,
  dialect: ModuleV2ValueDialect,
): string | undefined {
  const entry = object(value);
  if (entry.source === "input") {
    const inputType = inputs.get(String(entry[dialect === "source" ? "input" : "inputKey"]))?.type;
    return inputType === "formatted_text" ? "formatted_text" : semanticFieldTypeV2(inputType);
  }
  if (entry.source === "subject_field") {
    const field = fields.get(String(entry[dialect === "source" ? "field" : "fieldId"]));
    return ["formatted_text", "table", "attachment"].includes(String(field?.type))
      ? String(field!.type)
      : fieldValueTypeV2(field);
  }
  if (entry.source === "subject_record") return "record_reference";
  if (entry.source === "current_actor") return "organization_account_reference";
  if (entry.source === "current_time") return "date_time";
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
    entry.source === "literal"
      ? fieldValueMatchesV2(entry.value, targetField, dialect)
      : typesCompatibleV2(actionValueTypeV2(value, fields, inputs, dialect), expectedType);
  const expectedRecordTypeIds = fieldRecordTypeIds(targetField);
  if (!compatible || expectedRecordTypeIds === undefined) return compatible;
  if (entry.source === "literal") return compatible;
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
  const compatible = valueTypeCompatible(
    actionValueType(value, fields, inputs),
    fieldValueType(targetField),
  );
  const expectedRecordTypeIds = fieldRecordTypeIds(targetField);
  if (!compatible || expectedRecordTypeIds === undefined) return compatible;
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
  const sourceType = applicationFieldType(source);
  const targetType = applicationFieldType(target);
  return (
    sourceType !== undefined &&
    sourceType === targetType &&
    ["text", "number", "boolean", "date", "date_time"].includes(sourceType)
  );
};

const applicationMappingTypesCompatible = (
  actual: string | undefined,
  expected: string | undefined,
): boolean => {
  if (!actual || !expected) return false;
  if (
    ["decimal_number", "money"].includes(actual) ||
    ["decimal_number", "money"].includes(expected)
  )
    return actual === expected;
  if (["number", "whole_number"].includes(actual) && ["number", "whole_number"].includes(expected))
    return true;
  return typesCompatibleV2(actual, expected);
};

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
  if (entry.source === "literal")
    return target.moduleV2
      ? fieldValueMatchesV2(entry.value, target.field, "canonical")
      : valueTypeCompatible(literalValueType(entry.value), fieldValueType(target.field));
  if (entry.source === "subject_field" && subjectModuleV2 !== target.moduleV2) {
    const sourceField = subjectFields.get(String(entry.fieldId));
    if (
      !sourceField ||
      !crossFormatFieldTypesCompatible({ field: sourceField, moduleV2: subjectModuleV2 }, target)
    )
      return false;
  }
  if (
    target.moduleV2 &&
    entry.source === "input" &&
    (inputs.get(String(entry.inputKey))?.type === "formatted_text" ||
      (inputs.get(String(entry.inputKey))?.type === "number" &&
        ["decimal_number", "money"].includes(applicationFieldType(target) ?? "")))
  )
    return false;
  if (
    target.moduleV2 &&
    !applicationMappingTypesCompatible(
      actionValueTypeV2(value, subjectFields, inputs, "canonical"),
      applicationFieldType(target),
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

const valueTypeCompatible = (actual: string | undefined, expected: string | undefined): boolean =>
  actual !== undefined &&
  expected !== undefined &&
  (actual === expected ||
    (expected === "text" && (actual === "date" || actual === "date_time")) ||
    (expected === "record_reference" && actual === "organization_account_reference") ||
    expected === "json");

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

function moduleReferenceRule(context: DefinitionSetValidationContext): DefinitionRuleFailure[] {
  const walkValues = canonicalValueWalker(context);
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
  for (const output of availableModuleOutputs) {
    const canonical = object(output.canonical);
    const content = object(canonical.content);
    const moduleRootId = String(object(canonical.envelope).rootId);
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
      if (["organization_account", "team"].includes(String(currentRecord.ownershipMode))) {
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

  for (const output of moduleOutputs) {
    const moduleV2 = "validationContractVersion" in output;
    const canonical = object(output.canonical);
    const envelope = object(canonical.envelope);
    const content = object(canonical.content);
    const moduleRootId = String(envelope.rootId);
    const allowedModuleRoots = new Set([
      moduleRootId,
      ...array(content.dependencies).map((dependency) => String(dependency.moduleRootId)),
    ]);
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
        moduleV2 ? new Set(sharingConditions.keys()) : new Set(),
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
      for (const field of array(record.fields)) {
        const settings = object(field.settings);
        const moduleFieldValueType = (candidate: JsonObject | undefined) =>
          moduleV2 ? fieldValueTypeV2(candidate) : fieldValueType(candidate);
        const moduleNumericField = (candidate: JsonObject | undefined) =>
          moduleV2
            ? ["whole_number", "decimal_number", "money"].includes(
                fieldValueTypeV2(candidate) ?? "",
              )
            : fieldValueType(candidate) === "number";
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
          const expectedDependencies = moduleV2
            ? calculationDependencyFieldIdsV2(expression)
            : undefined;
          valid =
            (settings.dependencyFieldIds as string[]).every((fieldId) => fields.has(fieldId)) &&
            fieldReferencesValid(settings.expression, fields) &&
            (!moduleV2 ||
              JSON.stringify([...new Set(settings.dependencyFieldIds as string[])]) ===
                JSON.stringify(expectedDependencies)) &&
            (!moduleV2 ||
              (["decimal_number", "money"].includes(String(settings.resultType))
                ? settings.decimalPlaces !== undefined
                : settings.decimalPlaces === undefined));
          if (expression.kind === "join_text")
            valid =
              valid &&
              (expression.fieldIds as string[]).every((id) =>
                ["text", "choice"].includes(moduleFieldValueType(fieldMap.get(id)) ?? ""),
              );
          if (expression.kind === "numeric")
            valid =
              valid &&
              (moduleV2
                ? numericExpressionValidV2(expression, String(settings.resultType), fieldMap)
                : array(expression.operands).every(
                    (operand) =>
                      operand.source === "literal" ||
                      (operand.source === "field" &&
                        moduleNumericField(fieldMap.get(String(operand.fieldId)))),
                  ));
          if (expression.kind === "subtract_percentage")
            if (moduleV2) {
              const amountDimension = numericDimensionV2(
                fieldMap.get(String(expression.amountFieldId)),
              );
              valid =
                valid &&
                amountDimension !== undefined &&
                ["whole_number", "decimal_number"].includes(
                  fieldValueTypeV2(fieldMap.get(String(expression.percentageFieldId))) ?? "",
                ) &&
                (amountDimension === "money"
                  ? settings.resultType === "money"
                  : settings.resultType === "decimal_number");
            } else
              valid =
                valid &&
                moduleNumericField(fieldMap.get(String(expression.amountFieldId))) &&
                fieldValueType(fieldMap.get(String(expression.percentageFieldId))) === "number";
          if (expression.kind === "condition")
            valid =
              valid &&
              (moduleV2
                ? conditionTypesValidV2(expression.condition, fieldMap)
                : conditionTypesValid(expression.condition, fieldMap));
          if (expression.kind === "date_offset") {
            const amount = object(expression.amount);
            valid =
              valid &&
              ["date", "date_time"].includes(
                moduleFieldValueType(fieldMap.get(String(expression.dateFieldId))) ?? "",
              ) &&
              (!moduleV2 ||
                moduleFieldValueType(fieldMap.get(String(expression.dateFieldId))) ===
                  settings.resultType) &&
              ((amount.source === "literal" &&
                (!moduleV2 || exactIntegerLiteralV2(amount.value))) ||
                (amount.source === "field" &&
                  (moduleV2
                    ? fieldValueTypeV2(fieldMap.get(String(amount.fieldId))) === "whole_number"
                    : moduleNumericField(fieldMap.get(String(amount.fieldId))))));
          }
          if (expression.kind === "deadline_passed") {
            const statusField =
              expression.statusFieldId === undefined
                ? undefined
                : fieldMap.get(String(expression.statusFieldId));
            valid =
              valid &&
              ["date", "date_time"].includes(
                moduleFieldValueType(fieldMap.get(String(expression.dueFieldId))) ?? "",
              ) &&
              (expression.statusFieldId === undefined ||
                ["text", "choice"].includes(moduleFieldValueType(statusField) ?? "")) &&
              (!moduleV2 ||
                expression.statusFieldId !== undefined ||
                array(expression.terminalStatusValues).length === 0) &&
              (!moduleV2 ||
                statusField === undefined ||
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
          const filterValid =
            settings.filter === undefined ||
            (fieldReferencesValid(settings.filter, aggregateFields) &&
              (moduleV2
                ? conditionTypesValidV2(settings.filter, aggregateFieldMap)
                : conditionTypesValid(settings.filter, aggregateFieldMap)));
          const currencyValid =
            settings.currency === undefined ||
            (settings.operation === "sum" && aggregateField?.type === "money");
          valid =
            aggregateRelationship !== undefined &&
            reachesCurrentRecord &&
            filterValid &&
            currencyValid &&
            (settings.operation === "count"
              ? settings.fieldId === undefined
              : aggregateField !== undefined) &&
            (!["sum", "average"].includes(String(settings.operation)) ||
              (moduleV2
                ? ["whole_number", "decimal_number", "money"].includes(
                    fieldValueTypeV2(aggregateField) ?? "",
                  )
                : fieldValueType(aggregateField) === "number"));
          const declaredResultType = String(settings.resultType);
          const aggregateResultType = fieldDeclaredResultType(aggregateField);
          const resultTypeValid =
            (settings.operation === "count" && declaredResultType === "whole_number") ||
            (settings.operation === "average" &&
              declaredResultType ===
                (aggregateResultType === "money" ? "money" : "decimal_number")) ||
            (["sum", "minimum", "maximum"].includes(String(settings.operation)) &&
              declaredResultType === aggregateResultType);
          const precisionValid = moduleV2
            ? settings.operation === "average"
              ? settings.decimalPlaces !== undefined
              : settings.decimalPlaces === undefined
            : true;
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
          (moduleV2 ? semanticFieldTypeV2(input.type) : semanticFieldType(input.type)) ?? "",
        ]),
      );
      let valid =
        subject !== undefined &&
        actionPermissionKeys(action).length > 0 &&
        actionPermissionsMatch(action, modulePermissionsByKey) &&
        fieldReferencesValid(action.precondition, fields) &&
        (action.precondition === undefined ||
          (moduleV2
            ? conditionTypesValidV2(action.precondition, fieldMap, inputTypes)
            : conditionTypesValid(action.precondition, fieldMap, inputTypes)));
      for (const input of array(action.inputs))
        if (
          input.type === "record_reference" &&
          (input.recordTypes as unknown[]).some(
            (reference) => !recordReference(reference, allowedModuleRoots),
          )
        )
          valid = false;
      for (const effect of array(action.effects)) {
        if (
          effect.kind === "set_field" &&
          (!fields.has(String(effect.fieldId)) ||
            !(moduleV2 ? actionValueCompatibleV2 : actionValueCompatible)(
              effect.value,
              fieldMap.get(String(effect.fieldId)),
              fieldMap,
              inputMap,
              String(action.subjectRecordTypeId),
            ))
        )
          valid = false;
        if (effect.kind === "copy_relationships") {
          if (
            (effect.relationshipIds as string[]).some((id) => !relationships.has(id)) ||
            inputMap.get(String(effect.targetInputKey))?.type !== "record_reference" ||
            !array(inputMap.get(String(effect.targetInputKey))?.recordTypes)
              .map((reference) => String(reference.recordTypeId))
              .includes(String(action.subjectRecordTypeId))
          )
            valid = false;
        }
        if (effect.kind === "announce_event" && !events.has(String(effect.eventKey))) valid = false;
        if (effect.kind === "create_record") {
          const target = recordReference(effect.recordType, allowedModuleRoots);
          const targetFields = new Map(
            target ? array(target.fields).map((field) => [String(field.fieldId), field]) : [],
          );
          if (
            !target ||
            Object.entries(object(effect.values)).some(
              ([id, value]) =>
                !targetFields.has(id) ||
                !(moduleV2 ? actionValueCompatibleV2 : actionValueCompatible)(
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
        walkValues(effect, (entry) => {
          if (entry.source === "input" && !inputKeys.has(String(entry.inputKey))) valid = false;
          if (entry.source === "subject_field" && !fields.has(String(entry.fieldId))) valid = false;
        });
      }
      if (!valid)
        failures.push(
          failure(output, "vortex.definition.module_action_references", "broken_reference"),
        );
    }

    for (const rule of array(content.rules)) {
      const subject = moduleRecords.get(String(rule.subjectRecordTypeId));
      const fieldMap = new Map(
        subject ? array(subject.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      const fields = new Set(fieldMap.keys());
      const effect = object(rule.effect);
      if (
        !subject ||
        !fieldReferencesValid(rule.condition, fields) ||
        !fieldReferencesValid(rule.effect, fields) ||
        !(moduleV2
          ? conditionTypesValidV2(rule.condition, fieldMap)
          : conditionTypesValid(rule.condition, fieldMap)) ||
        ["show_or_hide", "start_background_work"].includes(String(effect.kind)) ||
        (effect.kind === "set_value" &&
          !(moduleV2
            ? fieldValueMatchesV2(effect.value, fieldMap.get(String(effect.fieldId)), "canonical")
            : valueTypeCompatible(
                literalValueType(effect.value),
                fieldValueType(fieldMap.get(String(effect.fieldId))),
              )))
      )
        failures.push(
          failure(output, "vortex.definition.module_rule_references", "broken_reference"),
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
    for (const point of array(content.extensionPoints))
      if (!moduleRecords.has(String(point.recordTypeId)))
        failures.push(
          failure(output, "vortex.definition.module_extension_references", "broken_reference"),
        );
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
        (moduleV2
          ? conditionTypesValidV2(condition.condition, fieldMap, parameterTypes)
          : conditionTypesValid(condition.condition, fieldMap, parameterTypes));
      try {
        for (const publicationTest of array(condition.publicationTests))
          if (
            (moduleV2
              ? evaluateSavedSharingConditionV2(
                  condition,
                  object(publicationTest.fieldValues),
                  object(publicationTest.parameters),
                  [...fieldMap.values()] as ModuleFieldV2[],
                )
              : evaluateSavedSharingCondition(
                  condition,
                  object(publicationTest.fieldValues),
                  object(publicationTest.parameters),
                  [...fieldMap.values()] as FieldDefinition[],
                )) !== publicationTest.expected
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
  }
  return failures;
}

const outputsByNodeType: Readonly<Record<string, readonly string[]>> = workflowNodeOutputKeysByType;

function validateWorkflow(output: Output, workflow: JsonObject): DefinitionRuleFailure[] {
  const walkValues = createContractValueWalker([
    { schema: workflowDefinitionSchema, value: workflow },
  ]);
  const failures: DefinitionRuleFailure[] = [];
  const workflowFailure = (ruleCode: string, family: DefinitionRuleFailure["family"]) =>
    failure(output, ruleCode, family, { kind: "workflow", key: String(workflow.key) });
  const nodes = array(workflow.nodes);
  const edges = array(workflow.edges);
  const byId = new Map(nodes.map((node) => [String(node.nodeId), node]));
  const starts = nodes.filter((node) => node.type === "start");
  if (starts.length !== 1)
    failures.push(workflowFailure("vortex.definition.workflow_single_start", "invalid_value"));
  const edgeKeys = edges.map(
    (edge) => `${edge.fromNodeId}\0${edge.toNodeId}\0${edge.outcome ?? ""}`,
  );
  if (new Set(edgeKeys).size !== edgeKeys.length)
    failures.push(workflowFailure("vortex.definition.workflow_edges_unique", "duplicate_key"));
  for (const edge of edges)
    if (!byId.has(String(edge.fromNodeId)) || !byId.has(String(edge.toNodeId)))
      failures.push(
        workflowFailure("vortex.definition.workflow_edge_endpoints", "broken_reference"),
      );
  if (starts.length === 1) {
    const reachable = new Set<string>();
    const queue = [String(starts[0]!.nodeId)];
    while (queue.length) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      edges
        .filter((edge) => edge.fromNodeId === current)
        .forEach((edge) => queue.push(String(edge.toNodeId)));
    }
    if (reachable.size !== nodes.length)
      failures.push(workflowFailure("vortex.definition.workflow_reachable", "broken_reference"));
  }
  for (const node of nodes) {
    const outgoing = edges.filter((edge) => edge.fromNodeId === node.nodeId);
    if (node.type === "stop" && outgoing.length > 0)
      failures.push(workflowFailure("vortex.definition.workflow_stop_terminal", "scope_conflict"));
    let expected: string[] | undefined;
    if (node.type === "condition") expected = ["matched", "not_matched"];
    if (node.type === "decision_table")
      expected = array(object(node.config).decisions).map((decision) => String(decision.output));
    if (node.type === "bounded_loop") expected = ["record", "completed"];
    if (node.type === "request_form")
      expected = ["submitted", String(object(node.config).timeoutOutcome)];
    if (expected) {
      const actual = outgoing.map((edge) => String(edge.outcome));
      if (
        new Set(actual).size !== actual.length ||
        actual.length !== expected.length ||
        expected.some((outcome) => !actual.includes(outcome))
      )
        failures.push(
          workflowFailure("vortex.definition.workflow_outcomes_complete", "broken_reference"),
        );
    }
  }

  const predecessors = new Map<string, Set<string>>(
    nodes.map((node) => [String(node.nodeId), new Set()]),
  );
  edges.forEach((edge) => predecessors.get(String(edge.toNodeId))?.add(String(edge.fromNodeId)));
  const allIds = new Set(nodes.map((node) => String(node.nodeId)));
  const startId = starts.length === 1 ? String(starts[0]!.nodeId) : "";
  const dominators = new Map<string, Set<string>>(
    nodes.map((node) => [
      String(node.nodeId),
      String(node.nodeId) === startId ? new Set([startId]) : new Set(allIds),
    ]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      const id = String(node.nodeId);
      if (id === startId) continue;
      const parents = [...(predecessors.get(id) ?? [])];
      const intersection = parents.length
        ? new Set(
            [...allIds].filter((candidate) =>
              parents.every((parent) => dominators.get(parent)?.has(candidate)),
            ),
          )
        : new Set<string>();
      intersection.add(id);
      const current = dominators.get(id)!;
      if (
        current.size !== intersection.size ||
        [...current].some((entry) => !intersection.has(entry))
      ) {
        dominators.set(id, intersection);
        changed = true;
      }
    }
  }
  for (const consumer of nodes)
    walkValues(consumer.config, (value) => {
      if (value.source !== "node_output") return;
      const producerId = String(value.nodeId);
      const producer = byId.get(producerId);
      const allowed = producer
        ? producer.type === "request_form"
          ? array(object(producer.config).outputs).map((entry) => String(entry.key))
          : outputsByNodeType[String(producer.type)]
        : undefined;
      if (!producer || !allowed?.includes(String(value.outputKey)))
        failures.push(
          workflowFailure("vortex.definition.workflow_output_exists", "broken_reference"),
        );
      if (!dominators.get(String(consumer.nodeId))?.has(producerId))
        failures.push(
          workflowFailure("vortex.definition.workflow_output_dominates", "scope_conflict"),
        );
    });

  const canTerminate = new Set(
    nodes
      .filter(
        (node) =>
          node.type === "stop" || node.type === "wait_until" || node.type === "request_form",
      )
      .map((node) => String(node.nodeId)),
  );
  changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges)
      if (canTerminate.has(String(edge.toNodeId)) && !canTerminate.has(String(edge.fromNodeId))) {
        canTerminate.add(String(edge.fromNodeId));
        changed = true;
      }
  }
  if (nodes.some((node) => !canTerminate.has(String(node.nodeId))))
    failures.push(workflowFailure("vortex.definition.workflow_termination", "dependency_cycle"));

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitCycle = (nodeId: string, path: string[]) => {
    if (visiting.has(nodeId)) {
      const cycle = path.slice(path.indexOf(nodeId));
      const cycleIds = new Set(cycle);
      const boundedLoops = cycle.filter((id) => byId.get(id)?.type === "bounded_loop");
      const loopEdges =
        boundedLoops.length === 1
          ? edges.filter((edge) => edge.fromNodeId === boundedLoops[0])
          : [];
      const bounded =
        boundedLoops.length === 1 &&
        loopEdges.some(
          (edge) => edge.outcome === "record" && cycleIds.has(String(edge.toNodeId)),
        ) &&
        loopEdges.some(
          (edge) => edge.outcome === "completed" && !cycleIds.has(String(edge.toNodeId)),
        );
      if (!bounded)
        failures.push(
          workflowFailure("vortex.definition.workflow_cycles_bounded", "dependency_cycle"),
        );
      return;
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const edge of edges.filter((candidate) => candidate.fromNodeId === nodeId))
      visitCycle(String(edge.toNodeId), [...path, nodeId]);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  nodes.forEach((node) => visitCycle(String(node.nodeId), []));
  return failures;
}

const normalizeWorkflowType = (type: string): string =>
  ["whole_number", "decimal_number", "money"].includes(type)
    ? "number"
    : type === "yes_no"
      ? "boolean"
      : ["choice", "formatted_text"].includes(type)
        ? "text"
        : type === "several_choices"
          ? "json"
          : type;

export function workflowValueCompatible(
  value: JsonObject,
  expected: string,
  fields: ReadonlyMap<string, JsonObject>,
  nodes: ReadonlyMap<string, JsonObject>,
  queries: ReadonlyMap<string, JsonObject>,
  triggerRecordId?: string,
  expectedRecordTypeIds?: readonly string[],
  triggerInputs: ReadonlyMap<string, JsonObject> = new Map(),
): boolean {
  const normalizedExpected = normalizeWorkflowType(expected);
  let actual: string | undefined;
  let actualRecordTypeIds: string[] | undefined;
  if (value.source === "literal") {
    const literal = value.value;
    actual = Array.isArray(literal)
      ? "json"
      : literal === null || typeof literal === "object"
        ? "json"
        : typeof literal === "number"
          ? "number"
          : typeof literal === "boolean"
            ? "boolean"
            : typeof literal === "string" && /^\d{4}-\d{2}-\d{2}$/.test(literal)
              ? "date"
              : typeof literal === "string" && !Number.isNaN(Date.parse(literal))
                ? "date_time"
                : typeof literal === "string"
                  ? "text"
                  : undefined;
  } else if (value.source === "trigger_field") {
    const field = fields.get(String(value.fieldId));
    actual = fieldValueType(field);
    actualRecordTypeIds = fieldRecordTypeIds(field);
  } else if (value.source === "trigger_input") {
    const input = triggerInputs.get(String(value.inputKey));
    actual = input ? normalizeWorkflowType(String(input.type)) : undefined;
    actualRecordTypeIds = input?.recordTypeIds as string[] | undefined;
  } else if (value.source === "current_record") {
    actual = "record_reference";
    actualRecordTypeIds = triggerRecordId ? [triggerRecordId] : undefined;
  } else if (value.source === "current_actor") actual = "organization_account_reference";
  else if (value.source === "current_time") actual = "date_time";
  else if (value.source === "node_output") {
    const producer = nodes.get(String(value.nodeId));
    const outputKey = String(value.outputKey);
    if (producer?.type === "request_form") {
      const output = array(object(producer.config).outputs).find(
        (entry) => entry.key === outputKey,
      );
      actual = output ? normalizeWorkflowType(String(output.type)) : undefined;
      actualRecordTypeIds = output?.recordTypeIds as string[] | undefined;
    } else if (producer) {
      const declaration = workflowNodeOutputsByType[
        producer.type as keyof typeof workflowNodeOutputsByType
      ]?.find((candidate) => candidate.key === outputKey);
      actual = declaration ? normalizeWorkflowType(declaration.type) : undefined;
      const producerConfig = object(producer.config);
      if (declaration?.target === "configured_record" && producerConfig.recordTypeId !== undefined)
        actualRecordTypeIds = [String(producerConfig.recordTypeId)];
      if (declaration?.target === "query") {
        const query = queries.get(String(producerConfig.queryId));
        if (query) actualRecordTypeIds = [String(object(query.recordType).recordTypeId)];
      }
      if (declaration?.target === "input_record")
        actualRecordTypeIds = [
          workflowValueRecordType(
            object(producerConfig.record),
            nodes,
            queries,
            triggerRecordId,
            triggerInputs,
          ),
        ].filter((recordTypeId): recordTypeId is string => recordTypeId !== undefined);
    }
  }
  if (normalizedExpected === "json") return actual !== undefined;
  return (
    (actual === normalizedExpected ||
      (normalizedExpected === "record_reference" && actual === "organization_account_reference")) &&
    (expectedRecordTypeIds === undefined ||
      (actualRecordTypeIds !== undefined &&
        actualRecordTypeIds.length > 0 &&
        actualRecordTypeIds.every((recordTypeId) => expectedRecordTypeIds.includes(recordTypeId))))
  );
}

function applicationWorkflowFieldValueCompatible(
  value: JsonObject,
  target: ApplicationFieldValuePair,
  fields: ReadonlyMap<string, JsonObject>,
  fieldPairs: ReadonlyMap<string, ApplicationFieldValuePair>,
  nodes: ReadonlyMap<string, JsonObject>,
  queries: ReadonlyMap<string, JsonObject>,
  triggerRecordId: string | undefined,
  expectedRecordTypeIds: readonly string[] | undefined,
  triggerInputs: ReadonlyMap<string, JsonObject>,
): boolean {
  if (value.source === "literal")
    return target.moduleV2
      ? fieldValueMatchesV2(value.value, target.field, "canonical")
      : valueTypeCompatible(literalValueType(value.value), fieldValueType(target.field));
  if (value.source === "trigger_field") {
    const source = fieldPairs.get(String(value.fieldId));
    if (!source) return false;
    const compatible =
      source.moduleV2 !== target.moduleV2
        ? crossFormatFieldTypesCompatible(source, target)
        : target.moduleV2
          ? applicationMappingTypesCompatible(
              applicationFieldType(source),
              applicationFieldType(target),
            )
          : valueTypeCompatible(applicationFieldType(source), applicationFieldType(target));
    if (!compatible || expectedRecordTypeIds === undefined) return compatible;
    const actualRecordTypeIds = fieldRecordTypeIds(source.field);
    return (
      actualRecordTypeIds !== undefined &&
      actualRecordTypeIds.length > 0 &&
      actualRecordTypeIds.every((recordTypeId) => expectedRecordTypeIds.includes(recordTypeId))
    );
  }
  const targetType = applicationFieldType(target);
  if (
    target.moduleV2 &&
    ["decimal_number", "money", "formatted_text", "table", "attachment"].includes(
      String(targetType),
    )
  )
    return false;
  return workflowValueCompatible(
    value,
    targetType === "whole_number" ? "number" : (targetType ?? ""),
    fields,
    nodes,
    queries,
    triggerRecordId,
    expectedRecordTypeIds,
    triggerInputs,
  );
}

function applicationWorkflowInputCompatible(
  value: JsonObject,
  input: JsonObject,
  moduleV2: boolean,
  fields: ReadonlyMap<string, JsonObject>,
  fieldPairs: ReadonlyMap<string, ApplicationFieldValuePair>,
  nodes: ReadonlyMap<string, JsonObject>,
  queries: ReadonlyMap<string, JsonObject>,
  triggerRecordId: string | undefined,
  expectedRecordTypeIds: readonly string[] | undefined,
  triggerInputs: ReadonlyMap<string, JsonObject>,
): boolean {
  if (value.source === "trigger_field") {
    const source = fieldPairs.get(String(value.fieldId));
    if (!source) return false;
    const expectedType = moduleV2
      ? input.type === "formatted_text"
        ? "formatted_text"
        : semanticFieldTypeV2(input.type)
      : normalizeWorkflowType(String(input.type));
    if (!expectedType) return false;
    const actualType = applicationFieldType(source);
    const compatible = moduleV2
      ? source.moduleV2
        ? applicationMappingTypesCompatible(actualType, expectedType)
        : (expectedType === "whole_number" && actualType === "number") ||
          (actualType === expectedType &&
            ["text", "boolean", "date", "date_time", "record_reference"].includes(actualType))
      : valueTypeCompatible(applicationInterfaceFieldType(source), expectedType);
    if (!compatible || expectedRecordTypeIds === undefined) return compatible;
    const actualRecordTypeIds = fieldRecordTypeIds(source.field);
    return (
      actualRecordTypeIds !== undefined &&
      actualRecordTypeIds.length > 0 &&
      actualRecordTypeIds.every((recordTypeId) => expectedRecordTypeIds.includes(recordTypeId))
    );
  }
  if (!moduleV2)
    return workflowValueCompatible(
      value,
      String(input.type),
      fields,
      nodes,
      queries,
      triggerRecordId,
      expectedRecordTypeIds,
      triggerInputs,
    );
  const expectedType =
    input.type === "formatted_text" ? "formatted_text" : semanticFieldTypeV2(input.type);
  if (!expectedType) return false;
  if (value.source === "literal") {
    const compatible =
      input.type === "formatted_text"
        ? moduleFieldValueV2Schemas.formatted_text.safeParse(value.value).success
        : valueMatchesTypeV2(value.value, expectedType);
    if (!compatible || expectedRecordTypeIds === undefined) return compatible;
    const actualRecordTypeId = object(value.value).recordTypeId;
    return (
      typeof actualRecordTypeId === "string" && expectedRecordTypeIds.includes(actualRecordTypeId)
    );
  }
  if (["decimal_number", "money", "formatted_text"].includes(String(input.type))) return false;
  return workflowValueCompatible(
    value,
    expectedType === "whole_number" ? "number" : expectedType,
    fields,
    nodes,
    queries,
    triggerRecordId,
    expectedRecordTypeIds,
    triggerInputs,
  );
}

function workflowValueRecordType(
  value: JsonObject,
  nodes: ReadonlyMap<string, JsonObject>,
  queries: ReadonlyMap<string, JsonObject>,
  triggerRecordId?: string,
  triggerInputs: ReadonlyMap<string, JsonObject> = new Map(),
  visiting: ReadonlySet<string> = new Set(),
): string | undefined {
  if (value.source === "current_record") return triggerRecordId;
  if (value.source === "trigger_input") {
    const input = triggerInputs.get(String(value.inputKey));
    const recordTypeIds = input?.recordTypeIds as string[] | undefined;
    return recordTypeIds?.length === 1 ? recordTypeIds[0] : undefined;
  }
  if (value.source !== "node_output") return undefined;
  const nodeId = String(value.nodeId);
  if (visiting.has(nodeId)) return undefined;
  const producer = nodes.get(nodeId);
  if (!producer) return undefined;
  const config = object(producer.config);
  if (["create_record", "change_record", "duplicate_record"].includes(String(producer.type)))
    return config.recordTypeId === undefined ? undefined : String(config.recordTypeId);
  if (["bounded_loop", "query_records"].includes(String(producer.type))) {
    const query = queries.get(String(config.queryId));
    return query ? String(object(query.recordType).recordTypeId) : undefined;
  }
  if (producer.type === "set_values")
    return workflowValueRecordType(
      object(config.record),
      nodes,
      queries,
      triggerRecordId,
      triggerInputs,
      new Set([...visiting, nodeId]),
    );
  return undefined;
}

function applicationRule(context: DefinitionSetValidationContext): DefinitionRuleFailure[] {
  const walkValues = canonicalValueWalker(context);
  const failures: DefinitionRuleFailure[] = [];
  const availableOutputs = allValidationOutputs(context);
  const modules = availableOutputs.filter((output) => output.kind === "module");
  const connections = availableOutputs.filter((output) => output.kind === "connection_type");
  for (const output of context.outputs.filter((entry) => entry.kind === "application")) {
    const applicationV2 = "validationContractVersion" in output;
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
      const inspectSubjectReferences = (value: unknown) => {
        walkValues(value, (entry) => {
          if (entry.source === "subject_field" && !subjectFieldIds.has(String(entry.fieldId)))
            safe = false;
          if (entry.source === "field" && !subjectFieldIds.has(String(entry.fieldId))) safe = false;
        });
      };
      inspectSubjectReferences(action.precondition);
      for (const effect of array(action.effects)) {
        if (effect.kind === "set_field") {
          if (!subjectFieldIds.has(String(effect.fieldId))) safe = false;
          inspectSubjectReferences(effect.value);
        }
        if (effect.kind === "create_record") {
          const targetRecord = records.get(String(object(effect.recordType).recordTypeId));
          const targetRecordId = String(object(effect.recordType).recordTypeId);
          const targetPublicFields =
            expectedSubjectRecordId !== undefined
              ? (restrictedSubjectFieldIds ?? new Set<string>())
              : publicFieldIds(targetRecord);
          if (
            !targetRecord ||
            (expectedSubjectRecordId !== undefined && targetRecordId !== expectedSubjectRecordId) ||
            Object.keys(object(effect.values)).some((fieldId) => !targetPublicFields.has(fieldId))
          )
            safe = false;
          for (const value of Object.values(object(effect.values))) inspectSubjectReferences(value);
        }
        if (
          effect.kind === "copy_relationships" &&
          array(effect.relationshipIds).some((id) => !allowedRelationshipIds.has(String(id)))
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
    const executableActionKeys = new Set([...actionKeys, ...standardActionKeys]);
    const events = new Map(
      [
        ...array(content.events),
        ...boundModules.flatMap((module) => array(object(object(module.canonical).content).events)),
      ].map((event) => [String(event.key), event]),
    );
    const pages = new Map(array(content.pages).map((page) => [String(page.pageId), page]));
    const shells = new Map(
      (applicationV2 ? array(content.shells) : []).map((shell) => [String(shell.shellId), shell]),
    );
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
    const pipelines = new Map(
      array(content.pipelines).map((pipeline) => [String(pipeline.pipelineId), pipeline]),
    );
    const workflows = new Map(
      array(content.workflows).map((workflow) => [String(workflow.workflowId), workflow]),
    );
    const workflowTriggerRecordType = (
      candidate: JsonObject | undefined,
      visiting: ReadonlySet<string> = new Set(),
    ): string | undefined => {
      if (!candidate) return undefined;
      const candidateId = String(candidate.workflowId);
      if (visiting.has(candidateId)) return undefined;
      const candidateTrigger = object(candidate.trigger);
      if (candidateTrigger.kind === "event") return String(candidateTrigger.recordTypeId);
      if (candidateTrigger.kind === "button") {
        const action = actions.get(String(candidateTrigger.actionKey));
        return action !== undefined
          ? String(action.subjectRecordTypeId)
          : standardActionRecordTypes.get(String(candidateTrigger.actionKey));
      }
      if (candidateTrigger.kind === "workflow")
        return workflowTriggerRecordType(
          workflows.get(String(candidateTrigger.workflowId)),
          new Set([...visiting, candidateId]),
        );
      return undefined;
    };
    const blocks = new Map(
      (applicationV2 ? [] : array(content.blockRegistrations)).map((block) => [
        String(block.blockId),
        block,
      ]),
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
    const connectionBindings = new Map(
      connectionBindingEntries.map((binding) => [String(binding.bindingId), binding]),
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
      let valid =
        subject !== undefined &&
        actionPermissionKeys(action).length > 0 &&
        permissionEntries.length === permissionMap.size &&
        actionPermissionsMatch(action, permissionMap, permissionOwnersByKey) &&
        applicationFieldReferencesValid(action.precondition, fields) &&
        (action.precondition === undefined ||
          applicationConditionTypesValid(
            action.precondition,
            fieldMap,
            subjectModuleV2,
            inputTypes,
          ));
      for (const effect of array(action.effects)) {
        if (
          effect.kind === "set_field" &&
          (!fields.has(String(effect.fieldId)) ||
            !applicationActionValueCompatible(
              effect.value,
              fieldValuePairs.get(String(effect.fieldId)),
              fieldMap,
              subjectModuleV2,
              inputMap,
              String(action.subjectRecordTypeId),
            ))
        )
          valid = false;
        if (
          effect.kind === "copy_relationships" &&
          ((effect.relationshipIds as string[]).some((id) => !relationships.has(id)) ||
            inputMap.get(String(effect.targetInputKey))?.type !== "record_reference" ||
            !array(inputMap.get(String(effect.targetInputKey))?.recordTypes)
              .map((reference) => String(reference.recordTypeId))
              .includes(String(action.subjectRecordTypeId)))
        )
          valid = false;
        if (effect.kind === "announce_event" && !events.has(String(effect.eventKey))) valid = false;
        if (effect.kind === "create_record") {
          const target = records.get(String(object(effect.recordType).recordTypeId));
          const targetFields = new Map(
            target ? array(target.fields).map((field) => [String(field.fieldId), field]) : [],
          );
          if (
            !target ||
            Object.entries(object(effect.values)).some(
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
        walkValues(effect, (entry) => {
          if (entry.source === "input" && !inputs.has(String(entry.inputKey))) valid = false;
          if (entry.source === "subject_field" && !fields.has(String(entry.fieldId))) valid = false;
        });
      }
      if (!valid)
        failures.push(
          failure(output, "vortex.definition.application_action_references", "broken_reference"),
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
    const applicationPlacementIds = new Set(
      applicationV2
        ? [
            ...[...shells.values()].flatMap((shell) => collectPlacementEntriesV2(shell.layout)),
            ...[...pages.values()].flatMap(pageContentPlacementEntriesV2),
          ].map(([placementId]) => placementId)
        : [...pages.values()].flatMap((page) =>
            page.type === "guided_form"
              ? array(page.steps).flatMap((step) =>
                  array(step.blocks).map((placement) => String(placement.placementId)),
                )
              : page.blocks
                ? array(page.blocks).map((placement) => String(placement.placementId))
                : [],
          ),
    );
    for (const rule of array(content.rules)) {
      const record = records.get(String(rule.subjectRecordTypeId));
      const moduleV2 = recordValuePairs.get(String(rule.subjectRecordTypeId)) ?? false;
      const fieldMap = new Map(
        record ? array(record.fields).map((field) => [String(field.fieldId), field]) : [],
      );
      const fields = new Set(fieldMap.keys());
      const effect = object(rule.effect);
      if (
        !record ||
        !applicationFieldReferencesValid(rule.condition, fields) ||
        !applicationFieldReferencesValid(effect, fields) ||
        !applicationConditionTypesValid(rule.condition, fieldMap, moduleV2) ||
        (effect.kind === "start_background_work" && !workflows.has(String(effect.workflowId))) ||
        (effect.kind === "show_or_hide" &&
          !applicationPlacementIds.has(String(effect.componentId))) ||
        (effect.kind === "set_value" &&
          !(moduleV2
            ? fieldValueMatchesV2(effect.value, fieldMap.get(String(effect.fieldId)), "canonical")
            : valueTypeCompatible(
                literalValueType(effect.value),
                fieldValueType(fieldMap.get(String(effect.fieldId))),
              )))
      )
        failures.push(
          failure(output, "vortex.definition.application_rule_references", "broken_reference"),
        );
    }
    const identityCollections: readonly (readonly [JsonObject[], string, string])[] = [
      [array(content.pages), "pageId", "key"],
      [array(content.roles), "roleId", "key"],
      [array(content.queries), "queryId", "key"],
      ...(applicationV2 ? [] : ([[array(content.blockRegistrations), "blockId", "name"]] as const)),
      [array(content.pipelines), "pipelineId", "key"],
      [array(content.permissions), "permissionId", "key"],
      [array(content.actions), "actionId", "key"],
      [array(content.rules), "ruleId", "key"],
      [array(content.events), "eventId", "key"],
      [array(content.workflows), "workflowId", "key"],
      [array(content.connectionBindings), "bindingId", "key"],
      [array(content.interfaces), "interfaceId", "key"],
      [array(content.publicAddresses), "addressId", "path"],
    ] as const;
    for (const [collection, idProperty, keyProperty] of identityCollections) {
      const ids = collection.map((entry) => String(entry[idProperty]));
      const keys = collection.map((entry) => String(entry[keyProperty]));
      if (new Set(ids).size !== ids.length || new Set(keys).size !== keys.length)
        failures.push(
          failure(output, "vortex.definition.application_identity_unique", "duplicate_key"),
        );
    }
    const navigationIds: string[] = [];
    const collectNavigationIds = (items: JsonObject[]) => {
      for (const item of items) {
        navigationIds.push(String(item.id));
        if (item.type === "heading") collectNavigationIds(array(item.children));
      }
    };
    collectNavigationIds(array(content.navigation));
    const placementIds = applicationV2
      ? [...applicationPlacementIds]
      : [...pages.values()].flatMap((page) =>
          page.type === "guided_form"
            ? array(page.steps).flatMap((step) =>
                array(step.blocks).map((placement) => String(placement.placementId)),
              )
            : page.blocks
              ? array(page.blocks).map((placement) => String(placement.placementId))
              : [],
        );
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
        (!pages.has(String(item.pageId)) || !permissions.has(String(item.permissionKey)))
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
      const pageQuery = page.queryId ? queries.get(String(page.queryId)) : undefined;
      const pageQueryRecordId = pageQuery
        ? String(object(pageQuery.recordType).recordTypeId)
        : undefined;
      const commitActionRecordId = page.commitActionKey
        ? (actions.get(String(page.commitActionKey))?.subjectRecordTypeId ??
          standardActionRecordTypes.get(String(page.commitActionKey)))
        : undefined;
      if (!permissions.has(String(page.accessPermissionKey)))
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
      const replacementRecordId = page.standardPageReplacement
        ? String(object(object(page.standardPageReplacement).recordType).recordTypeId)
        : undefined;
      if (
        (page.recordType && !pageRecord) ||
        (page.standardPageReplacement &&
          (!records.has(replacementRecordId!) ||
            !pageRecordId ||
            replacementRecordId !== pageRecordId)) ||
        (page.commitActionKey &&
          (!executableActionKeys.has(String(page.commitActionKey)) ||
            !pageRecordId ||
            String(commitActionRecordId) !== pageRecordId))
      )
        failures.push(
          failure(output, "vortex.definition.application_page_references", "broken_reference"),
        );
      if (page.calendarMapping) {
        const mapping = object(page.calendarMapping);
        const pageFields = new Map(
          pageRecord
            ? array(pageRecord.fields).map((field) => [String(field.fieldId), String(field.type)])
            : [],
        );
        const startType = pageFields.get(String(mapping.startFieldId));
        const endType = mapping.endFieldId ? pageFields.get(String(mapping.endFieldId)) : undefined;
        const durationType = mapping.durationFieldId
          ? pageFields.get(String(mapping.durationFieldId))
          : undefined;
        if (
          !["date", "date_time"].includes(String(startType)) ||
          (mapping.kind === "start_end" && endType !== startType) ||
          (mapping.kind === "start_duration" &&
            !["whole_number", "decimal_number"].includes(String(durationType)))
        )
          failures.push(
            failure(output, "vortex.definition.application_calendar_mapping", "scope_conflict"),
          );
      }
      const pageContentPlacements = applicationV2
        ? pageContentPlacementEntriesV2(page).map(([, placement]) => placement)
        : page.type === "guided_form"
          ? array(page.steps).flatMap((step) => array(step.blocks))
          : page.blocks
            ? array(page.blocks)
            : [];
      const placements = applicationV2
        ? [
            ...pageContentPlacements,
            ...pageShellPlacementEntriesV2(page).map(([, placement]) => placement),
          ]
        : pageContentPlacements;
      const placementIds = placements.map((placement) => String(placement.placementId));
      const desktopOrder = applicationV2
        ? []
        : (object(object(page.layout).desktop).componentOrder as string[]);
      const phoneOrder = applicationV2
        ? []
        : (object(object(page.layout).phone).componentOrder as string[]);
      if (
        !applicationV2 &&
        (new Set(placementIds).size !== placementIds.length ||
          desktopOrder.length !== placementIds.length ||
          phoneOrder.length !== placementIds.length ||
          placementIds.some((id) => !desktopOrder.includes(id) || !phoneOrder.includes(id)))
      )
        failures.push(
          failure(output, "vortex.definition.application_layout_complete", "broken_reference"),
        );
      const pageFieldIds = new Set(
        pageRecord ? array(pageRecord.fields).map((field) => String(field.fieldId)) : [],
      );
      const pageRelationshipIds = new Set(
        pageRecord
          ? array(pageRecord.relationships).map((relationship) =>
              String(relationship.relationshipId),
            )
          : [],
      );
      for (const placement of placements) {
        if (applicationV2) continue;
        const block = blocks.get(String(placement.blockId));
        const placementQuery = placement.queryId
          ? queries.get(String(placement.queryId))
          : undefined;
        if (
          !block ||
          block.releaseVersion !== placement.blockReleaseVersion ||
          !permissions.has(String(placement.viewPermissionKey)) ||
          (placement.usePermissionKey && !permissions.has(String(placement.usePermissionKey))) ||
          (placement.queryId &&
            (!placementQuery ||
              (pageRecordId !== undefined &&
                String(object(placementQuery.recordType).recordTypeId) !== pageRecordId)))
        )
          failures.push(
            failure(output, "vortex.definition.application_block_references", "broken_reference"),
          );
        if (block) {
          const settings = object(placement.settings);
          const declarations = array(block.settings);
          const allowed = new Set(declarations.map((setting) => String(setting.key)));
          const required = declarations
            .filter((setting) => setting.required === true)
            .map((setting) => String(setting.key));
          if (
            Object.keys(settings).some((key) => !allowed.has(key)) ||
            required.some((key) => !(key in settings)) ||
            declarations.some((setting) => {
              if (!(String(setting.key) in settings)) return false;
              const value = object(settings[String(setting.key)]);
              const control = String(setting.control);
              const expectedKind =
                blockSettingReferenceKindByControl[
                  control as keyof typeof blockSettingReferenceKindByControl
                ] ?? "literal";
              if (value.kind !== expectedKind) return true;
              if (value.kind === "literal") {
                if (control === "switch") return typeof value.value !== "boolean";
                if (control === "number")
                  return typeof value.value !== "number" || !Number.isFinite(value.value);
                return typeof value.value !== "string";
              }
              if (value.kind === "field_reference") return !allFields.has(String(value.fieldId));
              if (value.kind === "relationship_reference")
                return !allRelationships.has(String(value.relationshipId));
              if (value.kind === "action_reference")
                return !executableActionKeys.has(String(value.actionKey));
              if (value.kind === "page_reference") return !pages.has(String(value.pageId));
              if (value.kind === "query_reference") return !queries.has(String(value.queryId));
              if (value.kind === "pipeline_reference")
                return !pipelines.has(String(value.pipelineId));
              if (value.kind === "record_type_reference" || value.kind === "record_reference")
                return !records.has(String(object(value.recordType).recordTypeId));
              return true;
            })
          )
            failures.push(
              failure(output, "vortex.definition.application_block_settings", "broken_reference"),
            );
          const pageScopeInvalid = Object.values(settings).some((settingValue) => {
            if (!pageRecordId) return false;
            const value = object(settingValue);
            if (value.kind === "field_reference") return !pageFieldIds.has(String(value.fieldId));
            if (value.kind === "relationship_reference")
              return !pageRelationshipIds.has(String(value.relationshipId));
            if (value.kind === "action_reference") {
              const actionRecordId =
                actions.get(String(value.actionKey))?.subjectRecordTypeId ??
                standardActionRecordTypes.get(String(value.actionKey));
              return !pageRecordId || String(actionRecordId) !== pageRecordId;
            }
            if (value.kind === "page_reference") {
              const referencedPage = pages.get(String(value.pageId));
              const referencedRecordId = referencedPage?.recordType
                ? String(object(referencedPage.recordType).recordTypeId)
                : undefined;
              return !referencedPage || referencedRecordId !== pageRecordId;
            }
            if (value.kind === "query_reference") {
              const referencedQuery = queries.get(String(value.queryId));
              return (
                !referencedQuery ||
                String(object(referencedQuery.recordType).recordTypeId) !== pageRecordId
              );
            }
            if (value.kind === "pipeline_reference") {
              const referencedPipeline = pipelines.get(String(value.pipelineId));
              return (
                !referencedPipeline ||
                String(object(referencedPipeline.recordType).recordTypeId) !== pageRecordId
              );
            }
            if (value.kind === "record_type_reference" || value.kind === "record_reference")
              return String(object(value.recordType).recordTypeId) !== pageRecordId;
            return false;
          });
          if (pageScopeInvalid)
            failures.push(
              failure(output, "vortex.definition.application_block_references", "scope_conflict"),
            );
        }
        if (
          placement.visibilityCondition !== undefined &&
          !applicationConditionTypesValid(
            placement.visibilityCondition,
            new Map(
              pageRecord
                ? array(pageRecord.fields).map((field) => [String(field.fieldId), field] as const)
                : [],
            ),
            pageRecordId === undefined ? false : (recordValuePairs.get(pageRecordId) ?? false),
          )
        )
          failures.push(
            failure(output, "vortex.definition.application_block_references", "broken_reference"),
          );
        if (page.type === "public" && block?.publicPage !== true)
          failures.push(
            failure(output, "vortex.definition.application_public_surface", "unsafe_content"),
          );
      }
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
            (applicationV2
              ? placement.viewPermissionKey !== undefined &&
                !publicPermissionSafe(placement.viewPermissionKey)
              : !publicPermissionSafe(placement.viewPermissionKey)) ||
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
              const query = queries.get(String(setting.queryId));
              if (!publicQuerySafe(query, pageRecordId, pagePublicFields))
                publicBlockReferencesSafe = false;
            }
          };
          if (applicationV2) walkValues(placement.settings, inspectPublicSetting);
          else
            for (const settingValue of Object.values(object(placement.settings)))
              inspectPublicSetting(object(settingValue));
          if (placement.queryId) {
            const query = queries.get(String(placement.queryId));
            if (!publicQuerySafe(query, pageRecordId, pagePublicFields))
              publicBlockReferencesSafe = false;
          }
        }
        if (
          (page.publicFieldIds as string[]).some((id) => !publicFields.has(id)) ||
          !publicPermissionSafe(page.accessPermissionKey) ||
          (page.queryId &&
            !publicQuerySafe(queries.get(String(page.queryId)), pageRecordId, pagePublicFields)) ||
          (page.publicActionKey &&
            !publicActionSafe(page.publicActionKey, pageRecordId, pagePublicFields)) ||
          !publicBlockReferencesSafe
        )
          failures.push(
            failure(output, "vortex.definition.application_public_surface", "unsafe_content"),
          );
      }
    }
    for (const block of blocks.values())
      if ((block.allowedChildBlockIds as string[]).some((childId) => !blocks.has(String(childId))))
        failures.push(
          failure(output, "vortex.definition.application_block_references", "broken_reference"),
        );
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
          [...(stage.entryWorkflowIds as string[]), ...(stage.exitWorkflowIds as string[])].some(
            (id) => !workflows.has(id),
          )
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
    const queriesByKey = new Map([...queries.values()].map((query) => [String(query.key), query]));
    const workflowsByKey = new Map(
      [...workflows.values()].map((workflow) => [String(workflow.key), workflow]),
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
        const targetQuery =
          target.kind === "query" ? queriesByKey.get(String(target.key)) : undefined;
        const targetWorkflow =
          target.kind === "workflow" ? workflowsByKey.get(String(target.key)) : undefined;
        const targetAction = target.kind === "action" ? actions.get(String(target.key)) : undefined;
        const targetActionPair =
          target.kind === "action" ? moduleActionValuePairs.get(String(target.key)) : undefined;
        const targetExists =
          targetQuery !== undefined || targetWorkflow !== undefined || targetAction !== undefined;
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
        let shapeMatchesTarget = targetExists;
        if (target.kind === "action") {
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
        }
        if (target.kind === "query") {
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
        if (target.kind === "workflow") {
          const outputs = Object.values(outputShape);
          shapeMatchesTarget =
            targetWorkflow !== undefined &&
            object(targetWorkflow.trigger).kind === "interface" &&
            object(targetWorkflow.trigger).operationKey === operation.key &&
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

        if (operation.visibility === "public") {
          if (
            !publicPermissionSafe(operation.permissionKey) ||
            (target.kind === "action" && !publicActionSafe(target.key))
          )
            failures.push(
              failure(output, "vortex.definition.application_interface_exposure", "unsafe_content"),
            );
          if (
            target.kind === "query" &&
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
    for (const workflow of workflows.values()) {
      failures.push(...validateWorkflow(output, workflow));
      const workflowFailure = (ruleCode: string, family: DefinitionRuleFailure["family"]) =>
        failure(output, ruleCode, family, { kind: "workflow", key: String(workflow.key) });
      const workflowNodes = new Map(
        array(workflow.nodes).map((node) => [String(node.nodeId), node]),
      );
      const trigger = object(workflow.trigger);
      const interfaceOperations = array(content.interfaces).flatMap((definition) =>
        array(definition.operations),
      );
      const interfaceTriggerOperations = interfaceOperations.filter((operation) => {
        const target = object(operation.target);
        return (
          operation.key === trigger.operationKey &&
          target.kind === "workflow" &&
          target.key === workflow.key
        );
      });
      const boundIncomingMessageContracts = [...connectionBindings.values()].flatMap((binding) => {
        const connection = connectionMap.get(String(binding.connectionTypeId));
        if (!connection) return [];
        const shapes = new Map(
          array(connection.shapes).map((shape) => [String(shape.key), shape] as const),
        );
        return array(connection.incomingMessages).map((message) => ({
          message,
          shape: shapes.get(String(message.inputShapeKey)),
        }));
      });
      const boundIncomingMessages = boundIncomingMessageContracts.map(({ message }) => message);
      const incomingMessageKeys = new Set(
        boundIncomingMessages.map((message) => String(message.key)),
      );
      const incomingMessageKeyCount = boundIncomingMessages.length;
      const incomingTriggerContracts = boundIncomingMessageContracts.filter(
        ({ message }) => message.workflowTriggerKey === trigger.messageKey,
      );
      const triggerEvent =
        trigger.kind === "event" ? events.get(String(trigger.eventKey)) : undefined;
      const triggerAction =
        trigger.kind === "button" ? actions.get(String(trigger.actionKey)) : undefined;
      const triggerRecordId =
        trigger.kind === "event" || trigger.kind === "button" || trigger.kind === "workflow"
          ? workflowTriggerRecordType(workflow)
          : undefined;
      const sourceWorkflow =
        request?.source.kind === "application"
          ? request.source.body.workflows.find(
              (candidate) => candidate.key === String(workflow.key),
            )
          : undefined;
      const sourceTrigger = sourceWorkflow?.trigger;
      let authoredEventRecordId: string | undefined;
      if (sourceTrigger?.kind === "event") {
        const qualified = sourceTrigger.record_type;
        const separator = qualified.lastIndexOf(":");
        const definitionKey = qualified.slice(0, separator);
        const alias = qualified.slice(separator + 1);
        authoredEventRecordId = request?.resolution.identities.find(
          (identity) =>
            identity.definitionKey === definitionKey &&
            identity.kind === "record_type" &&
            identity.alias === alias,
        )?.identifier;
      }
      if (
        (trigger.kind === "event" &&
          (!triggerEvent ||
            !authoredEventRecordId ||
            String(triggerEvent.recordTypeId) !== authoredEventRecordId ||
            String(trigger.recordTypeId) !== authoredEventRecordId)) ||
        (trigger.kind === "button" && !executableActionKeys.has(String(trigger.actionKey))) ||
        (trigger.kind === "interface" && interfaceTriggerOperations.length !== 1) ||
        (trigger.kind === "incoming_message" &&
          (incomingTriggerContracts.length !== 1 ||
            incomingTriggerContracts[0]?.shape === undefined ||
            incomingMessageKeyCount !== incomingMessageKeys.size)) ||
        (trigger.kind === "workflow" &&
          (() => {
            const parent = workflows.get(String(trigger.workflowId));
            return (
              !parent ||
              !array(parent.nodes).some(
                (node) =>
                  node.type === "start_workflow" &&
                  object(node.config).workflowId === workflow.workflowId,
              )
            );
          })())
      )
        failures.push(
          workflowFailure("vortex.definition.workflow_trigger_reference", "broken_reference"),
        );
      const triggerFieldIds = new Set(
        triggerEvent ? (triggerEvent.carriedFieldIds as string[]) : [],
      );
      const triggerRecord = triggerRecordId ? records.get(triggerRecordId) : undefined;
      const triggerModuleV2 =
        triggerRecordId === undefined ? false : (recordValuePairs.get(triggerRecordId) ?? false);
      const triggerRecordFields = new Map(
        triggerRecord
          ? array(triggerRecord.fields).map((field) => [String(field.fieldId), field])
          : [],
      );
      const triggerInputs = array(trigger.inputs);
      const triggerInputKeys = triggerInputs.map((input) => String(input.key));
      const triggerInputsByKey = new Map(
        triggerInputs.map((input) => {
          if (input.source !== "record_field" || input.recordTypeIds !== undefined)
            return [String(input.key), input] as const;
          const recordTypeIds = fieldRecordTypeIds(triggerRecordFields.get(String(input.fieldId)));
          return [
            String(input.key),
            recordTypeIds === undefined ? input : { ...input, recordTypeIds },
          ] as const;
        }),
      );
      const declaredTriggerFieldIds = new Set(
        triggerInputs
          .filter((input) => input.source === "record_field")
          .map((input) => String(input.fieldId)),
      );
      const expectedPayloadInputs = new Map<string, { type: string; recordTypeIds?: string[] }>();
      if (trigger.kind === "button" && triggerAction)
        for (const input of array(triggerAction.inputs))
          expectedPayloadInputs.set(String(input.key), {
            type:
              interfaceActionInputType(
                input.type,
                moduleActionValuePairs.get(String(trigger.actionKey))?.moduleV2 ?? false,
              ) ?? `unsupported:${String(input.type)}`,
            ...(input.recordTypes
              ? {
                  recordTypeIds: array(input.recordTypes).map((reference) =>
                    String(reference.recordTypeId),
                  ),
                }
              : {}),
          });
      if (trigger.kind === "incoming_message") {
        const shape = incomingTriggerContracts[0]?.shape;
        if (shape)
          for (const field of array(shape.fields))
            expectedPayloadInputs.set(String(field.key), { type: String(field.type) });
      }
      if (trigger.kind === "interface") {
        const operation = interfaceTriggerOperations[0];
        if (operation)
          for (const [key, descriptor] of Object.entries(object(operation.inputShape)))
            expectedPayloadInputs.set(key, { type: String(object(descriptor).type) });
      }
      const payloadInputs = triggerInputs.filter((input) => input.source === "payload");
      const payloadInputContractValid =
        payloadInputs.length === expectedPayloadInputs.size &&
        new Set(payloadInputs.map((input) => String(input.payloadKey))).size ===
          payloadInputs.length &&
        payloadInputs.every((input) => {
          const expected = expectedPayloadInputs.get(String(input.payloadKey));
          const actualRecordTypes = new Set((input.recordTypeIds as string[] | undefined) ?? []);
          const expectedRecordTypes = new Set(expected?.recordTypeIds ?? []);
          return (
            expected !== undefined &&
            normalizeWorkflowType(String(input.type)) === normalizeWorkflowType(expected.type) &&
            actualRecordTypes.size === expectedRecordTypes.size &&
            [...actualRecordTypes].every((recordTypeId) => expectedRecordTypes.has(recordTypeId))
          );
        });
      const triggerContractValid =
        trigger.duplicateProtection === "required" &&
        new Set(triggerInputKeys).size === triggerInputKeys.length &&
        (trigger.kind === "event"
          ? triggerInputs.every((input) => {
              const field = triggerRecordFields.get(String(input.fieldId));
              const pair = fieldValuePairs.get(String(input.fieldId));
              const fieldInputType = applicationInterfaceFieldType(pair);
              const advertisedRecordTypeIds = input.recordTypeIds as string[] | undefined;
              const fieldRecordTypeTargets = fieldRecordTypeIds(field);
              const referenceTargetsValid =
                input.type === "record_reference"
                  ? advertisedRecordTypeIds === undefined ||
                    (fieldRecordTypeTargets !== undefined &&
                      fieldRecordTypeTargets.every((recordTypeId) =>
                        advertisedRecordTypeIds.includes(recordTypeId),
                      ))
                  : advertisedRecordTypeIds === undefined;
              return (
                input.source === "record_field" &&
                field !== undefined &&
                triggerFieldIds.has(String(input.fieldId)) &&
                fieldInputType !== undefined &&
                normalizeWorkflowType(String(input.type)) ===
                  normalizeWorkflowType(fieldInputType) &&
                referenceTargetsValid
              );
            })
          : triggerInputs.every((input) => input.source === "payload") &&
            payloadInputContractValid &&
            trigger.condition === null) &&
        (trigger.condition === null ||
          (triggerRecord !== undefined &&
            applicationConditionTypesValid(
              trigger.condition,
              triggerRecordFields,
              triggerModuleV2,
            ) &&
            applicationFieldReferencesValid(
              trigger.condition,
              new Set(triggerRecordFields.keys()),
            )));
      if (!triggerContractValid)
        failures.push(
          workflowFailure("vortex.definition.workflow_trigger_values", "scope_conflict"),
        );
      for (const node of array(workflow.nodes)) {
        if (node.permissionKey && !permissions.has(String(node.permissionKey)))
          failures.push(
            workflowFailure("vortex.definition.workflow_permission", "broken_reference"),
          );
        walkValues(node.config, (value) => {
          if (value.source === "trigger_input" && !triggerInputsByKey.has(String(value.inputKey)))
            failures.push(
              workflowFailure("vortex.definition.workflow_trigger_values", "scope_conflict"),
            );
          if (value.source === "trigger_field" && trigger.kind !== "event")
            failures.push(
              workflowFailure("vortex.definition.workflow_trigger_values", "scope_conflict"),
            );
          if (
            trigger.kind === "event" &&
            value.source === "trigger_field" &&
            !declaredTriggerFieldIds.has(String(value.fieldId))
          )
            failures.push(
              workflowFailure("vortex.definition.workflow_trigger_values", "scope_conflict"),
            );
          if (value.source === "current_record" && triggerRecordId === undefined)
            failures.push(
              workflowFailure("vortex.definition.workflow_trigger_values", "scope_conflict"),
            );
        });
        const config = object(node.config);
        const compatibleWorkflowValue = (
          value: unknown,
          expected: string,
          expectedRecordTypeIds?: readonly string[],
        ) =>
          workflowValueCompatible(
            object(value),
            expected,
            allFields,
            workflowNodes,
            queries,
            triggerRecordId,
            expectedRecordTypeIds,
            triggerInputsByKey,
          );
        let nodeValuesValid = true;
        if (
          node.type === "condition" &&
          (!applicationConditionTypesValid(
            config.condition,
            triggerRecordFields,
            triggerModuleV2,
          ) ||
            !applicationFieldReferencesValid(config.condition, new Set(triggerRecordFields.keys())))
        )
          nodeValuesValid = false;
        if (
          node.type === "decision_table" &&
          array(config.decisions).some(
            (decision) =>
              !applicationConditionTypesValid(
                decision.when,
                triggerRecordFields,
                triggerModuleV2,
              ) ||
              !applicationFieldReferencesValid(decision.when, new Set(triggerRecordFields.keys())),
          )
        )
          nodeValuesValid = false;
        if (node.type === "create_record" || node.type === "change_record") {
          const target = records.get(String(config.recordTypeId));
          const targetFields = new Map(
            target ? array(target.fields).map((field) => [String(field.fieldId), field]) : [],
          );
          if (
            !target ||
            (node.type === "change_record" &&
              !compatibleWorkflowValue(config.record, "record_reference", [
                String(config.recordTypeId),
              ])) ||
            Object.entries(object(config.values)).some(([fieldId, value]) => {
              const field = targetFields.get(fieldId);
              const pair = fieldValuePairs.get(fieldId);
              return (
                !field ||
                !pair ||
                !applicationWorkflowFieldValueCompatible(
                  object(value),
                  pair,
                  allFields,
                  fieldValuePairs,
                  workflowNodes,
                  queries,
                  triggerRecordId,
                  fieldRecordTypeIds(field),
                  triggerInputsByKey,
                )
              );
            })
          )
            nodeValuesValid = false;
        }
        if (node.type === "set_values") {
          const recordTypeId = workflowValueRecordType(
            object(config.record),
            workflowNodes,
            queries,
            triggerRecordId,
            triggerInputsByKey,
          );
          const target = recordTypeId ? records.get(recordTypeId) : undefined;
          const targetFields = new Map(
            target ? array(target.fields).map((field) => [String(field.fieldId), field]) : [],
          );
          if (
            !recordTypeId ||
            !target ||
            !compatibleWorkflowValue(config.record, "record_reference", [recordTypeId]) ||
            Object.entries(object(config.values)).some(([fieldId, value]) => {
              const field = targetFields.get(fieldId);
              const pair = fieldValuePairs.get(fieldId);
              return (
                !field ||
                !pair ||
                !applicationWorkflowFieldValueCompatible(
                  object(value),
                  pair,
                  allFields,
                  fieldValuePairs,
                  workflowNodes,
                  queries,
                  triggerRecordId,
                  fieldRecordTypeIds(field),
                  triggerInputsByKey,
                )
              );
            })
          )
            nodeValuesValid = false;
        }
        if (["soft_delete_record", "duplicate_record"].includes(String(node.type)))
          nodeValuesValid =
            nodeValuesValid &&
            compatibleWorkflowValue(config.record, "record_reference", [
              String(config.recordTypeId),
            ]);
        if (node.type === "add_relationship") {
          const relationship = relationshipMap.get(String(config.relationshipId));
          const targetReferences = relationship?.toRecordType
            ? [relationship.toRecordType]
            : ((relationship?.toRecordTypes as unknown[] | undefined) ?? []);
          const targetRecordIds = new Set(
            targetReferences.map((reference) => String(object(reference).recordTypeId)),
          );
          const targetRecordType = workflowValueRecordType(
            object(config.target),
            workflowNodes,
            queries,
            triggerRecordId,
            triggerInputsByKey,
          );
          if (
            !relationship ||
            !compatibleWorkflowValue(config.subject, "record_reference", [
              String(relationship.fromRecordTypeId),
            ]) ||
            !targetRecordType ||
            !targetRecordIds.has(targetRecordType) ||
            !compatibleWorkflowValue(config.target, "record_reference", [targetRecordType])
          )
            nodeValuesValid = false;
        }
        if (node.type === "copy_relationships") {
          const relationships = (config.relationshipIds as string[]).map((id) =>
            relationshipMap.get(id),
          );
          const recordTypeIds = new Set(
            relationships
              .filter((entry): entry is JsonObject => entry !== undefined)
              .map((entry) => String(entry.fromRecordTypeId)),
          );
          const recordTypeId = recordTypeIds.size === 1 ? [...recordTypeIds][0] : undefined;
          if (
            relationships.some((entry) => entry === undefined) ||
            !recordTypeId ||
            !compatibleWorkflowValue(config.sourceRecord, "record_reference", [recordTypeId]) ||
            !compatibleWorkflowValue(config.targetRecord, "record_reference", [recordTypeId])
          )
            nodeValuesValid = false;
        }
        if (node.type === "run_action") {
          const action = actions.get(String(config.actionKey));
          const actionRecordTypeId =
            action !== undefined
              ? String(action.subjectRecordTypeId)
              : standardActionRecordTypes.get(String(config.actionKey));
          if (
            !actionRecordTypeId ||
            !compatibleWorkflowValue(config.subject, "record_reference", [actionRecordTypeId])
          )
            nodeValuesValid = false;
        }
        if (node.type === "format_value" && !compatibleWorkflowValue(config.input, "json"))
          nodeValuesValid = false;
        if (node.type === "attach_file" || node.type === "move_file") {
          const targetField = allFields.get(String(config.fieldId));
          const ownerRecordTypeId = fieldRecordTypes.get(String(config.fieldId));
          if (
            !ownerRecordTypeId ||
            targetField?.type !== "attachment" ||
            !compatibleWorkflowValue(config.record, "record_reference", [ownerRecordTypeId]) ||
            !compatibleWorkflowValue(config.file, "file_reference")
          )
            nodeValuesValid = false;
        }
        if (node.type === "start_workflow") {
          const child = workflows.get(String(config.workflowId));
          const childTrigger = child ? object(child.trigger) : undefined;
          if (
            !child ||
            childTrigger?.kind !== "workflow" ||
            childTrigger.workflowId !== workflow.workflowId
          )
            nodeValuesValid = false;
        }
        if (
          node.type === "acknowledge_message" &&
          (trigger.kind !== "incoming_message" ||
            incomingTriggerContracts.length !== 1 ||
            String(incomingTriggerContracts[0]?.message.key) !== String(config.messageKey))
        )
          nodeValuesValid = false;
        if (!nodeValuesValid)
          failures.push(
            workflowFailure("vortex.definition.workflow_node_values", "scope_conflict"),
          );
        let nodeReferencesValid = true;
        walkValues(config, (entry) => {
          for (const [key, candidate] of Object.entries(entry)) {
            if (key === "recordTypeId" && !records.has(String(candidate)))
              nodeReferencesValid = false;
            if ((key === "fieldId" || key.endsWith("FieldId")) && !allFields.has(String(candidate)))
              nodeReferencesValid = false;
            if (
              (key === "relationshipId" || key === "relationshipIds") &&
              (Array.isArray(candidate)
                ? candidate.some((id) => !allRelationships.has(String(id)))
                : !allRelationships.has(String(candidate)))
            )
              nodeReferencesValid = false;
            if (key === "pageId" && !pages.has(String(candidate))) nodeReferencesValid = false;
            if (key === "queryId" && !queries.has(String(candidate))) nodeReferencesValid = false;
            if (key === "connectionBindingId" && !connectionBindings.has(String(candidate)))
              nodeReferencesValid = false;
          }
        });
        if (
          node.type === "wait_until" &&
          (!triggerRecordId ||
            fieldRecordTypes.get(String(config.dateTimeFieldId)) !== triggerRecordId ||
            allFields.get(String(config.dateTimeFieldId))?.type !== "date_time")
        )
          nodeReferencesValid = false;
        if (
          (node.type === "attach_file" || node.type === "move_file") &&
          allFields.get(String(config.fieldId))?.type !== "attachment"
        )
          nodeReferencesValid = false;
        if (
          node.type === "request_form" &&
          !["form", "guided_form"].includes(String(pages.get(String(config.pageId))?.type))
        )
          nodeReferencesValid = false;
        if (node.type === "request_form") {
          const outputs = array(config.outputs);
          const keys = outputs.map((entry) => String(entry.key));
          if (new Set(keys).size !== keys.length) nodeReferencesValid = false;
        }
        if (node.type === "create_record" || node.type === "change_record") {
          const target = records.get(String(config.recordTypeId));
          const targetFields = new Set(
            target ? array(target.fields).map((field) => String(field.fieldId)) : [],
          );
          if (Object.keys(object(config.values)).some((fieldId) => !targetFields.has(fieldId)))
            nodeReferencesValid = false;
        }
        if (
          node.type === "set_values" &&
          Object.keys(object(config.values)).some((fieldId) => !allFields.has(fieldId))
        )
          nodeReferencesValid = false;
        if (!nodeReferencesValid)
          failures.push(
            workflowFailure("vortex.definition.workflow_node_references", "broken_reference"),
          );
        if (node.type === "request_form" && !permissions.has(String(config.responderPermissionKey)))
          failures.push(
            workflowFailure("vortex.definition.workflow_permission", "broken_reference"),
          );
        if (node.type === "run_action") {
          const action = actions.get(String(config.actionKey));
          const actionPair = moduleActionValuePairs.get(String(config.actionKey));
          const inputs = object(config.inputs);
          const declared = action ? array(action.inputs) : [];
          if (
            !action ||
            Object.keys(inputs).some((key) => !declared.some((input) => input.key === key)) ||
            declared.some((input) => input.required === true && !(String(input.key) in inputs)) ||
            declared.some((input) => {
              if (!(String(input.key) in inputs)) return false;
              const allowedRecordTypeIds = input.recordTypes
                ? array(input.recordTypes).map((reference) =>
                    String(object(reference).recordTypeId),
                  )
                : [];
              return !applicationWorkflowInputCompatible(
                object(inputs[String(input.key)]),
                input,
                actionPair?.moduleV2 ?? false,
                allFields,
                fieldValuePairs,
                workflowNodes,
                queries,
                triggerRecordId,
                allowedRecordTypeIds.length > 0 ? allowedRecordTypeIds : undefined,
                triggerInputsByKey,
              );
            })
          )
            failures.push(
              workflowFailure("vortex.definition.workflow_action_inputs", "broken_reference"),
            );
        }
        if (node.type === "call_connection") {
          const binding = connectionBindings.get(String(config.connectionBindingId));
          const connection = binding
            ? connectionMap.get(String(binding.connectionTypeId))
            : undefined;
          const operation = connection
            ? array(connection.operations).find((entry) => entry.key === config.operationKey)
            : undefined;
          const shape =
            connection && operation
              ? array(connection.shapes).find((entry) => entry.key === operation.inputShapeKey)
              : undefined;
          const inputs = object(config.inputs);
          const fields = shape ? array(shape.fields) : [];
          if (
            !binding ||
            !operation ||
            !shape ||
            !(binding.requiredOperationKeys as string[]).includes(String(config.operationKey)) ||
            Object.keys(inputs).some((key) => !fields.some((field) => field.key === key)) ||
            fields.some((field) => field.required === true && !(String(field.key) in inputs)) ||
            fields.some(
              (field) =>
                String(field.key) in inputs &&
                !applicationWorkflowInputCompatible(
                  object(inputs[String(field.key)]),
                  field,
                  false,
                  allFields,
                  fieldValuePairs,
                  workflowNodes,
                  queries,
                  triggerRecordId,
                  undefined,
                  triggerInputsByKey,
                ),
            )
          )
            failures.push(
              workflowFailure("vortex.definition.workflow_connection_inputs", "broken_reference"),
            );
        }
      }
    }
    const childGraph = new Map<string, string[]>();
    for (const workflow of workflows.values()) {
      const children: string[] = [];
      for (const node of array(workflow.nodes))
        if (node.type === "start_workflow") children.push(String(object(node.config).workflowId));
      childGraph.set(String(workflow.workflowId), children);
    }
    const childVisiting = new Set<string>();
    const childVisited = new Set<string>();
    const visitChild = (id: string, depth: number, maximumDepth: number) => {
      if (childVisiting.has(id)) {
        failures.push(
          failure(output, "vortex.definition.workflow_child_acyclic", "dependency_cycle"),
        );
        return;
      }
      if (depth > maximumDepth)
        failures.push(failure(output, "vortex.definition.workflow_child_depth", "scope_conflict"));
      if (childVisited.has(id)) return;
      childVisiting.add(id);
      for (const child of childGraph.get(id) ?? []) {
        if (!workflows.has(child))
          failures.push(
            failure(output, "vortex.definition.workflow_child_reference", "broken_reference"),
          );
        else visitChild(child, depth + 1, maximumDepth);
      }
      childVisiting.delete(id);
      childVisited.add(id);
    };
    for (const workflow of workflows.values())
      visitChild(String(workflow.workflowId), 1, Number(workflow.maximumNestingDepth));
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
  "vortex.definition.module_rule_references",
  "vortex.definition.module_event_references",
  "vortex.definition.module_extension_references",
  "vortex.definition.module_sharing_condition",
] as const;
const applicationRuleCodes = [
  "vortex.definition.application_identity_unique",
  "vortex.definition.application_dependency_manifest",
  "vortex.definition.application_module_bindings",
  "vortex.definition.application_action_references",
  "vortex.definition.application_event_references",
  "vortex.definition.application_rule_references",
  "vortex.definition.application_home_page",
  "vortex.definition.application_role_references",
  "vortex.definition.application_navigation_references",
  "vortex.definition.application_query_references",
  "vortex.definition.application_page_permission",
  "vortex.definition.application_page_query",
  "vortex.definition.application_page_references",
  "vortex.definition.application_calendar_mapping",
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
    if (!history) {
      failures.push(
        failure(output, "vortex.definition.prior_published_version_required", "required_value"),
      );
      continue;
    }
    try {
      const result =
        output.kind === "module" && history.kind === "module"
          ? compareDefinitionVersionImpact({
              kind: "module",
              ...("validationContractVersion" in output
                ? { validationContractVersion: "2.0.0" as const }
                : {}),
              history: history.history,
              candidate: output.canonical,
            })
          : output.kind === "application" && history.kind === "application"
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
    (!publishesVersionedDefinition || context.publishedHistories !== undefined)
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
    if (item === "prior_published_version") return context.publishedHistories !== undefined;
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
  const failures: DefinitionRuleFailure[] = [];
  for (const rule of eligibleRules) failures.push(...rule.run(context));
  const safeLocationKey = (location: DefinitionValidationLocation | undefined) =>
    location
      ? JSON.stringify([
          location.documentKind,
          location.documentKey,
          location.segments.map((segment) => [segment.kind, segment.key]),
        ])
      : "";
  const unique = new Map(
    failures.map((entry) => [
      `${entry.ruleCode}\0${entry.family}\0${safeLocationKey(entry.location)}`,
      entry,
    ]),
  );
  const familyOrder = [
    "required_value",
    "invalid_value",
    "unsupported_choice",
    "unknown_property",
    "too_few_items",
    "too_many_items",
    "duplicate_key",
    "broken_reference",
    "unresolved_reference",
    "scope_conflict",
    "incompatible_version",
    "dependency_cycle",
    "unsafe_content",
    "incompatible_change",
    "validation_failed",
  ];
  const sorted = [...unique.values()].sort((left, right) => {
    const locationComparison = compareCanonicalStrings(
      safeLocationKey(left.location),
      safeLocationKey(right.location),
    );
    if (locationComparison !== 0) return locationComparison;
    const familyComparison = familyOrder.indexOf(left.family) - familyOrder.indexOf(right.family);
    if (familyComparison !== 0) return familyComparison;
    return compareCanonicalStrings(left.ruleCode, right.ruleCode);
  });
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
  sourceRecordFields: readonly FieldDefinition[],
): boolean {
  const candidate = object(input);
  let result: boolean;
  try {
    result = evaluateTypedCondition({
      condition: candidate.condition as ConditionNode,
      sourceRecordFields,
      declaredFieldIds: candidate.declaredFieldIds as string[],
      parameterDeclarations: candidate.parameters as TypedConditionParameterDeclaration[],
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
  if (!savedSharingConditionSchema.safeParse(input).success)
    throw new DefinitionCompilationError(
      "vortex.definition.sharing_condition_input_refused",
      "scope_conflict",
    );
  return result;
}

export function evaluateSavedSharingConditionV2(
  input: unknown,
  fieldValues: Readonly<Record<string, unknown>>,
  parameters: Readonly<Record<string, unknown>>,
  sourceRecordFields: readonly ModuleFieldV2[],
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
  if (!savedSharingConditionV2Schema.safeParse(input).success)
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
    if (isV2ModuleSource(source)) return moduleCompilationRequestV2Schema.safeParse(input);
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
  const compilePublicationRequest = compileDefinitionWithContext as (
    request: PublicationCompilationRequest,
    context: { dependencyOutputs: readonly Output[] },
  ) => Output;
  for (const request of ordered)
    outputs.push(
      compilePublicationRequest(request, {
        dependencyOutputs: [...dependencyOutputs, ...outputs],
      }),
    );
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
