import "server-only";

import {
  containedComponentIdSchema,
  eventIdSchema,
  readRecordsTableContract,
  recordIdSchema,
  recordsTableActionCapabilities,
  recordTypeIdSchema,
  revisionSchema,
  valueTypesCompatible,
  type ComponentFlowBinding,
  type ComponentSemanticEventKind,
  type ComponentSettingValue,
  type FlowDefinition,
  type FlowInputDeclaration,
  type ModuleQueryDefinitionV3,
} from "@vortex/contracts";
import { z } from "zod";
import {
  requireInstalledRuntimeContext,
  type InstalledRuntimeContext,
} from "./installed-runtime-context";

/**
 * Resolves a component's page, related-record, row or selection context into the exact typed
 * inputs a bound flow and its bound query declare (issue #583).
 *
 * The split this module enforces is the one the specification states in the data-context section:
 * a component event supplies only what the surface itself owns, while record identity, revision
 * and capability context come from the trusted page projection and the Query engine, never from
 * the browser. A caller input that the bound flow declares as a record reference is therefore
 * filled only from the trusted context, and a supplied browser value can never stand in for it.
 *
 * The resolver is pure and total: every failure is the explicit `mismatch` result with a stable
 * code, so the event dispatch layer (#584) can refuse or reload instead of running a half-filled
 * flow. Event dispatch, result freshness and presentation remain outside this module.
 */

/** The one closed context vocabulary a component can carry into a bound flow. */
export const componentRecordReferenceSchema = z
  .object({
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema,
    /** Exact revision the identity was read at, so a write flow can detect a stale context. */
    revision: revisionSchema,
    /** The row operations the current viewer may run on this record; never caller-supplied. */
    capabilities: z.array(z.enum(recordsTableActionCapabilities)).max(3),
  })
  .strict();
export type ComponentRecordReference = z.infer<typeof componentRecordReferenceSchema>;

export const componentRecordSelectionSchema = z
  .object({
    recordTypeId: recordTypeIdSchema,
    members: z.array(componentRecordReferenceSchema).max(500),
  })
  .strict();
export type ComponentRecordSelection = z.infer<typeof componentRecordSelectionSchema>;

/**
 * The trusted component context. `page_subject` is the page's own record; `related_record` is an
 * explicitly declared related record reached from the page, so a related panel resolves to its own
 * record and never silently falls back to the page subject; `current_row` and `current_selection`
 * are the interaction contexts a repeatable data block supplies.
 */
export const componentContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page_subject"), record: componentRecordReferenceSchema }).strict(),
  z
    .object({
      kind: z.literal("related_record"),
      relationshipId: containedComponentIdSchema,
      record: componentRecordReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("current_row"),
      controlId: containedComponentIdSchema,
      record: componentRecordReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("current_selection"),
      controlId: containedComponentIdSchema,
      selection: componentRecordSelectionSchema,
    })
    .strict(),
]);
export type ComponentContext = z.infer<typeof componentContextSchema>;

export const componentContextMismatchCodes = [
  "invalid_context",
  "invalid_request",
  "unknown_binding",
  "unknown_flow",
  "unknown_input",
  "unresolved_authored_value",
  "unexpected_event_context",
  "untrusted_identity_input",
  "incompatible_input_type",
  "missing_required_input",
  "supplied_input_not_declared",
  "unknown_query",
  "unknown_query_input",
  "incompatible_query_input_type",
  "missing_query_input",
  "ambiguous_query_context_input",
] as const;
export type ComponentContextMismatchCode = (typeof componentContextMismatchCodes)[number];

export type ComponentContextMismatch = Readonly<{
  kind: "mismatch";
  code: ComponentContextMismatchCode;
  /** The offending input name, identity or record type, when the resolver knows it. */
  field?: string;
}>;

