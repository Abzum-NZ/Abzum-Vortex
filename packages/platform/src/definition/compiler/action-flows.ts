import type { JsonValue } from "../../catalogue/common";
import {
  PLATFORM_SERVICE_OPERATIONS,
  type PlatformServiceOperationKey,
} from "../../catalogue/platform-service-operation-catalogue";
import {
  flowContractVersion,
  type FlowDefinition,
  type FlowInputDeclaration,
  type FlowTask,
} from "../../workflows/flow-contracts";
import type { FlowFormula, FlowReference, FlowValue } from "../../workflows/flow-values";
import { asObject, fail, type JsonObject } from "./shared";

/**
 * The task version every compiled named-action flow pins. The record service executes the
 * `transaction` flow inside its transaction; this flow is the compile-time home of the action's
 * behaviour
 * (architecture decision 1, 08 §Actions).
 */
const ACTION_FLOW_TASK_VERSION = "1.0.0" as const;

/** The flow value type of a compiled Module action input. */
function actionFlowInputType(inputType: string): FlowInputDeclaration["type"] {
  return inputType as FlowInputDeclaration["type"];
}

/** A text literal flow value, for identity, key and message properties. */
const flowTextValue = (value: string): FlowValue => ({
  kind: "literal",
  literal: { type: "text", value },
});

const flowReferenceValue = (reference: FlowReference): FlowValue => ({
  kind: "reference",
  reference,
});

/**
 * What an action value can read inside its compiled flow: the subject is the record the action
 * runs on, so its fields are `{{ trigger.record.<field> }}` reads and the whole subject is the
 * implicit typed `subjectInput` record input.
 */
type ActionFlowScope = Readonly<{
  subjectFieldKeyById: ReadonlyMap<string, string>;
  subjectInput: string;
}>;

const subjectFieldReference = (fieldId: unknown, scope: ActionFlowScope): FlowReference => {
  const field = scope.subjectFieldKeyById.get(String(fieldId));
  if (field === undefined) fail("vortex.definition.invalid_compilation_output", "invalid_value");
  return { source: "trigger_record", field };
};

/**
 * The `field_values` property of a compiled action's record task: the canonical action task already
 * carries its value map in the flow value grammar, keyed by permanent field identity, so it travels
 * as the one literal JSON a `field_values` property is: a map whose every entry is a flow value.
 */
const actionFlowFieldValues = (values: Readonly<Record<string, unknown>>): FlowValue => ({
  kind: "literal",
  literal: { type: "json", value: values as JsonValue },
});

/** One registered task of a compiled named-action flow, pinned to the registry task version. */
const actionFlowTask = (
  id: string,
  type: string,
  properties: Record<string, FlowValue>,
): FlowTask => ({ id, type, version: ACTION_FLOW_TASK_VERSION, properties });

/**
 * Lowers a compiled action precondition to the flow formula the one flow evaluator reads. A
 * subject field becomes a `trigger.record` read and an action parameter a declared input
 * reference, so the flow names no value as text.
 */
function actionPreconditionFormula(node: unknown, scope: ActionFlowScope): FlowFormula {
  const value = asObject(node);
  if (value.kind === "all" || value.kind === "any") {
    const children = (value.conditions as unknown[]).map((entry) =>
      actionPreconditionFormula(entry, scope),
    );
    if (children.length === 1) return children[0]!;
    return { op: value.kind === "all" ? "and" : "or", args: children };
  }
  if (value.kind === "not")
    return { op: "not", arg: actionPreconditionFormula(value.condition, scope) };
  const operand = (entry: unknown): FlowFormula => {
    const source = asObject(entry);
    if (source.source === "field")
      return { op: "reference", reference: subjectFieldReference(source.fieldId, scope) };
    if (source.source === "parameter")
      return { op: "reference", reference: { source: "input", name: String(source.key) } };
    return { op: "literal", type: "json", value: source.value as JsonValue };
  };
  const left = operand(value.left);
  const rightOperand = (): FlowFormula => operand(value.right);
  switch (String(value.operator)) {
    case "equals":
      return { op: "eq", left, right: rightOperand() };
    case "not_equals":
      return { op: "neq", left, right: rightOperand() };
    case "greater_than":
      return { op: "gt", left, right: rightOperand() };
    case "greater_than_or_equal":
      return { op: "gte", left, right: rightOperand() };
    case "less_than":
      return { op: "lt", left, right: rightOperand() };
    case "less_than_or_equal":
      return { op: "lte", left, right: rightOperand() };
    case "contains":
      return { op: "contains", left, right: rightOperand() };
    case "not_contains":
      return { op: "not", arg: { op: "contains", left, right: rightOperand() } };
    case "in":
    case "not_in": {
      const authored = asObject(value.right);
      const raw = authored.source === "value" ? authored.value : undefined;
      const options = Array.isArray(raw)
        ? raw.map((entry): FlowFormula => ({
            op: "literal",
            type: "json",
            value: entry as JsonValue,
          }))
        : [rightOperand()];
      const membership: FlowFormula = { op: "in", value: left, options };
      return String(value.operator) === "not_in" ? { op: "not", arg: membership } : membership;
    }
    case "is_empty":
      return { op: "is_empty", arg: left };
    case "is_not_empty":
      return { op: "is_not_empty", arg: left };
    default:
      return fail("vortex.definition.invalid_compilation_output", "invalid_value");
  }
}

