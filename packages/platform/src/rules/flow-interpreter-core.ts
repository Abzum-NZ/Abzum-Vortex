import { flowPathGuardMatches } from "./flow-path-guard";
export { flowPathGuardMatches } from "./flow-path-guard";
import { flowSegmentValues } from "./flow-segment-values";
import type { FlowPlan, FlowServerSegment } from "../workflows/flow-plan";
import type { parseFlowSegmentSeed } from "./flow-segment-seed";
import { pageStepIntents, pageValueAcceptsWrite, pageWritesIntent } from "./flow-page-steps";
export { pageStepIntents } from "./flow-page-steps";
import {
  at,
  pathKey,
  iterationKey,
  Failed,
  failed,
  newActivation,
  observe,
  initialState,
  flowRunStateVersion,
  advanceFrame,
  declaredOutputs,
  storeSetOutputs,
  failActivation,
  pushFrame,
  storeTaskOutputs,
  stringOutcomeOutputs,
  withFrames,
} from "./flow-interpreter-state";
import { serverRuns } from "./flow-server-step-runners";
import { formattedTaskValue } from "./flow-data-tasks";
import { buildFlowList } from "./flow-build-list";
import { evaluateRecordChangeValues } from "./flow-record-change-values";
import { findTask, validReadFieldsResume } from "./flow-read-fields-resume";
export { flowRunStateVersion } from "./flow-interpreter-state";
import { flowValueMatchesType } from "./flow-value-shapes";
import type { JsonValue } from "../catalogue/common";
import { isRecord } from "../catalogue/runtime-primitives";
import { isRecordLinkValue } from "../records/module-field-value-predicates";
import { calculateFlowValue } from "./flow-calculate";
import type { FlowTask } from "../workflows/flow-contracts";
import { isFlowReadFieldsTypeMap } from "../workflows/flow-read-fields";
import { flowTaskChildLists } from "../workflows/flow-task-tree";
import { refusalKeepsPlatformGuidance } from "../workflows/flow-refusal-guidance";
import { flowTaskRegistry, type PageIntentStepType } from "../workflows/flow-task-registry-data";
import { flowListItemType, type FlowReference, type FlowValue } from "../workflows/flow-values";
import {
  evaluateFlowFormula,
  flowRuntimeValuesEqual,
  type FlowFormulaScope,
  type FlowRuntimeValue,
} from "./flow-formula";
import { resolveFlowValue } from "./flow-value-runtime";
import {
  flowMaximumForEachItemsOther,
  flowMaximumProtectedOperations,
  flowMaximumSetBasedForEachItems,
  flowMaximumRunFlowDepth,
  flowMaximumTaskOutputPathDepth,
} from "../workflows/flow-limits";

/**
 * The pure interpreter of the in-house flow engine (architecture decision 1). It runs the nested
 * task list of a compiled flow as an explicit, serialisable state machine, so the same code drives
 * a flow in the server orchestrator and in the page, and a run can stop at a task it cannot run
 * itself and resume later from nothing but its state.
 *
 * It performs no effect. Control tasks and pure tasks run here. A task that needs the world stops
 * the run with a step the host must answer:
 * - `protected_task`: a read, change or background-start task. The host runs it (the server
 *   orchestrator through the one protected-operation executor) and resumes with its safe outcome.
 *   The step carries the duplicate-protection key (task path and iteration) the host uses to make
 *   the effect happen once.
 * - `interface`: a Show form or Confirm task. The run is suspended with the typed intents so far,
 *   and the page or MCP client resumes it with the person's answer.
 *
 * It never reads a clock, a record or a session: `now`, the actor and every input come from the
 * host, and nothing in a flow is evaluated as text. Every refusal is a typed failure that names its
 * code, and no failure is ever swallowed or turned into success.
 */

import type {
  FlowFailure,
  FlowRuntimeValues,
  FlowInterfaceIntent,
  FlowRunState,
  FlowProgram,
  FlowProgramLibrary,
  FlowLibrary,
  FlowOutputMemberTypeResolver,
  FlowFormReferenceResolver,
  FlowProtectedTaskCall,
  FlowRunResult,
  FlowRunStep,
  FlowTaskTraceObserver,
  FlowRunStart,
  FlowRunResume,
  FlowSegmentReplay,
  PathSegment,
  Frame,
  Phase,
  Activation,
} from "./flow-interpreter-types";
export type {
  FlowFailureOutcome,
  FlowTaskOutcome,
  FlowFailureCode,
  FlowFailure,
  FlowRuleFeedback,
  FlowRuntimeValues,
  FlowSubject,
  FlowInterfaceIntent,
  FlowRunState,
  FlowProgram,
  FlowLibrary,
  FlowProgramLibrary,
  FlowOutputMemberTypeResolver,
  FlowFormReferenceResolver,
  FlowProtectedTaskCall,
  FlowRunResult,
  FlowRunStep,
  FlowTaskTraceObservation,
  FlowTaskTraceObserver,
  FlowRunStart,
  FlowRunResume,
  FlowSegmentReplay,
} from "./flow-interpreter-types";

const maximumSteps = 10_000;

const typed = (type: string, value: JsonValue): FlowRuntimeValue => ({ type, value });

const clone = <Value>(input: Value): Value => JSON.parse(JSON.stringify(input)) as Value;

const declaredNull = (type: string): FlowRuntimeValue => typed(type, null);

const declaredOutputFieldType = (
  state: FlowRunState,
  activation: Activation,
  flow: FlowProgram,
  taskId: string,
  outputKey: string,
  path: readonly string[],
  resolveMember: FlowOutputMemberTypeResolver,
  resolveForm?: FlowFormReferenceResolver,
): string | undefined => {
  const task = findTask(
    flow.declaredTasks ?? [...flow.tasks, ...flow.errors, ...flow.finally],
    taskId,
  );
  const resolved = resolveMember(task, taskId, outputKey, path);
  if (resolved !== undefined) return resolved;
  if (task?.type === "record.read_fields" && path.length === 1) {
    const types = task.readFieldTypes;
    return isFlowReadFieldsTypeMap(types) && Object.hasOwn(types, path[0]!)
      ? types[path[0]!]
      : undefined;
  }
  // A show-form answer is one declared member, read as a whole (the validator refuses deeper paths).
  if (task?.type !== "interface.show_form" || path.length !== 1) return undefined;
  const inputs = (task as Extract<FlowTask, { properties: Record<string, FlowValue> }>).properties
    .inputs;
  if (inputs?.kind !== "map" || !Object.hasOwn(inputs.entries, path[0]!)) return undefined;
  return evaluateValue(
    inputs.entries[path[0]!]!,
    state,
    activation,
    flow,
    taskId,
    resolveMember,
    resolveForm,
  ).type;
};

