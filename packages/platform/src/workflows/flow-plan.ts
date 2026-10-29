import { fingerprintCanonicalValue } from "../definition/canonical-json-definition";
import {
  PLATFORM_SERVICE_OPERATIONS,
  platformOperationKey,
  type PlatformServiceOperationKey,
} from "../catalogue/platform-service-operation-catalogue";
import { protectedOperationMetadata } from "../definition/protected-operation-metadata";
import { flowRuntimeValuesEqual } from "../rules/flow-formula";
import type { FlowDefinition, FlowTask } from "./flow-contracts";
import { flowTaskChildLists, isFlowControlTask } from "./flow-contracts";
import { flowTaskRegistry, type FlowTaskTypeKey } from "./flow-task-registry";
import {
  parseFlowReference,
  type FlowFormula,
  type FlowLiteral,
  type FlowReference,
  type FlowValue,
} from "./flow-values";

/**
 * The compiled plan of one flow: its tasks cut into page segments (steps the page performs, no
 * request) and server segments (one gated request and one transaction each), the path guard that
 * reaches each segment, and the browser plan the page receives. Publication and the runtime build
 * plans with this one compiler; a plan is never stored. The runtime builds one plan set per
 * installed release (`flowPlansOf`), so the invoke and save paths never parse a flow again.
 */

/** Where a whole subtree of tasks runs; `neutral` (a Stop) joins the segment around it. */
type UnitLocation = "page" | "server" | "neutral" | "mixed";

/** One branch decision on the path from the start of the flow to a segment. */
export type FlowPathCondition =
  | Readonly<{
      taskId: string;
      kind: "if";
      branch: "then" | "else";
      condition: FlowFormula;
    }>
  | Readonly<{
      taskId: string;
      kind: "switch";
      branch: string;
      value: FlowValue;
      when: FlowLiteral;
    }>
  | Readonly<{
      taskId: string;
      kind: "switch";
      branch: "default";
      value: FlowValue;
      cases: readonly FlowLiteral[];
    }>;

/** A typed value a segment reads from before it or hands on after it. */
export type FlowPlanValueTypes = Readonly<Record<string, string>>;

export type FlowPlanSection = "tasks" | "errors" | "finally";

export type FlowPageSegment = Readonly<{
  kind: "page";
  id: string;
  section: FlowPlanSection;
  guard: readonly FlowPathCondition[];
  tasks: readonly FlowTask[];
}>;

export type FlowServerSegment = Readonly<{
  kind: "server";
  id: string;
  section: FlowPlanSection;
  guard: readonly FlowPathCondition[];
  tasks: readonly FlowTask[];
  /** Address of the first task in the original definition; empty for a completion segment. */
  firstTaskPath: readonly (string | number)[];
  /** The values the segment reads from outside itself, and the outputs it produces. */
  inputs: FlowPlanValueTypes;
  outputs: FlowPlanValueTypes;
  /** Server-only reads and writes transported in an opaque carried-values token. */
  carriedInputs: FlowPlanValueTypes;
  carriedOutputs: FlowPlanValueTypes;
  /** Prior carried values still needed after this segment. */
  carriedRetainKeys: readonly string[];
  /** Server-only expressions for final outputs evaluated after the segment completes. */
  finalOutputExpressions: Readonly<Record<string, FlowValue>>;
  finalOutputTypes: FlowPlanValueTypes;
  /** Whether a step of the segment changes data or starts back-end work. */
  changes: boolean;
  /** Whether this segment needs an exclusive Access version lock. */
  accessChange: boolean;
  /** Whether an effect in this segment runs a multi-transaction workflow. */
  multiTransaction: boolean;
  /** A target that must be locked before the Access version and scope. */
  preScopeLock: "organization_account" | null;
  /** Each For each over record steps, which runs as one set-based change. */
  setBasedChanges: readonly Readonly<{
    taskId: string;
    steps: readonly string[];
  }>[];
  /** The segment ends at a Run on back end step; the child runs after the segment commits. */
  endsWithBackendRun: boolean;
  /** Identity of the compiled server steps and their input and output types, for admission. */
  fingerprint: `sha256:${string}`;
  labels: readonly string[];
}>;

export type FlowPlanSegment = FlowPageSegment | FlowServerSegment;

/** What the page holds for one server segment: no step properties, operation inputs or secrets. */
export type FlowSegmentStub = Readonly<{
  kind: "server";
  id: string;
  section: FlowPlanSection;
  guard: readonly FlowPathCondition[];
  inputs: FlowPlanValueTypes;
  outputs: FlowPlanValueTypes;
  /** Carried reads are supplied by the server, never seeded by the page. */
  carriedInputKeys: readonly string[];
  finalOutputTypes: FlowPlanValueTypes;
  fingerprint: `sha256:${string}`;
  labels: readonly string[];
}>;