export const componentFlowInputRequestSchema = z
  .object({
    controlId: containedComponentIdSchema,
    eventId: eventIdSchema,
    context: componentContextSchema,
    /** The values the untrusted surface supplies, by the caller input name they fill. */
    suppliedValues: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type ComponentFlowInputRequest = z.input<typeof componentFlowInputRequestSchema>;

export type ResolvedComponentFlowInputs = Readonly<{
  kind: "resolved";
  flowId: string;
  /** The authoritative context the record inputs were resolved from. */
  context: ComponentContext;
  inputs: Readonly<Record<string, unknown>>;
}>;

export type ComponentFlowInputsResolution = ResolvedComponentFlowInputs | ComponentContextMismatch;

/** One data placement's bound query plus the settings that declare its query parameters. */
export type ComponentPlacement = Readonly<{
  queryId: string;
  settings: Readonly<Record<string, ComponentSettingValue>>;
}>;

export type ResolvedComponentQueryInputs = Readonly<{
  kind: "resolved";
  moduleRootId: string;
  queryId: string;
  inputValues: Readonly<Record<string, unknown>>;
}>;

export type ComponentQueryInputsResolution =
  | ResolvedComponentQueryInputs
  | ComponentContextMismatch;

const maximumSuppliedCharacters = 65_536;

const mismatch = (
  code: ComponentContextMismatchCode,
  field?: string,
): ComponentContextMismatch =>
  field === undefined ? { kind: "mismatch", code } : { kind: "mismatch", code, field };

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** Value types that name or grant authority. A surface may never supply these itself. */
const untrustedIdentityTypes: ReadonlySet<string> = new Set([
  "record_reference",
  "record_reference_list",
  "organization_account_reference",
  "workflow_run_reference",
  "relationship_reference",
  "relationship_reference_list",
]);

/** The event kinds whose declared context is the clicked or edited row. */
const rowContextEvents: ReadonlySet<ComponentSemanticEventKind> = new Set([
  "row_clicked",
  "row_action",
  "inline_edit",
]);

/** The event kinds whose declared context is the current selection. */
const selectionContextEvents: ReadonlySet<ComponentSemanticEventKind> = new Set([
  "bulk_action",
  "selection_changed",
]);

/**
 * Whether the supplied context kind is the one the bound event declares. A row event carries the
 * current row; a bulk or selection event carries the current selection; every other data or action
 * event carries the page subject or one of its declared related records.
 */
const contextMatchesEvent = (event: ComponentSemanticEventKind, context: ComponentContext): boolean => {
  if (rowContextEvents.has(event)) return context.kind === "current_row";
  if (selectionContextEvents.has(event)) return context.kind === "current_selection";
  return context.kind === "page_subject" || context.kind === "related_record";
};

const contextRecordTypeId = (context: ComponentContext): string =>
  context.kind === "current_selection" ? context.selection.recordTypeId : context.record.recordTypeId;

const singleContextRecord = (
  context: ComponentContext,
): ComponentRecordReference | undefined =>
  context.kind === "current_selection" ? undefined : context.record;

const recordTypeAllowed = (
  declaration: FlowInputDeclaration,
  recordTypeId: string,
): boolean =>
  declaration.recordTypeIds === undefined ||
  declaration.recordTypeIds.some((allowed) => sameId(allowed, recordTypeId));

/** The catalogue type of a JSON value a surface supplied, when it can be known. */
const jsonValueType = (value: unknown): string | undefined => {
  if (value === null) return "json";
  if (typeof value === "string") return "text";
  if (typeof value === "boolean") return "yes_no";
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? "whole_number" : "decimal_number";
  if (Array.isArray(value))
    return value.every((entry) => typeof entry === "string") ? "several_choices" : "json";
  if (typeof value === "object") return "json";
  return undefined;
};

/** Whether a surface-supplied value is one the declared flow input type can hold. */
const suppliedValueFits = (value: unknown, declaredType: string): boolean => {
  switch (declaredType) {
    case "choice":
      return typeof value === "string" && value.length > 0;
    case "several_choices":
      return (
        Array.isArray(value) &&
        value.every((entry) => typeof entry === "string" && entry.length > 0)
      );
    case "json":
      return true;
    default: {
      const actual = jsonValueType(value);
      return (
        actual !== undefined &&
        (valueTypesCompatible(actual, declaredType, "value") ||
          (actual === "json" && declaredType === "several_choices"))
      );
    }
  }
};

/** Whether a browser-supplied value for a named context field is well formed and bounded. */
const withinSupplied = (value: unknown): boolean => {
  try {
    return (JSON.stringify(value) ?? "").length <= maximumSuppliedCharacters;
  } catch {
    return false;
  }
};

type CallerInputResolution =
  | Readonly<{ kind: "value"; value: unknown }>
  | Readonly<{ kind: "omitted" }>
  | Readonly<{ kind: "mismatch"; code: ComponentContextMismatchCode }>;

/**
 * Resolves one declared caller input. Record references and the named context fields (revision,
 * record type and capabilities) come only from the trusted context; every other input may take the
 * surface's value, type-checked against the flow's own declaration.
 */
const resolveCallerInput = (
  flowInputName: string,
  callerName: string,
  declaration: FlowInputDeclaration,
  context: ComponentContext,
  suppliedValues: Readonly<Record<string, unknown>>,
): CallerInputResolution => {
  const single = singleContextRecord(context);

  if (declaration.type === "record_reference") {
    if (single === undefined) return { kind: "mismatch", code: "unexpected_event_context" };
    if (!recordTypeAllowed(declaration, single.recordTypeId))
      return { kind: "mismatch", code: "incompatible_input_type" };
    return { kind: "value", value: single.recordId };
  }
  if (declaration.type === "record_reference_list") {
    if (context.kind !== "current_selection")
      return { kind: "mismatch", code: "unexpected_event_context" };
    if (!recordTypeAllowed(declaration, context.selection.recordTypeId))
      return { kind: "mismatch", code: "incompatible_input_type" };
    return { kind: "value", value: context.selection.members.map((member) => member.recordId) };
  }

  if (flowInputName === "revision") {
    if (single === undefined) return { kind: "mismatch", code: "unexpected_event_context" };
    if (declaration.type !== "whole_number")
      return { kind: "mismatch", code: "incompatible_input_type" };
    return { kind: "value", value: single.revision };
  }
  if (flowInputName === "record_type_id") {
    if (declaration.type !== "text") return { kind: "mismatch", code: "incompatible_input_type" };
    return { kind: "value", value: contextRecordTypeId(context) };
  }
  if (flowInputName === "capabilities") {
    if (single === undefined) return { kind: "mismatch", code: "unexpected_event_context" };
    if (declaration.type !== "several_choices" && declaration.type !== "json")
      return { kind: "mismatch", code: "incompatible_input_type" };
    return { kind: "value", value: [...single.capabilities] };
  }

  if (untrustedIdentityTypes.has(declaration.type))
    return { kind: "mismatch", code: "untrusted_identity_input" };

  if (Object.hasOwn(suppliedValues, callerName)) {
    const supplied = suppliedValues[callerName];
    if (!suppliedValueFits(supplied, declaration.type))
      return { kind: "mismatch", code: "incompatible_input_type" };
    return { kind: "value", value: supplied };
  }
  if (declaration.required) return { kind: "mismatch", code: "missing_required_input" };
  if (declaration.default !== undefined) return { kind: "value", value: declaration.default };
  return { kind: "omitted" };
};

const flowById = (
  installed: InstalledRuntimeContext,
  flowId: string,
): FlowDefinition | undefined =>
  installed.releaseSet.application.content.flows.find((flow) => sameId(String(flow.id), flowId));

const bindingFor = (
  installed: InstalledRuntimeContext,
  controlId: string,
  eventId: string,
): ComponentFlowBinding | undefined =>
  installed.releaseSet.application.content.flowBindings.find(
    (binding) => sameId(String(binding.controlId), controlId) && sameId(String(binding.eventId), eventId),
  );

/**
 * Resolves the exact typed inputs of the flow bound to one component event. Only the caller inputs
 * the binding declares are considered; a supplied value the binding does not declare, a wrong
 * context for the event, a wrong record type or value type, and an authored reference or formula
 * that only the browser could evaluate all return an explicit mismatch.
 */
export function resolveComponentFlowInputs(
  installedCandidate: InstalledRuntimeContext,
  requestCandidate: ComponentFlowInputRequest,
): ComponentFlowInputsResolution {
  let installed: InstalledRuntimeContext;
  try {
    installed = requireInstalledRuntimeContext(installedCandidate);
  } catch {
    return mismatch("invalid_context");
  }

  const request = componentFlowInputRequestSchema.safeParse(requestCandidate);
  if (!request.success) return mismatch("invalid_request");
  const { controlId, eventId, context, suppliedValues } = request.data;

  const binding = bindingFor(installed, controlId, eventId);
  if (binding === undefined) return mismatch("unknown_binding");
  if (!contextMatchesEvent(binding.event, context)) return mismatch("unexpected_event_context");

  const flow = flowById(installed, String(binding.flow.flowId));
  if (flow === undefined) return mismatch("unknown_flow");

  const declaredCallerNames = new Set<string>();
  for (const value of Object.values(binding.flow.inputs))
    if (value.kind === "caller") declaredCallerNames.add(value.name);
  // A surface may fill only the caller inputs the binding declares.
  for (const name of Object.keys(suppliedValues))
    if (!declaredCallerNames.has(name)) return mismatch("supplied_input_not_declared", name);

  const inputs: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(binding.flow.inputs)) {
    if (value.kind === "literal") {
      inputs[name] = value.literal.value;
      continue;
    }
    if (value.kind !== "caller") return mismatch("unresolved_authored_value", name);
    const declaration = flow.inputs[name];
    if (declaration === undefined) return mismatch("unknown_input", name);
    if (!withinSupplied(suppliedValues[value.name]))
      return mismatch("incompatible_input_type", name);
    const resolved = resolveCallerInput(name, value.name, declaration, context, suppliedValues);
    if (resolved.kind === "mismatch") return mismatch(resolved.code, name);
    if (resolved.kind === "value") inputs[name] = resolved.value;
  }

  // A required input the binding never filled cannot start the flow.
  for (const [name, declaration] of Object.entries(flow.inputs))
    if (declaration.required && !Object.hasOwn(inputs, name))
      return mismatch("missing_required_input", name);

  return { kind: "resolved", flowId: String(flow.id), context, inputs };
}

type ModuleQueryMatch = Readonly<{ moduleRootId: string; query: ModuleQueryDefinitionV3 }>;

const findModuleQueries = (
  installed: InstalledRuntimeContext,
  queryId: string,
): ModuleQueryMatch[] => {
  const matches: ModuleQueryMatch[] = [];
  for (const module of installed.releaseSet.modules)
    for (const query of module.content.queries)
      if (sameId(String(query.queryId), queryId))
        matches.push({ moduleRootId: String(module.rootId), query });
  return matches;
};

/** Reads a parameter value typed to the query input it fills; a value the type cannot hold is dropped. */
const coerceQueryValue = (raw: unknown, declaredType: string): unknown => {
  if (typeof raw !== "string") return raw;
  if (declaredType === "number") {
    const value = Number(raw);
    return raw.trim() !== "" && Number.isFinite(value) ? value : undefined;
  }
  if (declaredType === "boolean") return raw === "true" ? true : raw === "false" ? false : undefined;
  return raw;
};

const queryValueFits = (value: unknown, declaredType: string): boolean =>
  suppliedValueFits(value, declaredType);

/**
 * Builds the exact published query input a data placement reads from. Each declared query input is
 * filled from the placement's own fixed or page parameters, or from the trusted context when it is
 * a record reference; a page parameter can never supply record identity, and a parameter that a
 * query does not declare, a wrong value type or a missing required input is an explicit mismatch.
 */
export function resolveComponentQueryInputs(
  installedCandidate: InstalledRuntimeContext,
  placement: ComponentPlacement,
  contextCandidate: ComponentContext,
  pageParameters: Readonly<Record<string, unknown>> = {},
): ComponentQueryInputsResolution {
  let installed: InstalledRuntimeContext;
  try {
    installed = requireInstalledRuntimeContext(installedCandidate);
  } catch {
    return mismatch("invalid_context");
  }

  const context = componentContextSchema.safeParse(contextCandidate);
  if (!context.success) return mismatch("invalid_context");

  const matches = findModuleQueries(installed, placement.queryId);
  if (matches.length === 0) return mismatch("unknown_query");
  if (matches.length > 1) return mismatch("ambiguous_query_context_input");
  const match = matches[0];
  if (match === undefined) return mismatch("unknown_query");
  const { moduleRootId, query } = match;

  const declared = new Map<string, ModuleQueryDefinitionV3["inputs"][number]>();
  for (const input of query.inputs) declared.set(input.key, input);

  const inputValues: Record<string, unknown> = {};
  const table = readRecordsTableContract(placement.settings);
  for (const parameter of table?.parameters ?? []) {
    const declaration = declared.get(parameter.input);
    if (declaration === undefined) return mismatch("unknown_query_input", parameter.input);
    if (untrustedIdentityTypes.has(declaration.type))
      return mismatch("untrusted_identity_input", parameter.input);
    const raw =
      parameter.source === "fixed"
        ? parameter.fixedValue
        : parameter.pageParameter === undefined
          ? undefined
          : pageParameters[parameter.pageParameter];
    if (raw === undefined) {
      if (declaration.required) return mismatch("missing_query_input", parameter.input);
      continue;
    }
    const value = coerceQueryValue(raw, declaration.type);
    if (value === undefined || !queryValueFits(value, declaration.type))
      return mismatch("incompatible_query_input_type", parameter.input);
    inputValues[parameter.input] = value;
  }

  // A record-reference input the placement's parameters leave open is filled only from the trusted
  // context, and only when the query declares exactly one such input, so the resolver never guesses.
  const openRecordInputs = query.inputs.filter(
    (input) => input.type === "record_reference" && !Object.hasOwn(inputValues, input.key),
  );
  const single = singleContextRecord(context.data);
  if (single !== undefined && openRecordInputs.length > 1)
    return mismatch("ambiguous_query_context_input");
  if (single !== undefined) {
    for (const input of openRecordInputs) {
      if (input.type !== "record_reference") continue;
      const accepts = input.recordTypes.some((allowed) => {
        if (allowed.state !== "resolved") return false;
        return (
          sameId(allowed.moduleRootId, moduleRootId) &&
          sameId(String(allowed.recordTypeId), single.recordTypeId)
        );
      });
      if (!accepts) return mismatch("incompatible_query_input_type", input.key);
      inputValues[input.key] = single.recordId;
    }
  }

  for (const input of query.inputs)
    if (
      input.required &&
      !Object.hasOwn(inputValues, input.key) &&
      input.type !== "record_reference"
    )
      return mismatch("missing_query_input", input.key);

  return { kind: "resolved", moduleRootId, queryId: String(query.queryId), inputValues };
}

/**
 * Binds one already-verified installed context, so a consumer resolves many component events
 * without passing the trusted context each time. A context this loader did not assemble is refused
 * when the resolver is created, never when a person has already clicked.
 */
export const createComponentContextResolver = (context: InstalledRuntimeContext) => {
  const verified = requireInstalledRuntimeContext(context);
  return Object.freeze({
    resolveFlowInputs: (request: ComponentFlowInputRequest) =>
      resolveComponentFlowInputs(verified, request),
    resolveQueryInputs: (
      placement: ComponentPlacement,
      componentContext: ComponentContext,
      pageParameters: Readonly<Record<string, unknown>> = {},
    ) => resolveComponentQueryInputs(verified, placement, componentContext, pageParameters),
  });
};

export type ComponentContextResolver = ReturnType<typeof createComponentContextResolver>;