const scopeOf = (
  state: FlowRunState,
  activation: Activation,
  flow: FlowProgram,
  resolveMember: FlowOutputMemberTypeResolver,
  resolveForm?: FlowFormReferenceResolver,
): FlowFormulaScope => ({
  now: state.now,
  ...(state.organizationLocalDate === undefined
    ? {}
    : { organizationLocalDate: state.organizationLocalDate }),
  reference: (reference: FlowReference) => {
    switch (reference.source) {
      case "input":
        return (
          activation.inputs[reference.name] ??
          (flow.inputs[reference.name] === undefined
            ? undefined
            : declaredNull(flow.inputs[reference.name]!.type))
        );
      case "variable":
        return activation.variables[reference.name];
      case "task_output": {
        const output = activation.outputs[reference.task]?.[reference.key];
        if (output === undefined || reference.path === undefined) return output;
        if (output.type !== "json" || reference.path.length > flowMaximumTaskOutputPathDepth)
          return undefined;
        let selected: unknown = output.value;
        for (const name of reference.path) {
          if (
            selected === null ||
            typeof selected !== "object" ||
            Array.isArray(selected) ||
            !Object.hasOwn(selected, name)
          )
            return undefined;
          selected = (selected as Record<string, unknown>)[name];
        }
        const type = declaredOutputFieldType(
          state,
          activation,
          flow,
          reference.task,
          reference.key,
          reference.path,
          resolveMember,
          resolveForm,
        );
        if (type === undefined) return undefined;
        // A declared member that is present but empty (a form field left blank) is its typed null.
        if (selected === null) return declaredNull(type);
        return flowValueMatchesType(selected, type)
          ? typed(type, selected as JsonValue)
          : undefined;
      }
      case "loop_item": {
        const loop = [...activation.frames]
          .reverse()
          .find((frame) => frame.loop !== undefined)?.loop;
        const item = loop?.items[loop.iteration];
        if (loop === undefined || item === undefined) return undefined;
        if (reference.path === undefined)
          return item === null ? declaredNull(loop.itemType) : typed(loop.itemType, item);
        if (loop.itemType !== "json") return undefined;
        let selected: unknown = item;
        for (const name of reference.path) {
          if (
            selected === null ||
            typeof selected !== "object" ||
            Array.isArray(selected) ||
            !Object.hasOwn(selected, name)
          )
            return undefined;
          selected = (selected as Record<string, unknown>)[name];
        }
        return typed("json", selected as JsonValue);
      }
      case "execution_actor":
        return state.actor === undefined
          ? undefined
          : typed("organization_account_reference", state.actor);
      case "execution_now":
        return typed("date_time", state.now);
      // A run started by a person or a system has no trigger record, unless the host supplied the
      // record it acts on. That record is the started flow's own: a flow it runs reads none.
      case "trigger_record":
        return activation.prefix === "" ? state.triggerRecord?.[reference.field] : undefined;
      case "trigger_previous":
        return activation.prefix === "" ? state.previousRecord?.[reference.field] : undefined;
      case "form":
        return resolveForm?.(reference) ?? state.forms?.[reference.form]?.[reference.field];
      case "page":
        return state.pageValues?.[reference.name];
      default:
        return undefined;
    }
  },
});

/** The same typed reference scope used by page path guards and final output expressions. */
export const pageFlowScope = (
  state: FlowRunState,
  program: FlowProgram,
  resolveMember: FlowOutputMemberTypeResolver,
  resolveForm?: FlowFormReferenceResolver,
): FlowFormulaScope => {
  const activation = state.activations[0];
  if (
    state.version !== flowRunStateVersion ||
    state.activations.length !== 1 ||
    activation === undefined ||
    activation.flowId !== program.id
  )
    throw new Error("FLOW_PAGE_SCOPE_INVALID");
  return scopeOf(state, activation, program, resolveMember, resolveForm);
};

const evaluateValue = (
  value: FlowValue,
  state: FlowRunState,
  activation: Activation,
  flow: FlowProgram,
  taskId: string,
  resolveMember: FlowOutputMemberTypeResolver,
  resolveForm?: FlowFormReferenceResolver,
): FlowRuntimeValue => {
  return (
    resolveFlowValue(value, scopeOf(state, activation, flow, resolveMember, resolveForm)) ??
    failed("value_unresolved", "failed", taskId)
  );
};

const evaluateProperties = (
  properties: Readonly<Record<string, FlowValue>>,
  state: FlowRunState,
  activation: Activation,
  flow: FlowProgram,
  taskId: string,
  resolveMember: FlowOutputMemberTypeResolver,
  resolveForm?: FlowFormReferenceResolver,
): FlowRuntimeValues =>
  Object.fromEntries(
    Object.entries(properties).map(([name, value]) => [
      name,
      evaluateValue(value, state, activation, flow, taskId, resolveMember, resolveForm),
    ]),
  );

// â”€â”€â”€ Activations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const buildInputs = (
  flow: FlowProgram,
  supplied: Readonly<Record<string, unknown>>,
  taskId?: string,
  requiredInputs?: ReadonlySet<string>,
): FlowRuntimeValues => {
  const invalid = (reason: string) => failed("inputs_invalid", "validation", taskId, reason);
  if (Object.keys(supplied).some((name) => !Object.hasOwn(flow.inputs, name)))
    invalid("an undeclared input was supplied");
  const inputs: Record<string, FlowRuntimeValue> = {};
  for (const [name, declaration] of Object.entries(flow.inputs)) {
    const candidate = Object.hasOwn(supplied, name) ? supplied[name] : undefined;
    if (candidate === undefined || candidate === null) {
      if (declaration.default !== undefined)
        inputs[name] = typed(declaration.type, declaration.default);
      else if (declaration.required && (requiredInputs === undefined || requiredInputs.has(name)))
        invalid(`required input "${name}" is missing`);
      continue;
    }
    if (!flowValueMatchesType(candidate, declaration.type))
      invalid(`input "${name}" is not a valid ${declaration.type} value`);
    inputs[name] = typed(declaration.type, candidate as JsonValue);
  }
  return inputs;
};

type Machine = {
  state: {
    -readonly [Key in keyof FlowRunState]: FlowRunState[Key];
  };
  library: FlowProgramLibrary;
  resolveMember: FlowOutputMemberTypeResolver;
  resolveForm?: FlowFormReferenceResolver;
  segment?: FlowServerSegment;
  replay?: FlowSegmentReplay;
  boundaryBefore?: ReadonlySet<string>;
};

const topOf = (machine: Machine) =>
  machine.state.activations[machine.state.activations.length - 1]!;