/**
 * Compiles one Module named action to its `transaction` flow: the action's own permanent
 * identity, typed inputs (plus the implicit subject record input) and invocation permission. The
 * precondition becomes an If task whose otherwise branch refuses, as the action refuses, and the
 * ordered tasks become the registry record, event and change tasks.
 *
 * Placement: the registry lets `record.set_fields` and `event.announce` run in a transaction on
 * the record being saved, which for an action is its subject. It keeps `record.create`,
 * `record.changes` and `record.delete` out of transactions, because architecture decision 1 lets a
 * transaction flow change only the record being saved and every BeforeSave rule shares that run
 * location. A named action's other-record changes are one apply record changes call (decision
 * "Every record task calls one protected operation"), so the record service controls how the
 * registry admits those operations for action flows. Likewise the flow validator accepts
 * `trigger.record` reads only in a flow with a record trigger, while an action starts through its binding with its
 * subject as the record being saved. These flows are therefore not passed through the flow
 * validator yet; `flowSchema` still validates them.
 */
export function compileActionFlow(
  action: JsonObject,
  canonicalAction: JsonObject,
  flowKey: string,
  namespace: string,
  subjectFieldKeyById: ReadonlyMap<string, string>,
  invocationPermissionId: FlowDefinition["invocationPermissionId"],
): FlowDefinition {
  const actionInputs: Record<string, FlowInputDeclaration> = {};
  for (const input of canonicalAction.inputs as JsonObject[]) {
    const recordTypes = (input.recordTypes as JsonObject[] | undefined) ?? [];
    actionInputs[String(input.key)] = {
      type: actionFlowInputType(String(input.type)),
      required: input.required === true,
      ...(recordTypes.length > 0
        ? {
            recordTypeIds: recordTypes.map((entry) =>
              String(entry.recordTypeId),
            ) as FlowInputDeclaration["recordTypeIds"],
          }
        : {}),
    };
  }
  // The subject is `record`, as in the default Save flow, unless the action declares its own input
  // of that name.
  let subjectInput = "record";
  for (let suffix = 1; Object.hasOwn(actionInputs, subjectInput); suffix += 1)
    subjectInput = suffix === 1 ? "subject_record" : `subject_record_${suffix}`;
  const subjectRecordTypeId = String(canonicalAction.subjectRecordTypeId);
  const scope: ActionFlowScope = { subjectFieldKeyById, subjectInput };

  const actionTasks: FlowTask[] = (canonicalAction.tasks as JsonObject[]).map((task, taskIndex) => {
    const id = task.id === undefined ? `task_${taskIndex + 1}` : String(task.id);
    const properties = asObject(task.properties);
    switch (String(task.type)) {
      case "record.set_fields":
        return actionFlowTask(id, "record.set_fields", {
          values: actionFlowFieldValues(asObject(properties.values)),
        });
      case "record.create":
        return actionFlowTask(id, "record.create", {
          record_type: flowTextValue(String(asObject(properties.recordType).recordTypeId)),
          values: actionFlowFieldValues(asObject(properties.values)),
        });
      case "record.changes":
        return actionFlowTask(id, "record.changes", {
          changes: {
            kind: "literal",
            literal: {
              type: "json",
              value: (properties.changes as JsonObject[]).map(
                (change) =>
                  ({
                    kind: "copy_relationships",
                    relationshipIds: change.relationshipIds as JsonValue,
                    subject: flowReferenceValue({ source: "input", name: subjectInput }),
                    target: flowReferenceValue({
                      source: "input",
                      name: String(change.targetInputKey),
                    }),
                  }) as unknown as JsonValue,
              ),
            },
          },
        });
      case "record.delete":
        return actionFlowTask(id, "record.delete", {
          record_type: flowTextValue(subjectRecordTypeId),
          record: flowReferenceValue({ source: "input", name: subjectInput }),
        });
      case "event.announce":
        return actionFlowTask(id, "event.announce", {
          event: flowTextValue(String(properties.eventKey)),
        });
      default:
        return fail("vortex.definition.invalid_compilation_output", "invalid_value");
    }
  });

  const precondition = canonicalAction.precondition;
  const tasks: FlowTask[] =
    precondition === undefined
      ? actionTasks
      : [
          {
            id: "precondition",
            type: "if",
            condition: actionPreconditionFormula(precondition, scope),
            then: actionTasks,
            else: [
              actionFlowTask("precondition_refused", "rule.refuse", {
                reason: flowTextValue("precondition_not_met"),
                message: flowTextValue("This action is not available for the record as it is now."),
              }),
            ],
          },
        ];

  const label = String(action.label);
  return {
    contractVersion: flowContractVersion,
    id: canonicalAction.actionId as unknown as FlowDefinition["id"],
    key: flowKey,
    ...(/\{\{|\{%/.test(label) ? {} : { description: label }),
    labels: {},
    namespace,
    execution: "transaction",
    runAs: { kind: "saver" },
    ...(invocationPermissionId === undefined ? {} : { invocationPermissionId }),
    inputs: {
      [subjectInput]: {
        type: "record_reference",
        required: true,
        recordTypeIds: [subjectRecordTypeId] as FlowInputDeclaration["recordTypeIds"],
        description: "The record the action runs on.",
      },
      ...actionInputs,
    },
    variables: {},
    triggers: [],
    tasks,
    outputs: {},
    errors: [],
    finally: [],
  };
}

/**
 * Resolves a source action's registered protected-operation key to the exact operation reference
 * the canonical action carries. Registration is the platform-service catalogue; an action never
 * names an operation identity itself.
 */
export function platformServiceProtectedOperationReference(key: unknown): JsonObject {
  const operation = PLATFORM_SERVICE_OPERATIONS[String(key) as PlatformServiceOperationKey];
  if (operation === undefined)
    fail("vortex.definition.workflow_node_references", "broken_reference");
  return {
    owner: { kind: "platform_service", serviceId: operation.release.serviceId },
    operationId: operation.release.operationId,
  };
}
