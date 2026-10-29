import { flowRuntimeValueOf } from "../rules/flow-runtime-value";
import type { JsonValue } from "../catalogue/common";
import type { DefinitionValidationLocation } from "../catalogue/validation-errors";
import {
  flowReadFieldsProjectionSchema,
  flowReadFieldsScalarTypeSchema,
  flowSchema,
  type FlowDefinition,
  type FlowReadFieldsScalarType,
} from "../workflows/flow-contracts";
import {
  compiledFlowSetSchema,
  type CompiledFlowSet,
  type SourceFlow,
  type SourceFlowTask,
} from "../workflows/flow-source-contracts";
import { flowTaskRegistry, type FlowTaskTypeKey } from "../workflows/flow-task-registry";
import type { FlowValue } from "../workflows/flow-values";
import { compileFlowPlans, FlowPlanError } from "../workflows/flow-plan";
import type { FlowFormTypes } from "../workflows/flow-form-types";
import type { DefinitionProvenanceEntry } from "./definition-provenance";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json-definition";
import {
  DefinitionCompilationError,
  type DefinitionCompilerRefusalCode,
} from "./compilation-error";
import {
  flowIssueLocation,
  validateFlow,
  validateFlowSet,
  type FlowValidationOptions,
} from "./flow-validation";

/**
 * Compiles the flows one module or application owns from readable aliases to permanent
 * identities. The function is pure and deterministic: the same source, resolver and
 * declared dependencies always give the same canonical flows. BeforeSave flows retain source
 * order for equal priorities; other flows use ascending permanent identity.
 *
 * Every alias resolves through the resolver, which the definition compiler backs with the
 * existing resolution snapshot; nothing is generated here. An alias that does not resolve, a task
 * type or version the task registry does not know, a task that cannot run where its flow runs, and
 * a reference to a definition that is not a declared dependency are all refused, never dropped.
 *
 * Release evidence appears once. The result lists each other definition the flows reach in one
 * dependency manifest contribution; no flow, task or reference carries a release, version or
 * fingerprint. `flow-validation.ts` checks every flow's structure,
 * run locations, typed references, outputs and error handling before it is resolved, and the
 * resolved set's calls between flows after; the first issue is refused with its located node.
 */

type Path = (string | number)[];

export type ResolvedFlowIdentity = Readonly<{
  /** The permanent identity from the resolution snapshot. */
  identifier: string;
  /** The definition that owns it: the compiled definition itself or one of its dependencies. */
  definitionKey: string;
}>;

/** Authoritative field facts from the compiled definition and its declared dependencies. */
export type ResolvedFlowFieldMetadata = Readonly<{
  identifier: string;
  recordTypeId: string;
  type: string;
  valueType?: string;
}>;

/** Maps canonical Module field discriminators to the scalar types a Flow may expose. */
export const flowReadFieldsScalarTypeForField = (
  fieldType: string,
): FlowReadFieldsScalarType | undefined => {
  const direct = flowReadFieldsScalarTypeSchema.safeParse(fieldType);
  // Module money and formatted-text values are structured objects, while the Flow scalar
  // evaluator accepts decimal text and a string respectively. Neither can be projected as-is.
  if (direct.success && fieldType !== "money" && fieldType !== "formatted_text") return direct.data;
  switch (fieldType) {
    case "long_text":
    case "reference_number":
    case "email_address":
    case "phone_number":
    case "web_address":
      return "text";
    default:
      return undefined;
  }
};

/**
 * How aliases become permanent identities. Each method throws the compiler's refusal when the
 * alias is missing or ambiguous. Record types are written `key` or `definition.key:key`; a field
 * or relationship is written `<record type reference>.<alias>` and receives the two halves
 * already split.
 */
export type FlowCompilationResolver = Readonly<{
  /** The compiled definition's key. Its flows' canonical namespace is derived from it. */
  definitionKey: string;
  flow: (alias: string) => ResolvedFlowIdentity;
  recordType: (reference: string) => ResolvedFlowIdentity;
  field: (recordTypeReference: string, alias: string) => ResolvedFlowIdentity;
  /** All authoritative records for a permanent field identity; zero or many are invalid. */
  fieldMetadata: (fieldId: string) => readonly ResolvedFlowFieldMetadata[];
  /** Fields from one exact declared Module dependency selected by the source binding. */
  dependencyFieldMetadata: (
    definitionKey: string,
    fieldId: string,
  ) => readonly ResolvedFlowFieldMetadata[];
  relationship: (recordTypeReference: string, alias: string) => ResolvedFlowIdentity;
  action: (alias: string) => ResolvedFlowIdentity;
  permission: (alias: string) => ResolvedFlowIdentity;
  query: (alias: string) => ResolvedFlowIdentity;
  page: (alias: string) => ResolvedFlowIdentity;
  form: (alias: string) => ResolvedFlowIdentity;
  /** A page placement the flow addresses, such as the panel it opens. */
  placement: (alias: string) => ResolvedFlowIdentity;
  connectionBinding: (alias: string) => ResolvedFlowIdentity;
  executionBinding: (alias: string) => ResolvedFlowIdentity;
  /** Places a refusal on the flow, when the caller can. */
  locate?: (flowKey: string) => DefinitionValidationLocation | undefined;
}>;