/** The plan the page receives: page steps and segment stubs only. */
export type BrowserFlowPlan = Readonly<{
  flowId: string;
  inputs: FlowPlanValueTypes;
  outputs: FlowPlanValueTypes;
  segments: readonly (FlowPageSegment | FlowSegmentStub)[];
}>;

export type FlowPlan = Readonly<{
  flowId: string;
  /** The validated flow the server interpreter runs. */
  definition: FlowDefinition;
  segments: readonly FlowPlanSegment[];
  /** Segment owning each original task, including tasks nested in a control step. */
  taskSegmentIds: ReadonlyMap<string, string>;
  /** Whether any server segment changes data or starts back-end work. */
  changes: boolean;
  /** Whether any step runs in the page. */
  pageSteps: boolean;
  browser: BrowserFlowPlan;
}>;

export type FlowPlanSet = Readonly<{
  plans: ReadonlyMap<string, FlowPlan>;
  /** The validated flow of each planned flow, by flow identity. */
  flows: ReadonlyMap<string, FlowDefinition>;
  /** Form placements reachable from each installed row-action source placement. */
  rowFormsByTable: ReadonlyMap<string, ReadonlySet<string>>;
  /** The interpreter's flow library over `flows`. */
  library: (flowId: string) => FlowDefinition | undefined;
}>;

const planSet = (
  plans: ReadonlyMap<string, FlowPlan>,
  rowFormsByTable: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): FlowPlanSet => {
  const flows = new Map([...plans].map(([id, plan]) => [id, plan.definition]));
  return { plans, flows, rowFormsByTable, library: (flowId) => flows.get(flowId) };
};

/** A flow the compiler cannot plan, naming the step. Publication reports it; nothing runs it. */
export class FlowPlanError extends Error {
  constructor(
    readonly flowId: string,
    readonly taskId: string | undefined,
    readonly reason: string,
  ) {
    super(`FLOW_PLAN_REFUSED: ${reason}`);
    this.name = "FlowPlanError";
  }
}

const registered = (task: FlowTask) =>
  Object.hasOwn(flowTaskRegistry, task.type)
    ? flowTaskRegistry[task.type as FlowTaskTypeKey]
    : undefined;

const operationOf = (flow: FlowDefinition, task: FlowTask) => {
  if (task.type !== "operation.call") return undefined;
  const operation = (task as Extract<FlowTask, { properties: Record<string, FlowValue> }>)
    .properties.operation;
  if (operation?.kind !== "literal" || typeof operation.literal.value !== "string")
    throw new FlowPlanError(
      flow.id,
      task.id,
      `Call protected operation (${task.id}) needs a literal operation key`,
    );
  const entry = Object.entries(PLATFORM_SERVICE_OPERATIONS).find(
    ([key]) => platformOperationKey(key) === operation.literal.value,
  );
  if (entry === undefined) return undefined;
  const key = entry[0] as PlatformServiceOperationKey;
  return { key, effect: entry[1].descriptor.effect, ...protectedOperationMetadata[key] };
};

/** Record steps a named action collects into one change; a For each over them is set-based. */
const setBasedSteps = new Set([
  "record.create",
  "record.set_fields",
  "record.delete",
  "record.changes",
]);

const leafLocation = (flow: FlowDefinition, task: FlowTask): UnitLocation => {
  if (task.type === "stop") return "neutral";
  const definition = registered(task);
  if (definition === undefined) throw new FlowPlanError(flow.id, task.id, "unknown step");
  // A save transaction and a back-end flow run every step in one place.
  if (flow.execution !== "interactive") return "server";
  if (definition.runs.page && definition.runLocations.includes("browser")) return "page";
  if (definition.runs.server) return "server";
  throw new FlowPlanError(
    flow.id,
    task.id,
    `${definition.title} (${task.id}) has no implementation where it is placed`,
  );
};

const containsBackendRun = (task: FlowTask): boolean =>
  task.type === "backend.run" ||
  flowTaskChildLists(task).some((list) => list.tasks.some(containsBackendRun));

