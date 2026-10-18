import { createHash } from "node:crypto";
import { z } from "zod";
import {
  builderKeySchema,
  fieldIdSchema,
  flowReadFieldsProjectionSchema,
  flowReadFieldsScalarTypeSchema,
  flowReadFieldsTypeMapSchema,
  flowTaskChildLists,
  isRecord,
  recordTypeIdSchema,
  type FlowDefinition,
  type FlowFieldCorrection,
  type FlowTask,
  type FlowValue,
  type JsonValue,
} from "../schema";
import { typedValueMatchesType } from "../rules/condition-types";
import type {
  FlowInterfaceIntent,
  FlowLibrary,
  FlowProtectedTaskCall,
  FlowRunState,
  FlowTaskOutcome,
} from "../rules/index";
import type {
  FlowRelease,
  FlowSelectedRecordReadProjection,
  SafeIntent,
} from "./flow-orchestrator-types";

const maximumPayloadCharacters = 65_536;

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * The command identity of one protected task's record change: stable for the run, task path and
 * iteration, so a replayed run reaches the same record receipt instead of writing again. Version
 * and variant bits are set so it is a strictly valid UUID.
 */
export const effectCommandId = (runId: string, taskPath: string, iteration: string): string => {
  const bytes = createHash("sha256")
    .update(["flow-task-command", runId.toLowerCase(), taskPath, iteration].join("|"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The task outcome of a protected record path's safe refusal code. */
export const dedupeFieldCorrections = (
  corrections: readonly FlowFieldCorrection[],
): readonly FlowFieldCorrection[] => [
  ...new Map(
    corrections.map((correction) => [`${correction.field}:${correction.code}`, correction]),
  ).values(),
];

export const refusalOutcome = (code: string): FlowTaskOutcome =>
  code === "conflict" ? "conflict" : code === "invalid_request" ? "validation" : "refused";

/**
 * The task outcome of a protected record path that returned no result: a request the person's own
 * access refused, or whose refusal was recorded, is refused; one that could not run is failed.
 */
export const requestOutcome = (kind: "unavailable" | "temporarily_unavailable"): FlowTaskOutcome =>
  kind === "unavailable" ? "refused" : "failed";

/** Tasks the platform cannot run on the server yet, and what each waits for. */
export const notYetAvailable: Readonly<Record<string, string>> = Object.freeze({
  // A named action's record tasks run in its transaction flow through the record port; an
  // interactive flow runs only Save record, through the record save port.
  "record.save": "the interactive record task port",
  "record.create": "the interactive record task port",
  "record.set_fields": "the interactive record task port",
  "record.link": "the interactive record task port",
  "record.delete": "the interactive record task port",
  "record.restore": "the interactive record task port",
  "record.changes": "the interactive record task port",
  "record.query": "the interactive record task port",
  "flow.run_background": "#666 committed start intents",
  "event.announce": "the server event writer task",
  "message.acknowledge": "the message trigger (#1133)",
  "file.export": "the server file export task",
  "connection.call": "the durable Kestra runner",
});

export const withinPayload = (candidate: unknown): boolean => {
  try {
    return (JSON.stringify(candidate) ?? "").length <= maximumPayloadCharacters;
  } catch (error) {
    // JSON.stringify rejects only cyclic and BigInt values; anything else is a real defect.
    if (error instanceof TypeError) return false;
    throw error;
  }
};

/** The flows one flow starts through Run flow, anywhere in its tasks, errors or finally lists. */
export const runFlowTargets = (flow: FlowDefinition): string[] => {
  const targets: string[] = [];
  const visit = (tasks: readonly FlowTask[]) => {
    for (const task of tasks) {
      if (task.type === "run_flow")
        targets.push((task as Extract<FlowTask, { type: "run_flow" }>).flowId);
      for (const child of flowTaskChildLists(task)) visit(child.tasks);
    }
  };
  visit(flow.tasks);
  visit(flow.errors);
  visit(flow.finally);
  return targets;
};

export const safeIntent = (intent: FlowInterfaceIntent): SafeIntent => ({
  kind: intent.kind,
  taskId: intent.taskId,
  properties: Object.fromEntries(
    Object.entries(intent.properties).map(([name, value]) => [name, value.value]),
  ),
});

/**
 * A declared sensitive output (for example a raw invitation secret) is returned once in the live
 * result but never persisted: the stored effect records only `<output>_issued: true` in its place,
 * so replaying the same run reports the same outcome without re-revealing the value.
 */
export const redactSensitiveOutputs = (
  outputs: Readonly<Record<string, JsonValue>>,
  sensitive: readonly string[],
): Record<string, JsonValue> => {
  if (sensitive.length === 0) return { ...outputs };
  const stored: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(outputs))
    if (!sensitive.includes(name)) stored[name] = value;
  for (const name of sensitive) if (Object.hasOwn(outputs, name)) stored[`${name}_issued`] = true;
  return stored;
};

/** The raw sensitive values of one result, as they appear inside serialized JSON. */
export const sensitiveValues = (
  outputs: Readonly<Record<string, JsonValue>>,
  sensitive: readonly string[],
): string[] =>
  sensitive
    .filter((name) => Object.hasOwn(outputs, name))
    .map((name) => {
      const value = outputs[name];
      const text = JSON.stringify(value) ?? "";
      return typeof value === "string" ? text.slice(1, -1) : text;
    })
    .filter((text) => text.length > 0);

/** Whether a candidate that is about to leave memory carries any held sensitive value. */
export const carriesSensitive = (candidate: unknown, sensitive: readonly string[]): boolean => {
  if (sensitive.length === 0) return false;
  let text: string;
  try {
    text = JSON.stringify(candidate) ?? "";
  } catch (error) {
    // JSON.stringify rejects only cyclic and BigInt values; anything else is a real defect.
    if (error instanceof TypeError) return true;
    throw error;
  }
  return sensitive.some((value) => text.includes(value));
};

const selectedRecordReadProjectionSchema = z
  .object({
    recordTypeId: recordTypeIdSchema,
    fields: z
      .array(
        z
          .object({
            alias: builderKeySchema,
            fieldId: fieldIdSchema,
            type: flowReadFieldsScalarTypeSchema,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine((projection, context) => {
    const aliases = new Set<string>();
    const fieldIds = new Set<string>();
    projection.fields.forEach((field, index) => {
      if (aliases.has(field.alias))
        context.addIssue({
          code: "custom",
          path: ["fields", index, "alias"],
          message: "Projection aliases must be unique",
        });
      aliases.add(field.alias);
      const normalizedFieldId = field.fieldId.toLowerCase();
      if (fieldIds.has(normalizedFieldId))
        context.addIssue({
          code: "custom",
          path: ["fields", index, "fieldId"],
          message: "Projection field IDs must be unique",
        });
      fieldIds.add(normalizedFieldId);
    });
  });

const findFlowTask = (flow: FlowDefinition, taskId: string): FlowTask | undefined => {
  const find = (tasks: readonly FlowTask[]): FlowTask | undefined => {
    for (const task of tasks) {
      if (task.id === taskId) return task;
      for (const child of flowTaskChildLists(task)) {
        const nested = find(child.tasks);
        if (nested !== undefined) return nested;
      }
    }
    return undefined;
  };
  return find([...flow.tasks, ...flow.errors, ...flow.finally]);
};

type CompiledSelectedRecordReadTask = FlowTask &
  Readonly<{
    type: "record.read_fields";
    version: string;
    properties: Readonly<Record<string, FlowValue>>;
    readFieldTypes?: Readonly<Record<string, string>>;
  }>;

/** Return every declared alias only when the protected reader returned the whole valid field map. */
export const aliasSelectedRecordValues = (
  projection: FlowSelectedRecordReadProjection,
  candidate: unknown,
): Record<string, JsonValue> | undefined => {
  if (!isRecord(candidate)) return undefined;
  const entries = Object.entries(candidate);
  if (entries.length !== projection.fields.length) return undefined;
  const valuesByFieldId = new Map<string, unknown>();
  for (const [fieldId, value] of entries) {
    if (!fieldIdSchema.safeParse(fieldId).success) return undefined;
    const normalizedFieldId = fieldId.toLowerCase();
    if (valuesByFieldId.has(normalizedFieldId)) return undefined;
    valuesByFieldId.set(normalizedFieldId, value);
  }

  const values: [string, JsonValue][] = [];
  for (const field of projection.fields) {
    const normalizedFieldId = field.fieldId.toLowerCase();
    if (!valuesByFieldId.has(normalizedFieldId)) return undefined;
    const value = valuesByFieldId.get(normalizedFieldId);
    if (!typedValueMatchesType(value, field.type, "flow")) return undefined;
    values.push([field.alias, value]);
  }
  return Object.fromEntries(values);
};

/** Locate and cross-check trusted projection metadata against the active compiled task. */
export const selectedRecordProjectionForTask = (
  release: FlowRelease,
  library: FlowLibrary,
  state: FlowRunState,
  call: FlowProtectedTaskCall,
): FlowSelectedRecordReadProjection | undefined => {
  if (call.taskType !== "record.read_fields") return undefined;
  const awaiting = state.awaiting;
  if (
    awaiting?.kind !== "protected_task" ||
    awaiting.taskId !== call.taskId ||
    awaiting.taskType !== call.taskType
  )
    return undefined;
  const activation = state.activations[state.activations.length - 1];
  if (activation === undefined) return undefined;
  const flow = library(activation.flowId);
  if (flow === undefined) return undefined;
  const task = findFlowTask(flow, call.taskId);
  if (task === undefined || task.type !== "record.read_fields") return undefined;
  const registered = task as CompiledSelectedRecordReadTask;
  if (registered.version !== call.taskVersion) return undefined;

  const projectionCandidate = release.selectedRecordReadProjections
    ?.get(flow.id)
    ?.get(registered.id);
  const projection = selectedRecordReadProjectionSchema.safeParse(projectionCandidate);
  if (!projection.success) return undefined;

  const recordType = registered.properties.record_type;
  if (recordType?.kind !== "literal" || recordType.literal.type !== "text") return undefined;
  const compiledRecordTypeId = recordTypeIdSchema.safeParse(recordType.literal.value);
  if (
    !compiledRecordTypeId.success ||
    compiledRecordTypeId.data.toLowerCase() !== projection.data.recordTypeId.toLowerCase()
  )
    return undefined;

  const fields = registered.properties.fields;
  if (fields?.kind !== "literal" || fields.literal.type !== "json") return undefined;
  const compiledFields = flowReadFieldsProjectionSchema.safeParse(fields.literal.value);
  const compiledTypes = flowReadFieldsTypeMapSchema.safeParse(registered.readFieldTypes);
  if (
    !compiledFields.success ||
    !compiledTypes.success ||
    compiledFields.data.length !== projection.data.fields.length
  )
    return undefined;

  const trustedFields = new Map(
    projection.data.fields.map((field) => [field.alias, field] as const),
  );
  if (trustedFields.size !== compiledFields.data.length) return undefined;
  for (const compiledField of compiledFields.data) {
    const trustedField = trustedFields.get(compiledField.alias);
    if (
      trustedField === undefined ||
      trustedField.fieldId.toLowerCase() !== compiledField.field.toLowerCase() ||
      trustedField.type !== compiledTypes.data[compiledField.alias]
    )
      return undefined;
  }
  return projection.data;
};