export type FlowCompilationInput = Readonly<{
  flows: readonly SourceFlow[];
  /** The authored flows before shorthand references and defaults are parsed. */
  rawFlows?: readonly unknown[];
  resolver: FlowCompilationResolver;
  /** The definition keys this definition declares as dependencies; a flow may reach only these. */
  declaredDefinitionKeys: readonly string[];
  /** The declared inputs of each operation a Call protected operation task may name, by its key. */
  operationInputs: NonNullable<FlowValidationOptions["operationInputs"]>;
  formTitle?: FlowValidationOptions["formTitle"];
  referenceEnvironments?:
    ((flow: SourceFlow) => FlowValidationOptions["referenceEnvironments"]) | undefined;
}>;

type Refusal = ConstructorParameters<typeof DefinitionCompilationError>[1];

const resolutionRule = "vortex.definition.immutable_resolution";
const transformRule = "vortex.definition.semantic_transform";
const systemRule = "vortex.definition.system_metadata";
const defaultRule = "vortex.definition.fixed_execution_default";

type Context = {
  readonly resolver: FlowCompilationResolver;
  readonly location: DefinitionValidationLocation | undefined;
  /** The definitions this definition declares as dependencies. */
  readonly declared: ReadonlySet<string>;
  /** Definitions other than the compiled one that these flows reach. */
  readonly reached: Set<string>;
  /** Whether the flow runs inside a save transaction. */
  readonly transaction: boolean;
  /** Canonical paths whose value, or whose key, is a resolved identity, with their source path. */
  readonly resolved: { canonicalPath: Path; sourcePath: Path }[];
  /** The one record type every record trigger of the flow names, when they agree. */
  readonly triggerRecordType: string | undefined;
  readonly rawSource: unknown;
};

const refusal = (
  ctx: Pick<Context, "location">,
  code: DefinitionCompilerRefusalCode,
  family: Refusal,
): DefinitionCompilationError => new DefinitionCompilationError(code, family, ctx.location);

/** Records a resolved identity and returns the permanent value to store in its place. */
const resolveAt = (
  ctx: Context,
  identity: ResolvedFlowIdentity,
  path: Path,
  sourcePath: Path = path,
): string => {
  if (identity.definitionKey !== ctx.resolver.definitionKey) {
    if (!ctx.declared.has(identity.definitionKey))
      throw refusal(ctx, "vortex.definition.missing_definition", "unresolved_reference");
    ctx.reached.add(identity.definitionKey);
  }
  ctx.resolved.push({ canonicalPath: path, sourcePath });
  return identity.identifier;
};

/** Resolve form references in a validated value or formula without inspecting literal data. */
export function resolveFlowFormReferences<Value>(
  value: Value,
  resolve: (form: string, path: Path) => string,
  path: Path = [],
): Value {
  const walk = (candidate: unknown, current: Path): unknown => {
    if (Array.isArray(candidate))
      return candidate.map((entry, index) => walk(entry, [...current, index]));
    if (typeof candidate !== "object" || candidate === null) return candidate;
    const record = candidate as Record<string, unknown>;
    if (record.kind === "literal" || record.op === "literal") return candidate;
    if (
      (record.kind === "reference" || record.op === "reference") &&
      typeof record.reference === "object" &&
      record.reference !== null &&
      !Array.isArray(record.reference)
    ) {
      const reference = record.reference as Record<string, unknown>;
      if (reference.source === "form" && typeof reference.form === "string")
        return {
          ...record,
          reference: {
            ...reference,
            form: resolve(reference.form, [...current, "reference", "form"]),
          },
        };
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        record.op === "deadline_passed" && key === "terminalStatusValues"
          ? entry
          : walk(entry, [...current, key]),
      ]),
    );
  };
  return walk(value, path) as Value;
}

const resolveFormReferences = <Value>(ctx: Context, value: Value, path: Path): Value =>
  resolveFlowFormReferences(
    value,
    (form, referencePath) => {
      let sourcePath = referencePath;
      while (sourcePath.length > 0 && !valueAt(ctx.rawSource, sourcePath).found)
        sourcePath = sourcePath.slice(0, -1);
      return resolveAt(ctx, ctx.resolver.form(form), referencePath, sourcePath);
    },
    path,
  );