const unitLocation = (
  flow: FlowDefinition,
  task: FlowTask,
  applicationKey: string | undefined,
): UnitLocation => {
  if (!isFlowControlTask(task) || task.type === "stop") return leafLocation(flow, task);
  // A Run flow step and a control step run where their children run; Run flow runs its child on
  // the server today.
  if (task.type === "run_flow") return "server";
  // A Run on back end inside a control step ends the segment, so the control step is cut there.
  if (containsBackendRun(task)) return "mixed";
  if (
    allSteps(flowTaskChildLists(task).flatMap((list) => list.tasks)).some((child) =>
      isCrossApplicationPin(child, applicationKey),
    )
  )
    return "mixed";
  const locations = new Set(
    flowTaskChildLists(task).flatMap((list) =>
      list.tasks.map((child) => unitLocation(flow, child, applicationKey)),
    ),
  );
  locations.delete("neutral");
  if (locations.has("mixed") || locations.size > 1) return "mixed";
  return locations.values().next().value ?? "neutral";
};

const allSteps = (tasks: readonly FlowTask[]): FlowTask[] =>
  tasks.flatMap((task) => [
    task,
    ...flowTaskChildLists(task).flatMap((list) => allSteps(list.tasks)),
  ]);

/** Every reference a task's values and conditions read. */
const referencesIn = (value: unknown, found: FlowReference[] = []): FlowReference[] => {
  if (typeof value === "string") {
    const reference = parseFlowReference(value);
    if (reference !== undefined) found.push(reference);
  } else if (Array.isArray(value)) {
    for (const item of value) referencesIn(item, found);
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const reference = record.reference;
    if (
      typeof reference === "object" &&
      reference !== null &&
      typeof (reference as { source?: unknown }).source === "string"
    )
      found.push(reference as FlowReference);
    for (const [key, item] of Object.entries(record))
      if (key !== "reference") referencesIn(item, found);
  }
  return found;
};

const outputTypes = (steps: readonly FlowTask[]): Record<string, string> =>
  Object.fromEntries(
    steps.flatMap((step) =>
      (registered(step)?.outputs ?? []).map((output) => [`outputs.${step.id}.${output.key}`, output.type]),
    ),
  );

const inputTypes = (
  flow: FlowDefinition,
  steps: readonly (FlowTask | FlowPathCondition)[],
  produced: ReadonlySet<string>,
  segmentId: string,
): Record<string, string> => {
  const types: Record<string, string> = {};
  for (const reference of referencesIn(steps)) {
    switch (reference.source) {
      case "input":
        types[`inputs.${reference.name}`] = flow.inputs[reference.name]?.type ?? "json";
        break;
      case "variable":
        types[`vars.${reference.name}`] = flow.variables[reference.name]?.type ?? "json";
        break;
      case "task_output": {
        const key = `${reference.task}.${reference.key}`;
        if (produced.has(reference.task)) break;
        const producer = allSteps([...flow.tasks, ...flow.errors, ...flow.finally]).find(
          (step) => step.id === reference.task,
        );
        types[`outputs.${key}`] =
          reference.key === "outcome"
            ? "text"
            : ((producer === undefined ? undefined : outputTypes([producer])[`outputs.${key}`]) ?? "json");
        break;
      }
      case "trigger_record":
        types[`trigger.record.${reference.field}`] = "record_field";
        break;
      case "trigger_previous":
        types[`trigger.previous.${reference.field}`] = "record_field";
        break;
      // A page value or a form field lives only in the page; the server never reads one.
      case "page":
      case "form":
        throw new FlowPlanError(
          flow.id,
          undefined,
          `server segment ${segmentId} reads a page value, which only the page holds`,
        );
      default:
        break;
    }
  }
  return types;
};

const setBasedChanges = (steps: readonly FlowTask[]) =>
  steps.flatMap((step) => {
    if (step.type !== "for_each") return [];
    const body = allSteps(flowTaskChildLists(step).flatMap((list) => list.tasks)).filter(
      (child) => !isFlowControlTask(child),
    );
    return body.length > 0 && body.every((child) => setBasedSteps.has(child.type))
      ? [{ taskId: step.id, steps: body.map((child) => child.id) }]
      : [];
  });

type Draft = {
  kind: "page" | "server";
  section: FlowPlanSection;
  guard: readonly FlowPathCondition[];
  tasks: FlowTask[];
  listPath: readonly (string | number)[];
  firstTaskPath: readonly (string | number)[];
  lastTaskIndex: number;
  closed: boolean;
};

const sameGuard = (left: readonly FlowPathCondition[], right: readonly FlowPathCondition[]) =>
  left.length === right.length &&
  left.every(
    (condition, index) =>
      condition.taskId === right[index]!.taskId && condition.branch === right[index]!.branch,
  );