const replaceTop = (machine: Machine, next: Activation): void => {
  machine.state.activations = [...machine.state.activations.slice(0, -1), next];
};

const flowOf = (machine: Machine, activation: Activation): FlowProgram =>
  machine.library(activation.flowId) ?? failed("flow_unavailable", "failed");

/**
 * Ends the current phase's task list and starts the next: tasks, then errors (only after a
 * failure), then finally. Returns false when every phase is done.
 */
const nextPhase = (machine: Machine, activation: Activation): Activation | undefined => {
  const flow = flowOf(machine, activation);
  const order: Phase[] = ["tasks", "errors", "finally"];
  for (const phase of order.slice(order.indexOf(activation.phase) + 1)) {
    if (phase === "errors" && activation.failure === undefined) continue;
    if (flow[phase].length === 0) continue;
    return { ...activation, phase, frames: [{ path: [phase], index: 0 }] };
  }
  return undefined;
};

const finishActivation = (machine: Machine, activation: Activation): FlowRunResult => {
  const flow = flowOf(machine, activation);
  if (activation.failure !== undefined) return { status: "failed", failure: activation.failure };
  const outputs: Record<string, FlowRuntimeValue> = {};
  if (machine.segment !== undefined && machine.state.activations.length === 1) {
    Object.assign(
      outputs,
      flowSegmentValues(machine.segment.outputs, activation.variables, activation.outputs),
    );
    const carriedOutputs = flowSegmentValues(
      machine.segment.carriedOutputs,
      activation.variables,
      activation.outputs,
    );
    const finalOutputs: Record<string, FlowRuntimeValue> = {};
    for (const [name, expression] of Object.entries(machine.segment.finalOutputExpressions)) {
      const value = evaluateValue(
        expression,
        machine.state,
        activation,
        flow,
        name,
        machine.resolveMember,
        machine.resolveForm,
      );
      if (value.type !== machine.segment.finalOutputTypes[name])
        failed("value_unresolved", "failed", name);
      finalOutputs[name] = value;
    }
    return {
      status: "completed",
      outputs,
      finalOutputs,
      carriedOutputs,
      ...(activation.stopped === undefined ? {} : { stopped: activation.stopped }),
    };
  }
  for (const [name, declaration] of Object.entries(flow.outputs))
    outputs[name] = evaluateValue(
      declaration.value,
      machine.state,
      activation,
      flow,
      name,
      machine.resolveMember,
      machine.resolveForm,
    );
  return {
    status: "completed",
    outputs,
    ...(activation.stopped === undefined ? {} : { stopped: activation.stopped }),
  };
};

const branch = (
  machine: Machine,
  activation: Activation,
  taskPath: readonly PathSegment[],
  list: readonly unknown[] | undefined,
  ...key: readonly PathSegment[]
): Activation =>
  list === undefined || list.length === 0
    ? activation
    : pushFrame(activation, { path: [...taskPath, ...key], index: 0 });

type Executed = Readonly<{ kind: "continue" }> | Readonly<{ kind: "suspend"; step: FlowRunStep }>;