/** `definition.key:record.member` or `record.member`; the member never contains a dot. */
const splitMemberReference = (ctx: Context, text: string): { record: string; member: string } => {
  const dot = text.indexOf(".", text.indexOf(":") + 1);
  if (dot < 1 || dot === text.length - 1)
    throw refusal(ctx, "vortex.definition.invalid_record_type_reference", "broken_reference");
  return { record: text.slice(0, dot), member: text.slice(dot + 1) };
};

const resolveRecordTypeIds = (
  ctx: Context,
  aliases: readonly string[] | undefined,
  path: Path,
): string[] | undefined =>
  aliases?.map((alias, index) =>
    resolveAt(ctx, ctx.resolver.recordType(alias), [...path, "recordTypeIds", index]),
  );

const withRecordTypes = <T extends { recordTypeIds?: readonly string[] | undefined }>(
  ctx: Context,
  declaration: T,
  path: Path,
): Record<string, unknown> => {
  const recordTypeIds = resolveRecordTypeIds(ctx, declaration.recordTypeIds, path);
  return recordTypeIds ? { ...declaration, recordTypeIds } : { ...declaration };
};

const resolveDeclarations = <T extends { recordTypeIds?: readonly string[] | undefined }>(
  ctx: Context,
  declarations: Readonly<Record<string, T>>,
  path: Path,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(declarations).map(([name, declaration]) => [
      name,
      withRecordTypes(ctx, declaration, [...path, name]),
    ]),
  );

const resolveTriggers = (ctx: Context, source: SourceFlow): unknown[] =>
  source.triggers.map((trigger, index) => {
    const path: Path = ["triggers", index];
    const inputs = resolveDeclarations(ctx, trigger.inputs, [...path, "inputs"]);
    if (trigger.type === "BeforeSave") {
      const recordType = ctx.resolver.recordType(trigger.recordTypeId);
      // A save reads the BeforeSave flows of the record type's own Module release, so a flow of
      // another Module could never run.
      if (recordType.definitionKey !== ctx.resolver.definitionKey)
        throw refusal(ctx, "vortex.definition.workflow_node_references", "invalid_value");
      return {
        ...trigger,
        inputs,
        recordTypeId: resolveAt(ctx, recordType, [...path, "recordTypeId"]),
      };
    }
    if (trigger.type === "Event")
      return {
        ...trigger,
        inputs,
        recordTypeId: resolveAt(ctx, ctx.resolver.recordType(trigger.recordTypeId), [
          ...path,
          "recordTypeId",
        ]),
      };
    throw refusal(ctx, "vortex.definition.unsupported_workflow_trigger", "unsupported_choice");
  });

/**
 * The record type a field-values property is written against: the task's own record type or,
 * for a task that changes only the record being saved in a save transaction, the record type
 * every record trigger of the flow names. Nothing else is inferred, so values for any other
 * record must name their record type.
 */
const fieldValuesRecordType = (
  ctx: Context,
  properties: Readonly<Record<string, FlowValue>>,
  savedRecord: boolean,
): string => {
  const named = properties.record_type;
  if (named !== undefined) return aliasOf(ctx, named);
  if (savedRecord && ctx.transaction && ctx.triggerRecordType !== undefined)
    return ctx.triggerRecordType;
  throw refusal(ctx, "vortex.definition.trigger_record_required", "required_value");
};

const aliasOf = (ctx: Context, value: FlowValue): string => {
  if (
    value.kind === "literal" &&
    value.literal.type === "text" &&
    typeof value.literal.value === "string"
  )
    return value.literal.value;
  throw refusal(ctx, "vortex.definition.workflow_node_values", "invalid_value");
};

const identityLiteral = (identifier: string): FlowValue => ({
  kind: "literal",
  literal: { type: "text", value: identifier },
});