const cut = (
  flow: FlowDefinition,
  section: FlowPlanSection,
  tasks: readonly FlowTask[],
  applicationKey: string | undefined,
) => {
  const drafts: Draft[] = [];
  const emit = (
    task: FlowTask,
    location: UnitLocation,
    guard: readonly FlowPathCondition[],
    listPath: readonly (string | number)[],
    index: number,
  ) => {
    const current = drafts.at(-1);
    const kind =
      location === "neutral" ? (current?.kind ?? "server") : (location as "page" | "server");
    const isolatedPin = isCrossApplicationPin(task, applicationKey);
    if (
      current !== undefined &&
      !current.closed &&
      !isolatedPin &&
      current.kind === kind &&
      current.lastTaskIndex + 1 === index &&
      current.listPath.length === listPath.length &&
      current.listPath.every((part, index) => part === listPath[index]) &&
      sameGuard(current.guard, guard)
    ) {
      current.tasks.push(task);
      current.lastTaskIndex = index;
    } else
      drafts.push({
        kind,
        section,
        guard,
        tasks: [task],
        listPath,
        firstTaskPath: [...listPath, index],
        lastTaskIndex: index,
        closed: false,
      });
    if (task.type === "backend.run" || isolatedPin) drafts.at(-1)!.closed = true;
  };
  const walk = (
    list: readonly FlowTask[],
    guard: readonly FlowPathCondition[],
    listPath: readonly (string | number)[],
  ) => {
    for (const [index, task] of list.entries()) {
      const location = unitLocation(flow, task, applicationKey);
      if (location !== "mixed") {
        emit(task, location, guard, listPath, index);
        continue;
      }
      switch (task.type) {
        case "if": {
          const node = task as Extract<FlowTask, { type: "if" }>;
          walk(
            node.then,
            [
              ...guard,
              {
                taskId: node.id,
                kind: "if",
                branch: "then",
                condition: node.condition,
              },
            ],
            [...listPath, index, "then"],
          );
          if (node.else !== undefined)
            walk(
              node.else,
              [
                ...guard,
                {
                  taskId: node.id,
                  kind: "if",
                  branch: "else",
                  condition: node.condition,
                },
              ],
              [...listPath, index, "else"],
            );
          break;
        }
        case "switch": {
          const node = task as Extract<FlowTask, { type: "switch" }>;
          for (const [caseIndex, entry] of node.cases.entries())
            walk(
              entry.tasks,
              [
                ...guard,
                {
                  taskId: node.id,
                  kind: "switch",
                  branch: entry.key,
                  value: node.value,
                  when: entry.when,
                },
              ],
              [...listPath, index, "cases", caseIndex, "tasks"],
            );
          if (node.default !== undefined)
            walk(
              node.default,
              [
                ...guard,
                {
                  taskId: node.id,
                  kind: "switch",
                  branch: "default",
                  value: node.value,
                  cases: node.cases.map((entry) => entry.when),
                },
              ],
              [...listPath, index, "default"],
            );
          break;
        }
        case "sequential":
          walk((task as Extract<FlowTask, { type: "sequential" }>).tasks, guard, [
            ...listPath,
            index,
            "tasks",
          ]);
          break;
        default:
          // A For each whose body mixes page and server steps would make one request per item.
          throw new FlowPlanError(
            flow.id,
            task.id,
            `For each (${task.id}) mixes page and server steps; put them in separate loops`,
          );
      }
    }
  };
  walk(tasks, [], [section]);
  return drafts;
};

/** A pin with an unknown target must be isolated as a cross-application workflow. */
const isCrossApplicationPin = (step: FlowTask, applicationKey: string | undefined): boolean => {
  if (step.type !== "record.pin_identity") return false;
  if (applicationKey === undefined) return true;
  const target = (step as Extract<FlowTask, { properties: Record<string, FlowValue> }>)
    .properties.application_key;
  return (
    target !== undefined && (target.kind !== "literal" || target.literal.value !== applicationKey)
  );
};