/** Runs one task of the top activation. Control and pure tasks complete here. */
const execute = (machine: Machine, task: FlowTask, taskPath: readonly PathSegment[]): Executed => {
  const { state } = machine;
  const activation = topOf(machine);
  const flow = flowOf(machine, activation);
  const taskId = task.id;
  let next = advanceFrame(activation);

  switch (task.type) {
    case "if": {
      const node = task as Extract<FlowTask, { type: "if" }>;
      const condition = evaluateFlowFormula(
        node.condition,
        scopeOf(state, activation, flow, machine.resolveMember, machine.resolveForm),
      );
      if (condition?.type !== "yes_no") failed("value_unresolved", "failed", taskId);
      next =
        condition!.value === true
          ? branch(machine, next, taskPath, node.then, "then")
          : branch(machine, next, taskPath, node.else, "else");
      replaceTop(machine, next);
      return { kind: "continue" };
    }
    case "switch": {
      const node = task as Extract<FlowTask, { type: "switch" }>;
      const subject = evaluateValue(
        node.value,
        state,
        activation,
        flow,
        taskId,
        machine.resolveMember,
        machine.resolveForm,
      );
      let chosen = -1;
      node.cases.forEach((entry, index) => {
        if (chosen >= 0) return;
        const equal = flowRuntimeValuesEqual(subject, typed(entry.when.type, entry.when.value));
        if (equal === undefined) failed("value_unresolved", "failed", taskId);
        if (equal) chosen = index;
      });
      next =
        chosen >= 0
          ? branch(machine, next, taskPath, node.cases[chosen]!.tasks, "cases", chosen, "tasks")
          : branch(machine, next, taskPath, node.default, "default");
      replaceTop(machine, next);
      return { kind: "continue" };
    }
    case "sequential": {
      const node = task as Extract<FlowTask, { type: "sequential" }>;
      replaceTop(machine, branch(machine, next, taskPath, node.tasks, "tasks"));
      return { kind: "continue" };
    }
    case "for_each": {
      const node = task as Extract<FlowTask, { type: "for_each" }>;
      const items = evaluateValue(
        node.items,
        state,
        activation,
        flow,
        taskId,
        machine.resolveMember,
        machine.resolveForm,
      );
      if (!Array.isArray(items.value)) return failed("value_unresolved", "failed", taskId);
      const setBased = machine.segment?.setBasedChanges.some((change) => change.taskId === taskId);
      const maximum = setBased ? flowMaximumSetBasedForEachItems : flowMaximumForEachItemsOther;
      if (items.value.length > Math.min(node.maximumItems, maximum))
        failed("for_each_limit", "failed", taskId);
      const loop = {
        count: items.value.length,
        iteration: 0,
        items: items.value as readonly JsonValue[],
        itemType: flowListItemType(items.type),
      };
      if (setBased && loop.count > 0) return suspendSet(machine, node, taskPath, next, loop);
      replaceTop(
        machine,
        loop.count === 0 ? next : pushFrame(next, { path: [...taskPath, "tasks"], index: 0, loop }),
      );
      return { kind: "continue" };
    }
    case "stop": {
      const node = task as Extract<FlowTask, { type: "stop" }>;
      replaceTop(machine, { ...activation, stopped: node.outcome, frames: [] });
      return { kind: "continue" };
    }
    case "run_flow": {
      const node = task as Extract<FlowTask, { type: "run_flow" }>;
      // The root activation plus at most the allowed number of nested calls.
      if (state.activations.length > flowMaximumRunFlowDepth)
        failed("run_flow_depth", "failed", taskId);
      const child = machine.library(node.flowId) ?? failed("flow_unavailable", "failed", taskId);
      if (child.execution !== "interactive") failed("flow_not_runnable", "failed", taskId);
      const supplied = Object.fromEntries(
        Object.entries(node.inputs).map(([name, value]) => [
          name,
          evaluateValue(
            value,
            state,
            activation,
            flow,
            taskId,
            machine.resolveMember,
            machine.resolveForm,
          ).value,
        ]),
      );
      const inputs = buildInputs(child, supplied, taskId);
      replaceTop(machine, next);
      machine.state.activations = [
        ...machine.state.activations,
        newActivation(child, inputs, `${activation.prefix}${pathKey(taskPath)}>`, taskId),
      ];
      return { kind: "continue" };
    }
    default:
      break;
  }

  // A registered task.
  const registered = task as Extract<FlowTask, { properties: unknown }>;
  const definition = flowTaskRegistry[registered.type as keyof typeof flowTaskRegistry];
  if (definition === undefined) return failed("task_unknown", "failed", taskId);
  const evaluatedProperties = evaluateProperties(
    registered.type === "data.calculate"
      ? Object.fromEntries(
          Object.entries(registered.properties).filter(([name]) => name !== "formula"),
        )
      : registered.properties,
    state,
    activation,
    flow,
    taskId,
    machine.resolveMember,
    machine.resolveForm,
  );
  // A record change list holds nested values the interpreter evaluates like any other value.
  const properties =
    registered.type === "record.changes"
      ? evaluateRecordChangeValues(evaluatedProperties, (value) =>
          evaluateValue(
            value,
            state,
            activation,
            flow,
            taskId,
            machine.resolveMember,
            machine.resolveForm,
          ),
        )
      : evaluatedProperties;
  if (properties === undefined) return failed("value_unresolved", "failed", taskId);

  if (definition.effect === "pure") {
    if (!serverRuns(registered.type, "interpreter")) failed("task_not_available", "failed", taskId);
    if (registered.type === "data.format") {
      const value = formattedTaskValue(properties);
      if (value === undefined) return failed("value_unresolved", "failed", taskId);
      replaceTop(machine, storeTaskOutputs(next, taskId, { value }));
      return { kind: "continue" };
    }
    if (registered.type === "data.record_link") {
      const recordType = registered.properties.record_type;
      const record = registered.properties.record;
      if (
        recordType?.kind !== "literal" ||
        recordType.literal.type !== "text" ||
        typeof recordType.literal.value !== "string" ||
        record?.kind !== "reference" ||
        record.reference.source !== "input"
      )
        return failed("value_unresolved", "failed", taskId);

      const recordTypeId = recordType.literal.value;
      const declaration = flow.inputs[record.reference.name];
      if (
        declaration === undefined ||
        declaration.type !== "record_reference" ||
        declaration.recordTypeIds?.length !== 1 ||
        declaration.recordTypeIds[0] !== recordTypeId
      )
        return failed("value_unresolved", "failed", taskId);

      const evaluatedType = properties.record_type;
      const evaluatedRecord = properties.record;
      if (
        evaluatedType?.type !== "text" ||
        evaluatedType.value !== recordTypeId ||
        evaluatedRecord?.type !== "record_reference" ||
        typeof evaluatedRecord.value !== "string"
      )
        return failed("value_unresolved", "failed", taskId);

      const link = {
        recordTypeId,
        recordId: evaluatedRecord.value,
      };
      if (!isRecordLinkValue(link)) return failed("value_unresolved", "failed", taskId);
      replaceTop(machine, storeTaskOutputs(next, taskId, { value: typed("json", link) }));
      return { kind: "continue" };
    }
    if (registered.type === "data.calculate") {
      const formula = registered.properties.formula;
      const resultType = properties.result_type?.value;
      if (formula?.kind !== "formula" || typeof resultType !== "string")
        return failed("value_unresolved", "failed", taskId);
      const result = calculateFlowValue(
        formula.formula,
        resultType,
        properties.places?.value,
        properties.rounding?.value,
        scopeOf(state, activation, flow, machine.resolveMember, machine.resolveForm),
      );
      if ("error" in result)
        return failed(
          result.error,
          result.error === "non_integral_whole_number" ? "validation" : "failed",
          taskId,
        );
      replaceTop(machine, storeTaskOutputs(next, taskId, { value: result.value }));
      return { kind: "continue" };
    }
    if (registered.type === "data.build_list") {
      const list = buildFlowList(
        properties.items?.value,
        properties.value?.value,
        properties.label?.value,
        properties.description?.value,
      );
      if (list === undefined) return failed("value_unresolved", "failed", taskId);
      replaceTop(machine, storeTaskOutputs(next, taskId, { list: typed("json", [...list]) }));
      return { kind: "continue" };
    }
    if (registered.type === "data.set_variable") {
      const name = properties.variable?.value;
      const value = properties.value;
      if (typeof name !== "string" || !Object.hasOwn(flow.variables, name) || value === undefined)
        return failed("value_unresolved", "failed", taskId);
      replaceTop(machine, {
        ...next,
        variables: { ...next.variables, [name]: value },
      });
      return { kind: "continue" };
    }
    // A save transaction flow reports its warnings and requirements and refuses its record here.
    // Only a save reads the warnings and requirements, so any other transaction flow may only refuse.
    if (
      flow.execution === "transaction" &&
      (registered.type === "rule.refuse" ||
        (registered.type.startsWith("rule.") &&
          flow.triggers.some((trigger) => trigger.type === "BeforeSave")))
    ) {
      const message = properties.message?.value;
      if (typeof message !== "string") return failed("value_unresolved", "failed", taskId);
      const field = properties.field?.value;
      if (field !== undefined && typeof field !== "string")
        return failed("value_unresolved", "failed", taskId);
      if (registered.type === "rule.refuse") {
        const reason = properties.reason?.value;
        if (typeof reason !== "string") return failed("value_unresolved", "failed", taskId);
        throw new Failed({
          outcome: "refused",
          code: "task_refused",
          taskId,
          ruleRefusal: { reason, message, ...(field === undefined ? {} : { field }) },
        });
      }
      if (registered.type === "rule.require" && field === undefined)
        return failed("value_unresolved", "failed", taskId);
      machine.state.ruleFeedback = [
        ...(machine.state.ruleFeedback ?? []),
        {
          kind: registered.type === "rule.warn" ? "warn" : "require",
          taskId,
          message,
          ...(field === undefined ? {} : { field }),
        },
      ];
      replaceTop(machine, next);
      return { kind: "continue" };
    }
    // Save rules give feedback in the browser and are authoritative in the save transaction.
    return failed("task_not_available", "failed", taskId);
  }

  if (definition.effect === "interface") {
    if (registered.type === "interface.set_value" && properties.value !== undefined) {
      const name = properties.value.value;
      const value = properties.to;
      if (typeof name !== "string" || !pageValueAcceptsWrite(state.pageValues?.[name], value))
        return failed("value_unresolved", "failed", taskId);
      machine.state.pageValues = { ...state.pageValues, [name]: value };
      machine.state.pageWrites = { ...state.pageWrites, [name]: value };
      replaceTop(machine, next);
      return { kind: "continue" };
    }
    const kind = Object.hasOwn(pageStepIntents, registered.type)
      ? pageStepIntents[registered.type as PageIntentStepType]
      : undefined;
    if (kind === undefined) return failed("task_not_available", "failed", taskId);
    const intent: FlowInterfaceIntent = { kind, taskId, properties };
    replaceTop(machine, next);
    if (kind !== "show_form" && kind !== "confirm") {
      machine.state.pendingIntents = [...machine.state.pendingIntents, intent];
      return { kind: "continue" };
    }
    const intents = [...takeIntents(machine), intent];
    const inputs = kind === "show_form" ? registered.properties.inputs : undefined;
    const answerTypes =
      inputs?.kind === "map"
        ? Object.fromEntries(
            Object.entries(inputs.entries).map(([name, entry]) => [
              name,
              evaluateValue(
                entry,
                state,
                activation,
                flow,
                taskId,
                machine.resolveMember,
                machine.resolveForm,
              ).type,
            ]),
          )
        : undefined;
    machine.state.awaiting =
      kind === "show_form"
        ? { kind: "form", taskId, ...(answerTypes === undefined ? {} : { answerTypes }) }
        : { kind: "confirm", taskId };
    return {
      kind: "suspend",
      step: {
        kind: "interface",
        state: snapshot(machine),
        awaiting: kind === "show_form" ? "form" : "confirm",
        intents,
      },
    };
  }

  // A read, change or background-start task: the host runs it.
  if (machine.state.protectedOperations >= flowMaximumProtectedOperations)
    failed("protected_operation_limit", "failed", taskId);
  machine.state.protectedOperations += 1;
  const allowRefusal = registered.allowRefusal === true;
  machine.state.awaiting = {
    kind: "protected_task",
    taskId,
    taskType: registered.type,
    allowRefusal,
  };
  replaceTop(machine, next);
  return {
    kind: "suspend",
    step: {
      kind: "protected_task",
      state: snapshot(machine),
      call: {
        taskId,
        taskType: registered.type,
        taskVersion: registered.version,
        effect: definition.effect as FlowProtectedTaskCall["effect"],
        taskPath: `${activation.prefix}${pathKey(taskPath)}`,
        iteration: iterationKey(machine.state),
        properties,
        flowInputs: activation.inputs,
        allowRefusal,
      },
    },
  };
};

