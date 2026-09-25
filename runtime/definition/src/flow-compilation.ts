import {
  compiledFlowSetSchema,
  flowSchema,
  flowTaskRegistry,
  type CompiledFlowSet,
  type DefinitionProvenanceEntry,
  type DefinitionValidationLocation,
  type FlowDefinition,
  type FlowTaskTypeKey,
  type FlowValue,
  type JsonValue,
  type SourceFlow,
  type SourceFlowTask,
} from "@vortex/contracts";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json";
import {
  DefinitionCompilationError,
  type DefinitionCompilerRefusalCode,
} from "./compilation-error";
import { flowIssueLocation, validateFlow, validateFlowSet } from "./flow-validation";

/**
 * Compiles the flows one module or application owns from readable aliases to permanent
 * identities (issue #984). The function is pure and deterministic: the same source, resolver and
 * declared dependencies always give the same canonical flows, in ascending permanent flow
 * identity, so recompiling unchanged source gives an identical result.
 *
 * Every alias resolves through the resolver, which the definition compiler backs with the
 * existing resolution snapshot; nothing is generated here. An alias that does not resolve, a task
 * type or version the task registry does not know, a task that cannot run where its flow runs, and
 * a reference to a definition that is not a declared dependency are all refused, never dropped.
 *
 * Release evidence appears once. The result lists each other definition the flows reach in one
 * dependency manifest contribution; no flow, task or reference carries a release, version or
 * fingerprint. The one flow validator (`flow-validation.ts`, #985) checks every flow's structure,
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
  relationship: (recordTypeReference: string, alias: string) => ResolvedFlowIdentity;
  action: (alias: string) => ResolvedFlowIdentity;
  permission: (alias: string) => ResolvedFlowIdentity;
  query: (alias: string) => ResolvedFlowIdentity;
  page: (alias: string) => ResolvedFlowIdentity;
  form: (alias: string) => ResolvedFlowIdentity;
  connectionBinding: (alias: string) => ResolvedFlowIdentity;
  executionBinding: (alias: string) => ResolvedFlowIdentity;
  /** Places a refusal on the flow, when the caller can. */
  locate?: (flowKey: string) => DefinitionValidationLocation | undefined;
}>;