/** Compiles one validated flow into its plan. Throws `FlowPlanError` naming the step it refuses. */
export const compileFlowPlan = (flow: FlowDefinition, applicationKey?: string): FlowPlan => {
  for (const step of allSteps([...flow.tasks, ...flow.errors, ...flow.finally])) {
    if (step.type === "for_each") {
      const pin = allSteps(flowTaskChildLists(step).flatMap((list) => list.tasks)).find((child) =>
        isCrossApplicationPin(child, applicationKey),
      );
      if (pin !== undefined)
        throw new FlowPlanError(
          flow.id,
          pin.id,
          `Cross-application pin ${pin.id} cannot run inside For each ${step.id}`,
        );
    }
    if (step.type !== "switch") continue;
    const cases = (step as Extract<FlowTask, { type: "switch" }>).cases;
    for (let index = 0; index < cases.length; index += 1) {
      const current = cases[index]!;
      for (const previous of cases.slice(0, index)) {
        if (flowRuntimeValuesEqual(previous.when, current.when) === true)
          throw new FlowPlanError(
            flow.id,
            step.id,
            `Switch (${step.id}) cases ${previous.key} and ${current.key} match the same value`,
          );
      }
    }
  }
  const drafts = [
    ...cut(flow, "tasks", flow.tasks, applicationKey),
    ...cut(flow, "errors", flow.errors, applicationKey),
    ...cut(flow, "finally", flow.finally, applicationKey),
  ];
  const segments = drafts.map((draft, index): FlowPlanSegment => {
    const id = `${flow.id}:${index}`;
    if (draft.kind === "page")
      return {
        kind: "page",
        id,
        section: draft.section,
        guard: draft.guard,
        tasks: draft.tasks,
      };
    const steps = allSteps(draft.tasks);
    const produced = new Set(steps.map((step) => step.id));
    const inputs = inputTypes(flow, [...draft.tasks, ...draft.guard], produced, id);
    const outputs = outputTypes(steps);
    const carriedInputs: FlowPlanValueTypes = {};
    const carriedOutputs: FlowPlanValueTypes = {};
    const carriedRetainKeys: readonly string[] = [];
    const finalOutputExpressions: Readonly<Record<string, FlowValue>> = {};
    const finalOutputTypes: FlowPlanValueTypes = {};
    const operations = new Map(steps.map((step) => [step.id, operationOf(flow, step)]));
    const effects = steps.filter((step) => {
      const effect =
        step.type === "run_flow"
          ? "change"
          : (operations.get(step.id)?.effect ?? registered(step)?.effect);
      return (
        effect === "change" ||
        effect === "background_start" ||
        isCrossApplicationPin(step, applicationKey)
      );
    });
    const multi = steps.find(
      (step) =>
        operations.get(step.id)?.workflow === "multi_transaction" ||
        isCrossApplicationPin(step, applicationKey),
    );
    if (multi !== undefined && effects.length > 1) {
      const other = effects.find((step) => step.id !== multi.id)!;
      throw new FlowPlanError(
        flow.id,
        multi.id,
        `Multi-transaction step ${multi.id} cannot share a segment with effect ${other.id}`,
      );
    }
    const accessChange = steps.some(
      (step) => operations.get(step.id)?.transaction === "access_change",
    );
    const multiTransaction = multi !== undefined;
    const preScope = steps.find((step) => operations.get(step.id)?.preScopeLock !== undefined);
    if (preScope !== undefined && effects.length > 1) {
      const other = effects.find((step) => step.id !== preScope.id)!;
      throw new FlowPlanError(
        flow.id,
        preScope.id,
        `Pre-scope lock step ${preScope.id} cannot share a segment with effect ${other.id}`,
      );
    }
    return {
      kind: "server",
      id,
      section: draft.section,
      guard: draft.guard,
      tasks: draft.tasks,
      firstTaskPath: draft.firstTaskPath,
      inputs,
      outputs,
      carriedInputs,
      carriedOutputs,
      carriedRetainKeys,
      finalOutputExpressions,
      finalOutputTypes,
      changes: effects.length > 0,
      accessChange,
      multiTransaction,
      preScopeLock: preScope === undefined ? null : operations.get(preScope.id)!.preScopeLock!,
      setBasedChanges: setBasedChanges(steps),
      endsWithBackendRun: draft.tasks.at(-1)?.type === "backend.run",
      fingerprint: fingerprintCanonicalValue({
        section: draft.section,
        guard: draft.guard,
        tasks: draft.tasks,
        inputs,
        outputs,
        carriedInputs,
        carriedOutputs,
        carriedRetainKeys,
        finalOutputExpressions,
        finalOutputTypes,
        multiTransaction,
        operations: steps.flatMap((step) => {
          const operation = operations.get(step.id);
          return operation === undefined ? [] : [operation];
        }),
      }),
      labels: steps.flatMap((step) => {
        const title = registered(step)?.title;
        return title === undefined ? [] : [title];
      }),
    };
  });
  const declared = (record: Readonly<Record<string, { type: string }>>) =>
    Object.fromEntries(Object.entries(record).map(([name, value]) => [name, value.type]));
  const taskSegmentIds = new Map<string, string>();
  for (const segment of segments)
    for (const task of allSteps(segment.tasks)) taskSegmentIds.set(task.id, segment.id);
  return {
    flowId: flow.id,
    definition: flow,
    segments,
    taskSegmentIds,
    changes: segments.some((segment) => segment.kind === "server" && segment.changes),
    pageSteps: segments.some((segment) => segment.kind === "page"),
    browser: {
      flowId: flow.id,
      inputs: declared(flow.inputs),
      outputs: declared(flow.outputs),
      segments: segments.map((segment) =>
        segment.kind === "page"
          ? segment
          : {
              kind: "server",
              id: segment.id,
              section: segment.section,
              guard: segment.guard,
              inputs: segment.inputs,
              outputs: segment.outputs,
              carriedInputKeys: Object.keys(segment.carriedInputs),
              finalOutputTypes: segment.finalOutputTypes,
              fingerprint: segment.fingerprint,
              labels: segment.labels,
            },
      ),
    },
  };
};