const resolveProperty = (
  ctx: Context,
  type: string,
  value: FlowValue,
  properties: Readonly<Record<string, FlowValue>>,
  savedRecord: boolean,
  path: Path,
): FlowValue => {
  const identity = (resolve: (alias: string) => ResolvedFlowIdentity) =>
    identityLiteral(resolveAt(ctx, resolve(aliasOf(ctx, value)), [...path, "literal", "value"]));
  const member = (resolve: (record: string, alias: string) => ResolvedFlowIdentity) => {
    const { record, member: alias } = splitMemberReference(ctx, aliasOf(ctx, value));
    return identityLiteral(resolveAt(ctx, resolve(record, alias), [...path, "literal", "value"]));
  };
  switch (type) {
    case "record_type_id":
      return identity((alias) => ctx.resolver.recordType(alias));
    case "form_id":
      return identity((alias) => ctx.resolver.form(alias));
    case "placement_id":
      return identity((alias) => ctx.resolver.placement(alias));
    case "query_id":
      return identity((alias) => ctx.resolver.query(alias));
    case "page_id":
      return identity((alias) => ctx.resolver.page(alias));
    case "connection_binding_id":
      return identity((alias) => ctx.resolver.connectionBinding(alias));
    case "flow_id":
      return identity((alias) => ctx.resolver.flow(alias));
    case "field_id":
      if (ctx.transaction && ctx.triggerRecordType !== undefined) {
        const { record } = splitMemberReference(ctx, aliasOf(ctx, value));
        if (
          ctx.resolver.recordType(record).identifier !==
          ctx.resolver.recordType(ctx.triggerRecordType).identifier
        )
          throw refusal(ctx, "vortex.definition.workflow_node_references", "broken_reference");
      }
      return member((record, alias) => ctx.resolver.field(record, alias));
    case "relationship_id":
      return member((record, alias) => ctx.resolver.relationship(record, alias));
    case "field_values": {
      // Field values are written one way: a whole set (a reference or a formula that yields the
      // field values, such as a form's answers), or a map of field keys whose every entry is a
      // flow value of its own (a fixed value, an input, a variable, an earlier step's output).
      // Every map key must be a field of the task's record type; the run names fields by these
      // keys. A literal JSON set and an array are refused: neither is a field map.
      if (value.kind === "literal" || value.kind === "array")
        throw refusal(ctx, "vortex.definition.workflow_node_values", "invalid_value");
      if (value.kind !== "map") return value;
      const record = fieldValuesRecordType(ctx, properties, savedRecord);
      for (const alias of Object.keys(value.entries)) ctx.resolver.field(record, alias);
      return value;
    }
    case "record_change_list":
      // A literal change list names record types and fields that have no declared shape to
      // resolve here, so it is refused rather than kept with readable aliases. Constructed maps
      // and arrays are refused too: neither proves canonical record and field identities.
      if (value.kind === "literal" || value.kind === "map" || value.kind === "array")
        throw refusal(ctx, "vortex.definition.workflow_node_values", "invalid_value");
      return value;
    default:
      // Generic values retain their complete shape, including bounded paths on task-output refs.
      return value;
  }
};

const resolveTaskList = (ctx: Context, tasks: readonly SourceFlowTask[], path: Path): unknown[] =>
  tasks.map((task, index) => resolveTask(ctx, task, [...path, index]));