const snapshot = (machine: Machine): FlowRunState => clone(machine.state) as FlowRunState;

/**
 * A set-based For each: each item's record steps are evaluated as they would run in that
 * iteration, then the run suspends once, as one protected operation, for the host to apply them
 * all as one change.
 */
const suspendSet = (
  machine: Machine,
  node: Extract<FlowTask, { type: "for_each" }>,
  taskPath: readonly PathSegment[],
  next: Activation,
  loop: NonNullable<Frame["loop"]>,
): Executed => {
  const calls: FlowProtectedTaskCall[] = [];
  for (let iteration = 0; iteration < loop.count; iteration += 1)
    node.tasks.forEach((child, index) => {
      const scratch: Machine = { ...machine, state: clone(machine.state) };
      const frame = { path: [...taskPath, "tasks"], index, loop: { ...loop, iteration } };
      replaceTop(scratch, pushFrame(next, frame));
      const executed = execute(scratch, child, [...taskPath, "tasks", index]);
      if (executed.kind === "suspend" && executed.step.kind === "protected_task")
        calls.push(executed.step.call);
      else failed("task_not_available", "failed", child.id);
    });
  if (machine.state.protectedOperations >= flowMaximumProtectedOperations)
    failed("protected_operation_limit", "failed", node.id);
  machine.state.protectedOperations += 1;
  machine.state.awaiting = {
    kind: "protected_set",
    taskId: node.id,
    calls: calls.map(({ taskId, taskType, allowRefusal }) => ({ taskId, taskType, allowRefusal })),
  };
  replaceTop(machine, next);
  const activation = topOf(machine);
  return {
    kind: "suspend",
    step: {
      kind: "protected_set",
      state: snapshot(machine),
      taskPath: `${activation.prefix}${pathKey(taskPath)}`,
      iteration: iterationKey(machine.state),
      calls,
    },
  };
};