/** Links a server segment to every child plan it can run. */
const linkFlowPlans = (plans: ReadonlyMap<string, FlowPlan>, applicationKey?: string) => {
  const linked = new Map<string, FlowPlan>();
  const visit = (id: string, active: ReadonlySet<string>): FlowPlan => {
    const known = linked.get(id);
    if (known !== undefined) return known;
    const plan = plans.get(id);
    if (plan === undefined) throw new FlowPlanError(id, undefined, `Flow ${id} is unavailable`);
    if (active.has(id)) throw new FlowPlanError(id, undefined, `Flow ${id} calls itself`);
    const next = new Set(active).add(id);
    const segments = plan.segments.map((segment): FlowPlanSegment => {
      if (segment.kind !== "server") return segment;
      const children = allSteps(segment.tasks).filter(
        (step): step is Extract<FlowTask, { type: "run_flow" }> => step.type === "run_flow",
      );
      if (children.length === 0) return segment;
      let childAccessChange = false;
      let childMultiTransaction = false;
      const fingerprints = children.map((step) => {
        const childId = String(step.flowId);
        if (!plans.has(childId))
          throw new FlowPlanError(id, step.id, `Flow ${id} cannot run unavailable flow ${childId}`);
        const child = visit(childId, next);
        if (child.pageSteps)
          throw new FlowPlanError(
            id,
            step.id,
            `Flow ${id} cannot run flow ${childId} with page steps on the server`,
          );
        if (child.segments.some((part) => part.kind === "server" && part.preScopeLock !== null))
          throw new FlowPlanError(
            id,
            step.id,
            `Flow ${id} cannot run flow ${childId} with a pre-scope lock operation`,
          );
        const childMulti = child.segments.find(
          (part) => part.kind === "server" && part.multiTransaction,
        );
        if (childMulti !== undefined) {
          const otherChild = child.segments.find(
            (part) => part.kind === "server" && part.changes && part.id !== childMulti.id,
          );
          const otherParent = allSteps(segment.tasks).find((part) => {
            if (part.id === step.id) return false;
            const effect =
              part.type === "run_flow"
                ? "change"
                : (operationOf(plan.definition, part)?.effect ?? registered(part)?.effect);
            return (
              effect === "change" ||
              effect === "background_start" ||
              isCrossApplicationPin(part, applicationKey)
            );
          });
          if (otherChild !== undefined || otherParent !== undefined)
            throw new FlowPlanError(
              id,
              step.id,
              `Multi-transaction flow ${childId} cannot share an admitted segment with effect ${otherParent?.id ?? otherChild!.id}`,
            );
        }
        childAccessChange ||= child.segments.some(
          (part) => part.kind === "server" && part.accessChange,
        );
        childMultiTransaction ||= child.segments.some(
          (part) => part.kind === "server" && part.multiTransaction,
        );
        return {
          flowId: childId,
          segments: child.segments.flatMap((part) =>
            part.kind === "server" ? [part.fingerprint] : [],
          ),
        };
      });
      return {
        ...segment,
        accessChange: segment.accessChange || childAccessChange,
        multiTransaction: segment.multiTransaction || childMultiTransaction,
        fingerprint: fingerprintCanonicalValue({
          segment: segment.fingerprint,
          children: fingerprints,
        }),
      };
    });
    const fingerprints = new Map(
      segments.flatMap((segment) =>
        segment.kind === "server" ? [[segment.id, segment.fingerprint] as const] : [],
      ),
    );
    const result: FlowPlan = {
      ...plan,
      segments,
      browser: {
        ...plan.browser,
        segments: plan.browser.segments.map((segment) =>
          segment.kind === "server"
            ? { ...segment, fingerprint: fingerprints.get(segment.id)! }
            : segment,
        ),
      },
    };
    linked.set(id, result);
    return result;
  };
  return (id: string) => visit(id, new Set());
};

/** Compiles every flow of one release. One flow per identity; an ambiguous release is refused. */
export const compileFlowPlans = (
  flows: readonly FlowDefinition[],
  applicationKey?: string,
): FlowPlanSet => {
  const plans = new Map<string, FlowPlan>();
  for (const flow of flows) {
    const id = String(flow.id);
    if (plans.has(id)) throw new FlowPlanError(id, undefined, "two flows share one identity");
    plans.set(id, compileFlowPlan(flow, applicationKey));
  }
  const link = linkFlowPlans(plans, applicationKey);
  return planSet(new Map([...plans.keys()].map((id) => [id, link(id)])));
};