const resolveReadFieldsTask = (
  ctx: Context,
  task: Extract<SourceFlowTask, { properties: unknown }>,
  path: Path,
): unknown => {
  const node = task as typeof task & {
    properties: Readonly<Record<string, FlowValue>>;
  };
  const recordTypeValue = node.properties.record_type;
  const recordValue = node.properties.record;
  const fieldsValue = node.properties.fields;
  if (recordTypeValue === undefined || recordValue === undefined || fieldsValue === undefined)
    throw refusal(ctx, "vortex.definition.workflow_node_values", "required_value");

  const recordTypeReference = aliasOf(ctx, recordTypeValue);
  const recordType = ctx.resolver.recordType(recordTypeReference);
  if (recordType.definitionKey === ctx.resolver.definitionKey)
    throw refusal(ctx, "vortex.definition.application_dependency_manifest", "broken_reference");
  const recordTypeId = resolveAt(ctx, recordType, [
    ...path,
    "properties",
    "record_type",
    "literal",
    "value",
  ]);
  const recordPath = [...path, "properties", "record"];
  const record = resolveFormReferences(
    ctx,
    resolveProperty(ctx, "record_reference", recordValue, node.properties, false, recordPath),
    recordPath,
  );
  if (fieldsValue.kind !== "literal" || fieldsValue.literal.type !== "json")
    throw refusal(ctx, "vortex.definition.workflow_node_values", "invalid_value");
  const projection = flowReadFieldsProjectionSchema.safeParse(fieldsValue.literal.value);
  if (!projection.success)
    throw refusal(ctx, "vortex.definition.workflow_node_values", "invalid_value");

  const selectedFieldIds = new Set<string>();
  const typeEntries: [string, FlowReadFieldsScalarType][] = [];
  const fields = projection.data.map((entry, index) => {
    const { record: fieldRecordReference, member: fieldAlias } = splitMemberReference(
      ctx,
      entry.field,
    );
    const fieldRecord = ctx.resolver.recordType(fieldRecordReference);
    if (
      fieldRecord.identifier !== recordType.identifier ||
      fieldRecord.definitionKey !== recordType.definitionKey
    )
      throw refusal(ctx, "vortex.definition.workflow_node_references", "broken_reference");
    const field = ctx.resolver.field(fieldRecordReference, fieldAlias);
    if (field.definitionKey !== recordType.definitionKey)
      throw refusal(ctx, "vortex.definition.workflow_node_references", "broken_reference");
    const matches = ctx.resolver.dependencyFieldMetadata(
      recordType.definitionKey,
      field.identifier,
    );
    if (matches.length === 0)
      throw refusal(ctx, "vortex.definition.workflow_node_references", "broken_reference");
    if (matches.length !== 1)
      throw refusal(ctx, "vortex.definition.ambiguous_identity", "unresolved_reference");
    const metadata = matches[0]!;
    if (metadata.identifier !== field.identifier || metadata.recordTypeId !== recordType.identifier)
      throw refusal(ctx, "vortex.definition.workflow_node_references", "broken_reference");
    if (selectedFieldIds.has(field.identifier))
      throw refusal(ctx, "vortex.definition.duplicate_identity_resolution", "duplicate_key");
    selectedFieldIds.add(field.identifier);
    const scalarType = flowReadFieldsScalarTypeForField(metadata.type);
    if (scalarType === undefined)
      throw refusal(ctx, "vortex.definition.unsupported_field_type", "unsupported_choice");
    typeEntries.push([entry.alias, scalarType]);
    const fieldPath: Path = [...path, "properties", "fields", "literal", "value", index, "field"];
    const fieldId = resolveAt(ctx, field, fieldPath);
    // The compiler-owned scalar type is resolved from the same exact field identity, so its
    // provenance points back to the selected source field rather than appearing as a default.
    ctx.resolved.push({
      canonicalPath: [...path, "readFieldTypes", entry.alias],
      sourcePath: fieldPath,
    });
    return {
      ...entry,
      field: fieldId,
    };
  });

  return {
    ...node,
    properties: {
      ...node.properties,
      record_type: identityLiteral(recordTypeId),
      record,
      fields: {
        kind: "literal",
        literal: { type: "json", value: fields as unknown as JsonValue },
      },
    },
    readFieldTypes: Object.fromEntries(typeEntries),
  };
};

const resolveTask = (ctx: Context, task: SourceFlowTask, path: Path): unknown => {
  switch (task.type) {
    case "if": {
      const node = task as Extract<SourceFlowTask, { type: "if" }>;
      return {
        ...node,
        condition: resolveFormReferences(ctx, node.condition, [...path, "condition"]),
        then: resolveTaskList(ctx, node.then, [...path, "then"]),
        ...(node.else ? { else: resolveTaskList(ctx, node.else, [...path, "else"]) } : {}),
      };
    }
    case "switch": {
      const node = task as Extract<SourceFlowTask, { type: "switch" }>;
      return {
        ...node,
        value: resolveFormReferences(ctx, node.value, [...path, "value"]),
        cases: node.cases.map((entry, index) => ({
          ...entry,
          tasks: resolveTaskList(ctx, entry.tasks, [...path, "cases", index, "tasks"]),
        })),
        ...(node.default
          ? { default: resolveTaskList(ctx, node.default, [...path, "default"]) }
          : {}),
      };
    }
    case "for_each": {
      const node = task as Extract<SourceFlowTask, { type: "for_each" }>;
      return {
        ...node,
        items: resolveFormReferences(ctx, node.items, [...path, "items"]),
        tasks: resolveTaskList(ctx, node.tasks, [...path, "tasks"]),
      };
    }
    case "sequential": {
      const node = task as Extract<SourceFlowTask, { tasks: SourceFlowTask[] }>;
      return { ...node, tasks: resolveTaskList(ctx, node.tasks, [...path, "tasks"]) };
    }
    case "run_flow": {
      const node = task as Extract<SourceFlowTask, { type: "run_flow" }>;
      return {
        ...node,
        flowId: resolveAt(ctx, ctx.resolver.flow(node.flowId), [...path, "flowId"]),
        inputs: Object.fromEntries(
          Object.entries(node.inputs).map(([name, value]) => [
            name,
            resolveFormReferences(ctx, value, [...path, "inputs", name]),
          ]),
        ),
      };
    }
    case "stop":
      return task;
    default: {
      const node = task as Extract<SourceFlowTask, { properties: unknown }>;
      const definition = Object.hasOwn(flowTaskRegistry, node.type)
        ? flowTaskRegistry[node.type as FlowTaskTypeKey]
        : undefined;
      if (definition === undefined)
        throw refusal(ctx, "vortex.definition.unsupported_workflow_node", "unsupported_choice");
      if (node.type === "record.read_fields") return resolveReadFieldsTask(ctx, node, path);
      const properties: Record<string, FlowValue> = {};
      for (const [name, value] of Object.entries(node.properties)) {
        const declared = Object.hasOwn(definition.properties, name)
          ? definition.properties[name]
          : undefined;
        if (declared === undefined)
          throw refusal(ctx, "vortex.definition.workflow_node_values", "unknown_property");
        const propertyPath = [...path, "properties", name];
        properties[name] = resolveFormReferences(
          ctx,
          resolveProperty(
            ctx,
            declared.type,
            value,
            node.properties,
            definition.transactionScope === "saved_record",
            propertyPath,
          ),
          propertyPath,
        );
      }
      return { ...node, properties };
    }
  }
};