/** Runs the machine until it needs the host or the run is finished. */
const run = (machine: Machine, observer?: FlowTaskTraceObserver): FlowRunStep => {
  for (;;) {
    machine.state.steps += 1;
    if (machine.state.steps > maximumSteps) failed("step_limit", "failed");
    const activation = topOf(machine);
    const frame = activation.frames[activation.frames.length - 1];

    if (frame === undefined) {
      const following =
        machine.segment !== undefined && machine.state.activations.length === 1
          ? undefined
          : nextPhase(machine, activation);
      if (following !== undefined) {
        replaceTop(machine, following);
        continue;
      }
      let result: FlowRunResult;
      try {
        result = finishActivation(machine, activation);
      } catch (error) {
        if (!(error instanceof Failed)) throw error;
        result = { status: "failed", failure: { ...error.failure, code: "output_unresolved" } };
      }
      if (machine.state.activations.length === 1) {
        const intents = takeIntents(machine);
        delete machine.state.awaiting;
        return { kind: "finished", state: snapshot(machine), intents, result };
      }
      // Hand the child's result to the Run flow task in its parent.
      const parent = machine.state.activations[machine.state.activations.length - 2]!;
      const callTaskId = activation.callTaskId!;
      observe(observer, {
        flowId: parent.flowId,
        taskId: callTaskId,
        taskType: "run_flow",
        iteration: iterationKey(machine.state),
        outcome: result.status === "failed" ? "failed" : "completed",
        ...(result.status === "failed"
          ? { failure: { ...result.failure, taskId: callTaskId } }
          : {}),
      });
      machine.state.activations = machine.state.activations.slice(0, -1);
      if (result.status === "failed")
        replaceTop(machine, failActivation(parent, { ...result.failure, taskId: callTaskId }));
      else replaceTop(machine, storeTaskOutputs(parent, callTaskId, result.outputs));
      continue;
    }

    const list = at(flowOf(machine, activation), frame.path) as readonly FlowTask[] | undefined;
    if (list === undefined || frame.index >= list.length) {
      if (
        machine.segment !== undefined &&
        machine.state.activations.length === 1 &&
        activation.frames.length === 1
      )
        return {
          kind: "boundary",
          state: snapshot(machine),
          result: finishActivation(machine, activation),
        };
      // The list is done. A For each body starts its next iteration; everything else pops.
      if (frame.loop !== undefined && frame.loop.iteration + 1 < frame.loop.count)
        replaceTop(
          machine,
          withFrames(activation, [
            ...activation.frames.slice(0, -1),
            { ...frame, index: 0, loop: { ...frame.loop, iteration: frame.loop.iteration + 1 } },
          ]),
        );
      else replaceTop(machine, withFrames(activation, activation.frames.slice(0, -1)));
      continue;
    }

    const taskPath = [...frame.path, frame.index];
    const task = list[frame.index]!;
    if (
      machine.segment === undefined &&
      machine.state.activations.length === 1 &&
      machine.boundaryBefore?.has(task.id)
    )
      return { kind: "boundary", state: snapshot(machine), nextTaskId: task.id };
    if (
      machine.segment !== undefined &&
      machine.state.activations.length === 1 &&
      !machine.segment.tasks.some(
        (root) =>
          root.id === task.id ||
          findTask(
            flowTaskChildLists(root).flatMap((child) => child.tasks),
            task.id,
          ) !== undefined,
      )
    ) {
      return {
        kind: "boundary",
        state: snapshot(machine),
        result: finishActivation(machine, activation),
        nextTaskId: task.id,
      };
    }
    const observation = {
      flowId: activation.flowId,
      taskId: task.id,
      taskType: task.type,
      iteration: iterationKey(machine.state),
    } as const;
    try {
      const activationCount = machine.state.activations.length;
      const executed = execute(machine, task, taskPath);
      if (executed.kind === "suspend") {
        if (executed.step.kind === "protected_set" && machine.replay !== undefined) {
          const replay =
            machine.replay[JSON.stringify([executed.step.taskPath, executed.step.iteration])];
          if (replay === undefined || replay === null || replay.kind !== "task_result")
            return failed(
              "replay_unavailable",
              "refused",
              task.id,
              "the earlier result cannot be shown again; reload",
            );
          return { ...executed.step, replay };
        }
        if (
          executed.step.kind === "protected_task" &&
          machine.replay !== undefined &&
          executed.step.call.effect !== "read"
        ) {
          const key = JSON.stringify([executed.step.call.taskPath, executed.step.call.iteration]);
          const replay = machine.replay[key];
          if (replay === undefined || replay === null || replay.kind !== "task_result")
            return failed(
              "replay_unavailable",
              "refused",
              task.id,
              "the earlier result cannot be shown again; reload",
            );
          return { ...executed.step, replay };
        }
        if (executed.step.kind === "interface") {
          const intent = executed.step.intents.find((intent) => intent.taskId === task.id);
          observe(observer, {
            ...observation,
            outcome: "interface",
            ...(intent === undefined ? {} : { intent }),
          });
        } else observe(observer, { ...observation, outcome: "awaiting" });
        return executed.step;
      }
      if (task.type === "run_flow" && machine.state.activations.length > activationCount) {
        observe(observer, { ...observation, outcome: "entered" });
      } else if (task.type.startsWith("interface.")) {
        const intent = machine.state.pendingIntents.at(-1);
        observe(observer, {
          ...observation,
          outcome: "interface",
          ...(intent?.taskId === task.id ? { intent } : {}),
        });
      } else observe(observer, { ...observation, outcome: "completed" });
    } catch (error) {
      if (!(error instanceof Failed)) throw error;
      observe(observer, { ...observation, outcome: "failed", failure: error.failure });
      // Leave the task list at the failure; the errors handler and finally still run.
      const current = topOf(machine);
      replaceTop(machine, failActivation(current, error.failure));
    }
  }
};
function takeIntents(machine: Machine): FlowInterfaceIntent[] {
  const intents = [...machine.state.pendingIntents];
  const writes = machine.state.pageWrites;
  if (writes !== undefined && Object.keys(writes).length > 0)
    intents.push(pageWritesIntent(writes));
  machine.state.pendingIntents = [];
  delete machine.state.pageWrites;
  return intents;
}

const failedStep = (machine: Machine, failure: FlowFailure): FlowRunStep => {
  const intents = takeIntents(machine);
  delete machine.state.awaiting;
  return {
    kind: "finished",
    state: snapshot(machine),
    intents,
    result: { status: "failed", failure },
  };
};

const drive = (machine: Machine, observer?: FlowTaskTraceObserver): FlowRunStep => {
  try {
    return run(machine, observer);
  } catch (error) {
    if (error instanceof Failed) return failedStep(machine, error.failure);
    throw error;
  }
};

/**
 * Starts a run of one flow the host has already resolved and authorised. The inputs are the typed
 * inputs the binding supplied and are checked against the flow's declarations; the host supplies
 * the run id, the instant and the actor from its own trusted context.
 */
export const startFlowRun = (
  start: FlowRunStart,
  library: FlowProgramLibrary,
  resolveMember: FlowOutputMemberTypeResolver,
  observer?: FlowTaskTraceObserver,
  resolveForm?: FlowFormReferenceResolver,
  boundaryBefore?: ReadonlySet<string>,
): FlowRunStep => {
  const state = initialState(start);
  const machine: Machine = {
    state: { ...state },
    library,
    resolveMember,
    ...(resolveForm === undefined ? {} : { resolveForm }),
    ...(boundaryBefore === undefined ? {} : { boundaryBefore }),
  };
  const flow = library(start.flowId);
  if (flow === undefined)
    return failedStep(machine, { outcome: "failed", code: "flow_unavailable" });
  if (!(start.executionKinds ?? ["interactive"]).includes(flow.execution))
    return failedStep(machine, { outcome: "failed", code: "flow_not_runnable" });
  let inputs: FlowRuntimeValues;
  try {
    inputs = start.verifiedInputs ?? buildInputs(flow, start.inputs);
  } catch (error) {
    if (error instanceof Failed) return failedStep(machine, error.failure);
    throw error;
  }
  machine.state.activations = [newActivation(flow, inputs, "")];
  return drive(machine, observer);
};