/** The first server segments reachable along any page-side path of this flow. */
export const flowEntrySegments = (plan: FlowPlan): readonly FlowServerSegment[] => {
  const segments = new Map(plan.segments.map((segment) => [segment.id, segment]));
  const entries = new Set<string>();
  type Reach = Readonly<{ falls: boolean; stops: boolean; pageFailure: boolean }>;
  const list = (tasks: readonly FlowTask[]): Reach => {
    let falls = true;
    let stops = false;
    let pageFailure = false;
    for (const task of tasks) {
      if (!falls) break;
      const part = taskReach(task);
      falls = part.falls;
      stops ||= part.stops;
      pageFailure ||= part.pageFailure;
    }
    return { falls, stops, pageFailure };
  };
  const combine = (parts: readonly Reach[]): Reach => ({
    falls: parts.some((part) => part.falls),
    stops: parts.some((part) => part.stops),
    pageFailure: parts.some((part) => part.pageFailure),
  });
  const taskReach = (task: FlowTask): Reach => {
    const segmentId = plan.taskSegmentIds.get(task.id);
    const segment = segmentId === undefined ? undefined : segments.get(segmentId);
    if (segment?.kind === "server") {
      entries.add(segment.id);
      return { falls: false, stops: false, pageFailure: false };
    }
    if (task.type === "stop") return { falls: false, stops: true, pageFailure: false };
    if (task.type === "if") {
      const branch = task as Extract<FlowTask, { type: "if" }>;
      const reached = combine([list(branch.then), list(branch.else ?? [])]);
      return { ...reached, pageFailure: true };
    }
    if (task.type === "switch") {
      const branch = task as Extract<FlowTask, { type: "switch" }>;
      const reached = combine([...branch.cases.map((entry) => list(entry.tasks)), list(branch.default ?? [])]);
      return { ...reached, pageFailure: true };
    }
    if (task.type === "sequential")
      return list((task as Extract<FlowTask, { type: "sequential" }>).tasks);
    if (task.type === "for_each") {
      const reached = list((task as Extract<FlowTask, { type: "for_each" }>).tasks);
      return { ...reached, falls: true, pageFailure: true };
    }
    return { falls: true, stops: false, pageFailure: true };
  };
  const tasks = list(plan.definition.tasks);
  const errors = tasks.pageFailure ? list(plan.definition.errors) : undefined;
  const successBeforeFinally = tasks.falls || tasks.stops;
  const failureBeforeFinally = errors !== undefined && (errors.falls || errors.stops || errors.pageFailure);
  const final = successBeforeFinally || failureBeforeFinally ? list(plan.definition.finally) : undefined;
  if (successBeforeFinally && final !== undefined && (final.falls || final.stops)) {
    const completion = plan.segments.find(
      (part): part is FlowServerSegment => part.kind === "server" && part.tasks.length === 0,
    );
    if (completion !== undefined) entries.add(completion.id);
  }
  return plan.segments.filter(
    (segment): segment is FlowServerSegment => segment.kind === "server" && entries.has(segment.id),
  );
};

/** All possible entry identities must match the installed plan, irrespective of order. */
export const flowEntrySegmentsMatch = (
  plan: FlowPlan,
  supplied: readonly Readonly<{ segmentId: string; fingerprint: string }>[],
): boolean => {
  const expected = flowEntrySegments(plan);
  if (supplied.length !== expected.length) return false;
  const identities = new Map(supplied.map((entry) => [entry.segmentId, entry.fingerprint]));
  return (
    identities.size === supplied.length &&
    expected.every((segment) => identities.get(segment.id) === segment.fingerprint)
  );
};

/** Derive the literal form placements reachable from a row-action flow. */
export const rowActionFormTargets = (
  flowId: string,
  library: (id: string) => FlowDefinition | undefined,
): ReadonlySet<string> => {
  const forms = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const flow = library(id);
    if (flow === undefined) throw new FlowPlanError(id, undefined, "row-action flow is unavailable");
    for (const task of allSteps([...flow.tasks, ...flow.errors, ...flow.finally])) {
      if (task.type === "run_flow") {
        visit(String((task as Extract<FlowTask, { type: "run_flow" }>).flowId));
      } else if (task.type === "interface.show_form") {
        const target = (task as Extract<FlowTask, { properties: Record<string, FlowValue> }>)
          .properties.form;
        if (target?.kind !== "literal" || typeof target.literal.value !== "string")
          throw new FlowPlanError(id, task.id, "row-action form target must be a literal");
        forms.add(target.literal.value);
      }
    }
  };
  visit(flowId);
  return forms;
};