// ─── Provenance ──────────────────────────────────────────────────────────────────────────────

const leafPaths = (value: unknown, path: Path = []): Path[] => {
  if (Array.isArray(value))
    return value.flatMap((entry, index) => leafPaths(entry, [...path, index]));
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([key, entry]) => leafPaths(entry, [...path, key]));
  return [path];
};

const valueAt = (value: unknown, path: Path): { found: boolean; value?: unknown } => {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment))
      return { found: false };
    current = (current as Record<string | number, unknown>)[segment];
  }
  return { found: true, value: current };
};

const startsWith = (path: Path, prefix: Path): boolean =>
  prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);

const flowProvenance = (
  canonical: FlowDefinition,
  source: unknown,
  resolved: Context["resolved"],
  canonicalIndex: number,
  sourceIndex: number,
): DefinitionProvenanceEntry[] =>
  leafPaths(canonical).map((path): DefinitionProvenanceEntry => {
    const canonicalPath = [canonicalIndex, ...path];
    // A resolved identity is the value at the path, or the key an alias was written under.
    const resolution = resolved
      .filter((entry) => startsWith(path, entry.canonicalPath))
      .sort((left, right) => right.canonicalPath.length - left.canonicalPath.length)[0];
    if (resolution !== undefined)
      return {
        canonicalPath,
        origin: "resolved",
        sourcePath: [
          sourceIndex,
          ...resolution.sourcePath,
          ...path.slice(resolution.canonicalPath.length),
        ],
        ruleCode: resolutionRule,
      };
    if (path.length === 1 && path[0] === "namespace")
      return { canonicalPath, origin: "system_metadata", ruleCode: systemRule };
    const sourceValue = valueAt(source, path);
    if (!sourceValue.found)
      return { canonicalPath, origin: "fixed_default", ruleCode: defaultRule };
    const canonicalValue = valueAt(canonical, path).value;
    return {
      canonicalPath,
      origin: "source",
      sourcePath: [sourceIndex, ...path],
      ...(canonicalJson(sourceValue.value) !== canonicalJson(canonicalValue)
        ? { ruleCode: transformRule }
        : {}),
    };
  });

// ─── Entry point ───────────────────────────────────────────────────────────────────────────────

/**
 * The record types a flow's record can be: those its record triggers name or, for an interactive
 * flow, the one its record input names.
 */
const flowRecordTypes = (source: SourceFlow): string[] => [
  ...source.triggers.flatMap((trigger) =>
    trigger.type === "BeforeSave" || trigger.type === "Event" ? [trigger.recordTypeId] : [],
  ),
  ...(source.recordInput === undefined
    ? []
    : (source.inputs[source.recordInput]?.recordTypeIds ?? [])),
];

const triggerRecordType = (source: SourceFlow): string | undefined => {
  const aliases = new Set(flowRecordTypes(source));
  return aliases.size === 1 ? [...aliases][0] : undefined;
};

/** A binding's page scope, keyed by permanent placement identities. */
export type CompiledFlowBindingEnvironment = Readonly<{
  page: string;
  controls: readonly string[];
  forms: FlowFormTypes;
}>;