/** Starts the admitted server segment with the host's binding inputs and validated page values. */
export const startFlowSegment = (
  plan: FlowPlan,
  segmentId: string,
  start: FlowRunStart,
  seed: Readonly<Record<string, unknown>>,
  library: FlowLibrary,
  resolveMember: FlowOutputMemberTypeResolver,
  parseSeed: typeof parseFlowSegmentSeed,
  replay?: FlowSegmentReplay,
): FlowRunStep => {
  const state = initialState(start);
  const machine: Machine = { state: { ...state }, library, resolveMember };
  const segment = plan.segments.find((part) => part.kind === "server" && part.id === segmentId);
  if (
    segment === undefined ||
    segment.kind !== "server" ||
    start.flowId !== plan.flowId ||
    library(start.flowId) !== plan.definition
  )
    return failedStep(machine, { outcome: "refused", code: "flow_unavailable" });
  const flow = plan.definition;
  if (flow.execution !== "interactive")
    return failedStep(machine, { outcome: "refused", code: "flow_not_runnable" });
  try {
    const parsed = parseSeed(flow, segment, seed, start);
    if (Object.keys(parsed.inputs).some((name) => Object.hasOwn(start.inputs, name)))
      failed("inputs_invalid", "refused", undefined, "page input overrides a server binding");
    const requiredInputs = new Set(
      Object.keys(segment.inputs)
        .filter((name) => name.startsWith("inputs."))
        .map((name) => name.slice(7)),
    );
    const inputs = buildInputs(
      flow,
      { ...start.inputs, ...parsed.inputs },
      undefined,
      requiredInputs,
    );
    const { variables, outputs, forms } = parsed;
    const completion = segment.tasks.length === 0;
    if (completion && segment.firstTaskPath.length !== 0)
      failed("inputs_invalid", "refused", undefined, "completion segment has invalid tasks");
    machine.state.forms = forms;
    const taskPath = segment.firstTaskPath;
    const index = taskPath.at(-1);
    if (!completion && typeof index !== "number")
      return failedStep(machine, { outcome: "refused", code: "flow_unavailable" });
    if (!completion && (taskPath[0] !== segment.section || at(flow, taskPath) !== segment.tasks[0]))
      failed("flow_unavailable", "refused", undefined, "segment location is invalid");
    const activation: Activation = {
      ...newActivation(flow, inputs, ""),
      variables,
      outputs,
      phase: segment.section,
      frames: completion ? [] : [{ path: taskPath.slice(0, -1), index: index as number }],
    };
    machine.state.activations = [activation];
    machine.segment = segment;
    if (replay !== undefined) machine.replay = replay;
    if (
      !flowPathGuardMatches(
        segment.guard,
        scopeOf(machine.state, activation, flow, resolveMember),
        (value, task) => evaluateValue(value, machine.state, activation, flow, task, resolveMember),
      )
    )
      failed("inputs_invalid", "refused", undefined, "segment path does not match");
    return completion
      ? {
          kind: "boundary",
          state: snapshot(machine),
          result: finishActivation(machine, activation),
        }
      : drive(machine);
  } catch (error) {
    if (error instanceof Failed) return failedStep(machine, error.failure);
    throw error;
  }
};

/**
 * Starts one detached page segment, retaining the preceding segment's typed activation. The page
 * driver chooses the segment and its phase; the interpreter still executes its task tree. Final
 * outputs and the next phase are handled by the driver after all selected segments have run.
 */
export const startPageFlowSegment = (
  program: FlowProgram,
  start: FlowRunStart,
  resolveMember: FlowOutputMemberTypeResolver,
  previous?: FlowRunState,
  resolveForm?: FlowFormReferenceResolver,
): FlowRunStep => {
  const library: FlowProgramLibrary = (id) => (id === program.id ? program : undefined);
  if (
    program.execution !== "interactive" ||
    program.errors.length !== 0 ||
    program.finally.length !== 0 ||
    Object.keys(program.outputs).length !== 0
  )
    throw new Error("FLOW_PAGE_SEGMENT_PROGRAM_INVALID");
  if (previous === undefined)
    return startFlowRun(start, library, resolveMember, undefined, resolveForm);
  const machine: Machine = {
    state: {
      ...clone(previous),
      ...(start.pageValues === undefined ? {} : { pageValues: start.pageValues }),
    },
    library,
    resolveMember,
    ...(resolveForm === undefined ? {} : { resolveForm }),
  };
  const activation = machine.state.activations[0];
  if (
    previous.version !== flowRunStateVersion ||
    previous.runId !== start.runId ||
    previous.awaiting !== undefined ||
    previous.activations.length !== 1 ||
    activation === undefined ||
    activation.flowId !== program.id ||
    activation.frames.length !== 0
  )
    return failedStep(machine, { outcome: "failed", code: "resume_mismatch" });
  const retained: { -readonly [Key in keyof Activation]: Activation[Key] } = { ...activation };
  delete retained.failure;
  delete retained.stopped;
  machine.state.activations = [
    { ...retained, phase: "tasks", frames: [{ path: ["tasks"], index: 0 }] },
  ];
  return drive(machine);
};

/** Evaluates one authored value in the interpreter's scope. */
export const evaluateFlowValue = (
  flow: FlowProgram,
  value: FlowValue,
  start: FlowRunStart,
  resolveMember: FlowOutputMemberTypeResolver,
): FlowRuntimeValue => {
  const activation = newActivation(
    flow,
    start.verifiedInputs ?? buildInputs(flow, start.inputs),
    "",
  );
  return evaluateValue(
    value,
    { ...initialState(start), activations: [activation] },
    activation,
    flow,
    "value",
    resolveMember,
  );
};

/** Continues a preserved boundary without answering a suspended task or page intent. */
export const continueFlowRun = (
  previous: FlowRunState,
  library: FlowLibrary,
  resolveMember: FlowOutputMemberTypeResolver,
  resolveForm?: FlowFormReferenceResolver,
  segment?: FlowServerSegment,
  replay?: FlowSegmentReplay,
  boundaryBefore?: ReadonlySet<string>,
  observer?: FlowTaskTraceObserver,
): FlowRunStep => {
  const machine: Machine = {
    state: clone(previous),
    library,
    resolveMember,
    ...(resolveForm === undefined ? {} : { resolveForm }),
    ...(segment === undefined ? {} : { segment }),
    ...(replay === undefined ? {} : { replay }),
    ...(boundaryBefore === undefined ? {} : { boundaryBefore }),
  };
  if (previous.awaiting !== undefined || previous.version !== flowRunStateVersion)
    return failedStep(machine, { outcome: "failed", code: "resume_mismatch" });
  if (segment !== undefined) {
    try {
      const activation = topOf(machine);
      const flow = flowOf(machine, activation);
      if (
        (segment.tasks.length > 0 && activation.phase !== segment.section) ||
        !flowPathGuardMatches(
          segment.guard,
          scopeOf(machine.state, activation, flow, resolveMember, resolveForm),
          (value, task) =>
            evaluateValue(value, machine.state, activation, flow, task, resolveMember, resolveForm),
        )
      )
        failed("inputs_invalid", "refused", undefined, "segment path does not match");
      if (segment.tasks.length === 0)
        return {
          kind: "boundary",
          state: snapshot(machine),
          result: finishActivation(machine, activation),
        };
    } catch (error) {
      if (error instanceof Failed) return failedStep(machine, error.failure);
      throw error;
    }
  }
  return drive(machine, observer);
};