/** Why a binding's plan cannot run as bound, or undefined. Publication refuses it by name. */
export const flowBindingPlanIssue = (
  plan: FlowPlan,
  binding: Readonly<{
    event: string;
    settings?: Readonly<{ concurrency?: string }> | undefined;
  }>,
): string | undefined => {
  // An aborted request does not stop the server: an earlier change can still commit.
  if (binding.settings?.concurrency === "latest_wins" && plan.changes)
    return "Latest wins cannot be used on a flow that changes data; use Queue";
  if (binding.event === "options_requested" && (plan.pageSteps || plan.changes))
    return "An options flow only reads: it can hold no page steps and no changes";
  return undefined;
};

/** The release set shape a plan set is built from: the cached, already-validated release content. */
type PlannedContent = Readonly<{ flows: readonly FlowDefinition[] }>;
type PlannedReleaseSet = Readonly<{
  application: Readonly<{
    definitionKey: string;
    content: PlannedContent & Readonly<{
      flowBindings: readonly Readonly<{
        event: string;
        controlId: string;
        flow: Readonly<{ flowId: string }>;
      }>[];
    }>;
  }>;
  modules: readonly Readonly<{ content: PlannedContent }>[];
}>;

/**
 * Plan sets by the immutable application content they were built from, with the Module contents
 * beside it. A request re-stamps its correlation on shallow copies of the release set, but the
 * frozen contents are the cached bundle's own, so every request of one installed release finds
 * the plan set built when its bundle was read.
 */
const releasePlans = new WeakMap<
  PlannedContent,
  Readonly<{ applicationKey: string; modules: readonly PlannedContent[]; set: FlowPlanSet }>
>();

/**
 * The plan set of one installed release set, built once per release (a new release has new
 * contents and builds a new plan set). The release set was validated when its bundle was read, so
 * nothing is parsed here. A flow that cannot be planned is unavailable, never run.
 */
export const flowPlansOf = (releaseSet: PlannedReleaseSet): FlowPlanSet => {
  const modules = releaseSet.modules.map((module) => module.content);
  const known = releasePlans.get(releaseSet.application.content);
  if (
    known !== undefined &&
    known.applicationKey === releaseSet.application.definitionKey &&
    known.modules.length === modules.length &&
    known.modules.every((content, index) => content === modules[index])
  )
    return known.set;
  const plans = new Map<string, FlowPlan>();
  const ambiguous = new Set<string>();
  for (const flow of [
    ...releaseSet.application.content.flows,
    ...modules.flatMap((content) => content.flows),
  ]) {
    const id = String(flow.id);
    if (plans.has(id) || ambiguous.has(id)) {
      plans.delete(id);
      ambiguous.add(id);
      continue;
    }
    try {
      plans.set(id, compileFlowPlan(flow, releaseSet.application.definitionKey));
    } catch (error) {
      if (!(error instanceof FlowPlanError)) throw error;
      console.error(`[flows] flow ${id} cannot be planned: ${error.reason}`);
    }
  }
  if (ambiguous.size > 0) throw new Error("FLOW_IDENTITY_AMBIGUOUS");
  const link = linkFlowPlans(plans, releaseSet.application.definitionKey);
  const available = new Map<string, FlowPlan>();
  for (const id of plans.keys()) {
    try {
      available.set(id, link(id));
    } catch (error) {
      if (!(error instanceof FlowPlanError)) throw error;
      console.error(`[flows] flow ${id} cannot be planned: ${error.reason}`);
    }
  }
  const rowFormsByTable = new Map<string, Set<string>>();
  for (const binding of releaseSet.application.content.flowBindings) {
    if (binding.event !== "row_action") continue;
    const id = String(binding.flow.flowId);
    try {
      const forms = rowActionFormTargets(id, (flowId) => available.get(flowId)?.definition);
      const table = String(binding.controlId);
      const held = rowFormsByTable.get(table) ?? new Set<string>();
      forms.forEach((form) => held.add(form));
      rowFormsByTable.set(table, held);
    } catch (error) {
      if (!(error instanceof FlowPlanError)) throw error;
      available.delete(id);
      console.error(`[flows] row-action flow ${id} cannot be planned: ${error.reason}`);
    }
  }
  const set = planSet(available, rowFormsByTable);
  releasePlans.set(releaseSet.application.content, {
    applicationKey: releaseSet.application.definitionKey,
    modules,
    set,
  });
  return set;
};