export function compileFlowSources(input: FlowCompilationInput): CompiledFlowSet & {
  formTypes: ReadonlyMap<string, FlowFormTypes>;
  bindingEnvironments: ReadonlyMap<string, readonly CompiledFlowBindingEnvironment[]>;
} {
  const { resolver } = input;
  const declared = new Set(input.declaredDefinitionKeys);
  const reached = new Set<string>();
  const compiled: {
    flow: FlowDefinition;
    sourceIndex: number;
    resolved: Context["resolved"];
  }[] = [];

  // A Run flow target is one of these flows, found by its permanent identity however it is written.
  const ownFlows = new Map(input.flows.map((flow) => [resolver.flow(flow.id).identifier, flow]));
  const targetFlow = (reference: string): SourceFlow | undefined => {
    const identity = resolver.flow(reference);
    return identity.definitionKey === resolver.definitionKey
      ? ownFlows.get(identity.identifier)
      : undefined;
  };

  input.flows.forEach((source, sourceIndex) => {
    const location = resolver.locate?.(source.key);
    const ctx: Context = {
      resolver,
      location,
      declared,
      reached,
      transaction: source.execution === "transaction",
      resolved: [],
      triggerRecordType: triggerRecordType(source),
      rawSource: input.rawFlows?.[sourceIndex] ?? source,
    };

    // Structure, run locations, typed references, outputs and error handling, in one pass. Run
    // flow is checked against its target's declared inputs and outputs, and a trigger record
    // field must exist on every record type the flow's record triggers name.
    const recordTypes = flowRecordTypes(source);
    const bindings = input.referenceEnvironments?.(source);
    const contexts =
      bindings !== undefined && bindings.length > 0
        ? bindings.map((binding) => [binding])
        : [bindings];
    const issues = contexts.flatMap((referenceEnvironments) =>
      validateFlow(source, {
        targetFlow,
        formTitle: input.formTitle,
        referenceEnvironments,
        operationInputs: input.operationInputs,
        triggerRecordFieldExists: (field) =>
          recordTypes.every((recordType) => {
            try {
              resolver.field(recordType, field);
              return true;
            } catch (error) {
              if (error instanceof DefinitionCompilationError) return false;
              throw error;
            }
          }),
        triggerRecordFieldType: (field) => {
          const types = recordTypes.map((recordType) => {
            try {
              const identity = resolver.field(recordType, field);
              const matches = resolver.fieldMetadata(identity.identifier);
              return matches.length === 1
                ? flowRuntimeValueOf(matches[0]!.type, null, matches[0]!.valueType).type
                : undefined;
            } catch (error) {
              if (error instanceof DefinitionCompilationError) return undefined;
              throw error;
            }
          });
          return types.length > 0 && types.every((type) => type === types[0])
            ? types[0]
            : undefined;
        },
      }),
    );
    const invalid =
      issues.find((issue) => issue.ruleCode !== "vortex.definition.unsupported_workflow_node") ??
      issues[0];
    if (invalid !== undefined)
      throw new DefinitionCompilationError(
        invalid.ruleCode,
        invalid.family,
        flowIssueLocation(location, invalid),
        undefined,
        invalid.message,
      );

    // The flow's readable key must name the same permanent flow as its owner alias.
    const flowIdentity = resolver.flow(source.id);
    if (
      flowIdentity.definitionKey !== resolver.definitionKey ||
      resolver.flow(source.key).identifier !== flowIdentity.identifier
    )
      throw refusal(ctx, "vortex.definition.ambiguous_identity", "unresolved_reference");
    ctx.resolved.push({ canonicalPath: ["id"], sourcePath: ["id"] });

    const resolvedFlow = {
      ...source,
      id: flowIdentity.identifier,
      namespace: resolver.definitionKey,
      runAs: source.runAs,
      ...(source.invocationPermissionId !== undefined
        ? {
            invocationPermissionId: resolveAt(
              ctx,
              resolver.permission(source.invocationPermissionId),
              ["invocationPermissionId"],
            ),
          }
        : {}),
      inputs: resolveDeclarations(ctx, source.inputs, ["inputs"]),
      variables: resolveDeclarations(ctx, source.variables, ["variables"]),
      triggers: resolveTriggers(ctx, source),
      tasks: resolveTaskList(ctx, source.tasks, ["tasks"]),
      outputs: Object.fromEntries(
        Object.entries(source.outputs).map(([name, declaration]) => [
          name,
          {
            ...withRecordTypes(ctx, declaration, ["outputs", name]),
            value: resolveFormReferences(ctx, declaration.value, ["outputs", name, "value"]),
          },
        ]),
      ),
      errors: resolveTaskList(ctx, source.errors, ["errors"]),
      finally: resolveTaskList(ctx, source.finally, ["finally"]),
    };
    const parsed = flowSchema.safeParse(resolvedFlow);
    if (!parsed.success)
      throw refusal(ctx, "vortex.definition.invalid_compilation_output", "invalid_value");
    compiled.push({
      flow: parsed.data,
      sourceIndex,
      resolved: ctx.resolved,
    });
  });

  // BeforeSave flows first, in source order (each record type's rule list orders its own); every
  // other flow in permanent identity order.
  compiled.sort((left, right) => {
    const leftRule = left.flow.triggers.some((trigger) => trigger.type === "BeforeSave");
    const rightRule = right.flow.triggers.some((trigger) => trigger.type === "BeforeSave");
    if (leftRule && rightRule) return left.sourceIndex - right.sourceIndex;
    if (leftRule || rightRule) return leftRule ? -1 : 1;
    return compareCanonicalStrings(left.flow.id, right.flow.id);
  });
  const compiledFlowsById = new Map<string, FlowDefinition>(
    compiled.map(({ flow }) => [flow.id, flow]),
  );
  for (const entry of compiled) {
    // Source validation sees readable projection aliases. Revalidate the canonical task map so
    // output paths acquire the compiler-resolved member types before publication.
    const bindings = input.referenceEnvironments?.(input.flows[entry.sourceIndex]!);
    const contexts =
      bindings !== undefined && bindings.length > 0
        ? bindings.map((binding) => [
            {
              ...binding,
              forms: Object.fromEntries(
                Object.entries(binding.forms).map(([alias, fields]) => [
                  resolver.form(alias).identifier,
                  fields,
                ]),
              ),
            },
          ])
        : [bindings];
    const invalid = contexts.flatMap((referenceEnvironments) =>
      validateFlow(entry.flow, {
        targetFlow: (reference) => compiledFlowsById.get(reference),
        operationInputs: input.operationInputs,
        referenceEnvironments,
      }),
    )[0];
    if (invalid !== undefined)
      throw new DefinitionCompilationError(
        invalid.ruleCode,
        invalid.family,
        flowIssueLocation(resolver.locate?.(input.flows[entry.sourceIndex]!.key), invalid),
        undefined,
        invalid.message,
      );
  }
  // Calls between the flows: no cycle, a bounded depth, and transaction flows calling only their own kind.
  const called = validateFlowSet(compiled.map(({ flow }) => flow))[0];
  if (called !== undefined) {
    const caller = compiled.find(({ flow }) => flow.id === called.flowId);
    throw new DefinitionCompilationError(
      called.ruleCode,
      called.family,
      caller === undefined ? undefined : resolver.locate?.(input.flows[caller.sourceIndex]!.key),
    );
  }
  // Publication compiles the plan the runtime builds, and refuses a flow it cannot plan, naming
  // the step. The plan itself is never stored.
  let formTypes: ReadonlyMap<string, FlowFormTypes>;
  const bindingEnvironments = new Map<string, CompiledFlowBindingEnvironment[]>();
  try {
    formTypes = new Map(
      compiled.map(({ flow, sourceIndex }) => {
        const forms: Record<string, Record<string, string>> = {};
        for (const environment of input.referenceEnvironments?.(input.flows[sourceIndex]!) ?? []) {
          const canonicalForms: Record<string, Record<string, string>> = {};
          for (const [alias, fields] of Object.entries(environment.forms)) {
            const identity = resolver.form(alias).identifier;
            const known = (forms[identity] ??= {});
            canonicalForms[identity] = { ...fields };
            for (const [field, type] of Object.entries(fields)) {
              if (known[field] !== undefined && known[field] !== type)
                throw new FlowPlanError(
                  flow.id,
                  undefined,
                  `form ${alias} has inconsistent field types`,
                );
              known[field] = type;
            }
          }
          const held = bindingEnvironments.get(String(flow.id)) ?? [];
          held.push({
            page: environment.page,
            controls: (environment.controls ?? []).map(
              (alias) => resolver.placement(alias).identifier,
            ),
            forms: canonicalForms,
          });
          bindingEnvironments.set(String(flow.id), held);
        }
        return [String(flow.id), forms] as const;
      }),
    );
    compileFlowPlans(
      compiled.map(({ flow }) => flow),
      new Map(),
      formTypes,
    );
  } catch (error) {
    if (!(error instanceof FlowPlanError)) throw error;
    const planned = compiled.find(({ flow }) => flow.id === error.flowId);
    throw new DefinitionCompilationError(
      "vortex.definition.unsupported_workflow_node",
      "unsupported_choice",
      planned === undefined ? undefined : resolver.locate?.(input.flows[planned.sourceIndex]!.key),
      undefined,
      error.reason,
    );
  }
  const provenance = compiled.flatMap(({ flow, sourceIndex, resolved }, canonicalIndex) =>
    flowProvenance(
      flow,
      input.rawFlows?.[sourceIndex] ?? input.flows[sourceIndex]!,
      resolved,
      canonicalIndex,
      sourceIndex,
    ),
  );
  const result = compiledFlowSetSchema.safeParse({
    flows: compiled.map(({ flow }) => flow),
    dependencyManifest: { definitionKeys: [...reached].sort(compareCanonicalStrings) },
    provenance,
  });
  if (!result.success)
    throw new DefinitionCompilationError(
      "vortex.definition.invalid_compilation_output",
      "invalid_value",
    );
  return { ...result.data, formTypes, bindingEnvironments };
}