export type FlowCompilationInput = Readonly<{
  flows: readonly SourceFlow[];
  resolver: FlowCompilationResolver;
  /** The definition keys this definition declares as dependencies; a flow may reach only these. */
  declaredDefinitionKeys: readonly string[];
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

/** `definition.key:record.member` or `record.member`; the member never contains a dot. */
const splitMemberReference = (
  ctx: Context,
  text: string,
): { record: string; member: string } => {
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
    if (trigger.type === "BeforeSave")
      return {
        ...trigger,
        inputs,
        recordTypeId: resolveAt(ctx, ctx.resolver.recordType(trigger.recordTypeId), [
          ...path,
          "recordTypeId",
        ]),
        operations: trigger.operations.map((operation, operationIndex) =>
          operation.kind === "transition"
            ? {
                ...operation,
                actionId: resolveAt(ctx, ctx.resolver.action(operation.actionId), [
                  ...path,
                  "operations",
                  operationIndex,
                  "actionId",
                ]),
              }
            : operation,
        ),
      };
    if (trigger.type === "Event")
      return {
        ...trigger,
        inputs,
        recordTypeId: resolveAt(ctx, ctx.resolver.recordType(trigger.recordTypeId), [
          ...path,
          "recordTypeId",
        ]),
      };
    return { ...trigger, inputs };
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
    identityLiteral(
      resolveAt(ctx, resolve(aliasOf(ctx, value)), [...path, "literal", "value"]),
    );
  const member = (resolve: (record: string, alias: string) => ResolvedFlowIdentity) => {
    const { record, member: alias } = splitMemberReference(ctx, aliasOf(ctx, value));
    return identityLiteral(
      resolveAt(ctx, resolve(record, alias), [...path, "literal", "value"]),
    );
  };
  switch (type) {
    case "record_type_id":
      return identity((alias) => ctx.resolver.recordType(alias));
    case "form_id":
      return identity((alias) => ctx.resolver.form(alias));
    case "query_id":
      return identity((alias) => ctx.resolver.query(alias));
    case "page_id":
      return identity((alias) => ctx.resolver.page(alias));
    case "connection_binding_id":
      return identity((alias) => ctx.resolver.connectionBinding(alias));
    case "flow_id":
      return identity((alias) => ctx.resolver.flow(alias));
    case "field_id":
      return member((record, alias) => ctx.resolver.field(record, alias));
    case "relationship_id":
      return member((record, alias) => ctx.resolver.relationship(record, alias));
    case "field_values": {
      // A literal set of values names its fields by alias; a reference or formula names none.
      if (value.kind !== "literal") return value;
      const literal = value.literal.value;
      if (
        value.literal.type !== "json" ||
        literal === null ||
        typeof literal !== "object" ||
        Array.isArray(literal)
      )
        throw refusal(ctx, "vortex.definition.workflow_node_values", "invalid_value");
      const entries = Object.entries(literal);
      if (entries.length === 0) return value;
      const record = fieldValuesRecordType(ctx, properties, savedRecord);
      const resolved: Record<string, unknown> = {};
      for (const [alias, fieldValue] of entries) {
        const field = ctx.resolver.field(record, alias);
        const fieldId = resolveAt(
          ctx,
          field,
          [...path, "literal", "value", field.identifier],
          [...path, "literal", "value", alias],
        );
        if (Object.hasOwn(resolved, fieldId))
          throw refusal(ctx, "vortex.definition.duplicate_identity_resolution", "duplicate_key");
        resolved[fieldId] = fieldValue;
      }
      return { kind: "literal", literal: { type: "json", value: resolved as JsonValue } };
    }
    case "record_change_list":
      // A literal change list names record types and fields that have no declared shape to
      // resolve here, so it is refused rather than kept with readable aliases.
      if (value.kind === "literal")
        throw refusal(ctx, "vortex.definition.workflow_node_values", "invalid_value");
      return value;
    default:
      return value;
  }
};

const resolveTaskList = (
  ctx: Context,
  tasks: readonly SourceFlowTask[],
  path: Path,
): unknown[] => tasks.map((task, index) => resolveTask(ctx, task, [...path, index]));

const resolveTask = (ctx: Context, task: SourceFlowTask, path: Path): unknown => {
  switch (task.type) {
    case "if": {
      const node = task as Extract<SourceFlowTask, { type: "if" }>;
      return {
        ...node,
        then: resolveTaskList(ctx, node.then, [...path, "then"]),
        ...(node.else ? { else: resolveTaskList(ctx, node.else, [...path, "else"]) } : {}),
      };
    }
    case "switch": {
      const node = task as Extract<SourceFlowTask, { type: "switch" }>;
      return {
        ...node,
        cases: node.cases.map((entry, index) => ({
          ...entry,
          tasks: resolveTaskList(ctx, entry.tasks, [...path, "cases", index, "tasks"]),
        })),
        ...(node.default
          ? { default: resolveTaskList(ctx, node.default, [...path, "default"]) }
          : {}),
      };
    }
    case "for_each":
    case "sequential": {
      const node = task as Extract<SourceFlowTask, { tasks: SourceFlowTask[] }>;
      return { ...node, tasks: resolveTaskList(ctx, node.tasks, [...path, "tasks"]) };
    }
    case "parallel": {
      const node = task as Extract<SourceFlowTask, { type: "parallel" }>;
      return {
        ...node,
        branches: node.branches.map((branch, index) =>
          resolveTaskList(ctx, branch, [...path, "branches", index]),
        ),
      };
    }
    case "run_flow": {
      const node = task as Extract<SourceFlowTask, { type: "run_flow" }>;
      return {
        ...node,
        flowId: resolveAt(ctx, ctx.resolver.flow(node.flowId), [...path, "flowId"]),
      };
    }
    case "wait_for_person": {
      const node = task as Extract<SourceFlowTask, { type: "wait_for_person" }>;
      return {
        ...node,
        formId: resolveAt(ctx, ctx.resolver.form(node.formId), [...path, "formId"]),
      };
    }
    case "stop":
    case "wait_until":
      return task;
    default: {
      const node = task as Extract<SourceFlowTask, { properties: unknown }>;
      const definition = Object.hasOwn(flowTaskRegistry, node.type)
        ? flowTaskRegistry[node.type as FlowTaskTypeKey]
        : undefined;
      if (definition === undefined)
        throw refusal(ctx, "vortex.definition.unsupported_workflow_node", "unsupported_choice");
      const properties: Record<string, FlowValue> = {};
      for (const [name, value] of Object.entries(node.properties)) {
        const declared = Object.hasOwn(definition.properties, name)
          ? definition.properties[name]
          : undefined;
        if (declared === undefined)
          throw refusal(ctx, "vortex.definition.workflow_node_values", "unknown_property");
        properties[name] = resolveProperty(
          ctx,
          declared.type,
          value,
          node.properties,
          definition.transactionScope === "saved_record",
          [...path, "properties", name],
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
  source: SourceFlow,
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
    if (!sourceValue.found) return { canonicalPath, origin: "fixed_default", ruleCode: defaultRule };
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

const triggerRecordType = (source: SourceFlow): string | undefined => {
  const aliases = new Set(
    source.triggers.flatMap((trigger) =>
      trigger.type === "BeforeSave" || trigger.type === "Event" ? [trigger.recordTypeId] : [],
    ),
  );
  return aliases.size === 1 ? [...aliases][0] : undefined;
};

export function compileFlowSources(input: FlowCompilationInput): CompiledFlowSet {
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
    };

    // Structure, run locations, typed references, outputs and error handling, in one pass. Run
    // flow is checked against its target's declared inputs and outputs, and a trigger record
    // field must exist on every record type the flow's record triggers name.
    const recordTypes = source.triggers.flatMap((trigger) =>
      trigger.type === "BeforeSave" || trigger.type === "Event" ? [trigger.recordTypeId] : [],
    );
    const invalid = validateFlow(source, {
      targetFlow,
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
    })[0];
    if (invalid !== undefined)
      throw new DefinitionCompilationError(
        invalid.ruleCode,
        invalid.family,
        flowIssueLocation(location, invalid),
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
      runAs:
        source.runAs.kind === "specified_account" || source.runAs.kind === "system"
          ? {
              ...source.runAs,
              executionBindingId: resolveAt(
                ctx,
                resolver.executionBinding(source.runAs.executionBindingId),
                ["runAs", "executionBindingId"],
              ),
            }
          : source.runAs,
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
      outputs: resolveDeclarations(ctx, source.outputs, ["outputs"]),
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

  compiled.sort((left, right) => compareCanonicalStrings(left.flow.id, right.flow.id));
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
  const provenance = compiled.flatMap(({ flow, sourceIndex, resolved }, canonicalIndex) =>
    flowProvenance(flow, input.flows[sourceIndex]!, resolved, canonicalIndex, sourceIndex),
  );
  const result = compiledFlowSetSchema.safeParse({
    flows: compiled.map(({ flow }) => flow),
    dependencyManifest: { definitionKeys: [...reached].sort(compareCanonicalStrings) },
    provenance,
  });
  if (!result.success)
    throw new DefinitionCompilationError("vortex.definition.invalid_compilation_output", "invalid_value");
  return result.data;
}