/**
 * Resumes a suspended run with what the host obtained: the safe outcome of the protected task it
 * ran, or the person's answer to the form or confirmation. A resume of the wrong kind is refused,
 * so a page can never answer a protected task or skip a confirmation.
 */
export const resumeFlowRun = (
  previous: FlowRunState,
  resume: FlowRunResume,
  library: FlowProgramLibrary,
  resolveMember: FlowOutputMemberTypeResolver,
  observer?: FlowTaskTraceObserver,
  resolveForm?: FlowFormReferenceResolver,
  segment?: FlowServerSegment,
  replay?: FlowSegmentReplay,
  boundaryBefore?: ReadonlySet<string>,
): FlowRunStep => {
  const machine: Machine = {
    state: clone(previous),
    library,
    resolveMember,
    ...(resolveForm === undefined ? {} : { resolveForm }),
    ...(segment === undefined ? {} : { segment }),
    ...(replay === undefined ? {} : { replay }),
    ...(boundaryBefore === undefined ? {} : { boundaryBefore }),
  };
  const awaiting = machine.state.awaiting;
  const mismatch = () => failedStep(machine, { outcome: "failed", code: "resume_mismatch" });
  if (awaiting === undefined || previous.version !== flowRunStateVersion) return mismatch();
  delete machine.state.awaiting;
  const activation = topOf(machine);

  if (awaiting.kind === "protected_set") {
    if (resume.kind !== "task_result") return mismatch();
    if (resume.outcome === "committed" || resume.outcome === "completed") {
      // A set's result carries each call's outputs under `set`, in call order.
      const produced = resume.outputs?.set;
      if (
        !Array.isArray(produced) ||
        produced.length !== awaiting.calls.length ||
        !produced.every(
          (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry),
        )
      )
        return mismatch();
      if (resume.outcome === "committed") machine.state.committedEffects += 1;
      replaceTop(machine, storeSetOutputs(activation, awaiting, produced as never));
      return drive(machine, observer);
    }
    // A refused set names the call whose change was refused under `task`; it ends as that task.
    const call = awaiting.calls.find((candidate) => candidate.taskId === resume.outputs?.task);
    if (call === undefined) return mismatch();
    return resumeFlowRun(
      { ...machine.state, awaiting: { kind: "protected_task", ...call } },
      {
        kind: "task_result",
        outcome: resume.outcome,
        ...(resume.diagnostic === undefined ? {} : { diagnostic: resume.diagnostic }),
      },
      library,
      resolveMember,
      observer,
      resolveForm,
      segment,
      replay,
      boundaryBefore,
    );
  }

  if (awaiting.kind === "protected_task") {
    if (resume.kind !== "task_result") return mismatch();
    const outputs = stringOutcomeOutputs(resume.outcome);
    const succeeded =
      resume.outcome === "completed" ||
      resume.outcome === "committed" ||
      resume.outcome === "background_pending";
    if (succeeded) {
      if (
        awaiting.taskType === "record.read_fields" &&
        !validReadFieldsResume(machine.library(activation.flowId), awaiting.taskId, resume.outputs)
      ) {
        replaceTop(
          machine,
          failActivation(activation, {
            outcome: "validation",
            code: "output_unresolved",
            taskId: awaiting.taskId,
          }),
        );
        return drive(machine, observer);
      }
      if (resume.outcome === "committed") machine.state.committedEffects += 1;
      replaceTop(
        machine,
        storeTaskOutputs(activation, awaiting.taskId, {
          ...declaredOutputs(awaiting.taskType, resume.outputs),
          ...outputs,
        }),
      );
      return drive(machine, observer);
    }
    // A refused, conflict or invalid outcome is branched on only when the task allows it.
    const branchable =
      resume.outcome === "refused" ||
      resume.outcome === "conflict" ||
      resume.outcome === "validation";
    // Confirmed guidance (sign-in recovery, incompatible storage, a named missing installation
    // permission) is never replaced by an authored handler for ordinary refusals.
    if (
      awaiting.allowRefusal &&
      branchable &&
      !refusalKeepsPlatformGuidance(resume.diagnostic?.code)
    ) {
      replaceTop(machine, storeTaskOutputs(activation, awaiting.taskId, outputs));
      return drive(machine, observer);
    }
    replaceTop(
      machine,
      failActivation(activation, {
        outcome: resume.outcome,
        code: "task_refused",
        taskId: awaiting.taskId,
        ...(resume.diagnostic === undefined ? {} : { diagnostic: resume.diagnostic }),
      }),
    );
    return drive(machine, observer);
  }

  if (awaiting.kind === "form") {
    if (resume.kind !== "submit" && resume.kind !== "cancel") return mismatch();
    const submitted = resume.kind === "submit";
    let values: JsonValue | null = null;
    if (resume.kind === "submit") {
      values = resume.values;
    }
    if (submitted && awaiting.answerTypes !== undefined) {
      const answers =
        values !== null && typeof values === "object" && !Array.isArray(values)
          ? values
          : undefined;
      const declared = Object.entries(awaiting.answerTypes);
      const invalidAnswer =
        answers === undefined
          ? "the submitted answers are not an object"
          : Object.keys(answers).length !== declared.length
            ? "the submitted answers do not match the form's declared answers"
            : // A field left empty answers null; whether it may be empty is the form's and the
              // consuming task's decision, so only a present value must match its declared type.
              declared.find(
                ([name, type]) =>
                  !Object.hasOwn(answers, name) ||
                  (answers[name] !== null && !flowValueMatchesType(answers[name], type)),
              );
      if (invalidAnswer !== undefined) {
        replaceTop(
          machine,
          failActivation(activation, {
            outcome: "validation",
            code: "inputs_invalid",
            taskId: awaiting.taskId,
            reason:
              typeof invalidAnswer === "string"
                ? invalidAnswer
                : `answer "${invalidAnswer[0]}" is missing or not a valid ${invalidAnswer[1]} value`,
          }),
        );
        return drive(machine, observer);
      }
    }
    replaceTop(
      machine,
      storeTaskOutputs(activation, awaiting.taskId, {
        submitted: typed("yes_no", submitted),
        values: typed("json", values),
      }),
    );
    return drive(machine, observer);
  }

  if (resume.kind !== "confirm") return mismatch();
  replaceTop(
    machine,
    storeTaskOutputs(activation, awaiting.taskId, {
      confirmed: typed("yes_no", resume.confirmed),
      // The opt-in counts only with a yes; a declined confirmation never carries it.
      choice: typed("yes_no", resume.confirmed && resume.choice === true),
    }),
  );
  return drive(machine, observer);
};
