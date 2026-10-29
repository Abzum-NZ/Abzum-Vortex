import { fingerprintCanonicalValue } from "../definition/canonical-json-definition";
import { prepareFlowFormulas } from "../rules/flow-formula";
import type { FlowDefinition, FlowTask } from "./flow-contracts";
import { flowTaskChildLists, isFlowControlTask } from "./flow-contracts";
import { flowTaskRegistry, type FlowTaskTypeKey } from "./flow-task-registry";
import { parseFlowReference, type FlowFormula, type FlowReference } from "./flow-values";

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
  | Readonly<{ taskId: string; kind: "if"; branch: "then" | "else"; condition: FlowFormula }>
  | Readonly<{ taskId: string; kind: "switch"; branch: string; value: unknown; when?: unknown }>;

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
  /** The values the segment reads from outside itself, and the outputs it produces. */
  inputs: FlowPlanValueTypes;
  outputs: FlowPlanValueTypes;
  /** Whether a step of the segment changes data or starts back-end work. */
  changes: boolean;
  /** Each For each over record steps, which runs as one set-based change. */
  setBasedChanges: readonly Readonly<{ taskId: string; steps: readonly string[] }>[];
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
  /** The interpreter's flow library over `flows`. */
  library: (flowId: string) => FlowDefinition | undefined;
}>;

const planSet = (plans: ReadonlyMap<string, FlowPlan>): FlowPlanSet => {
  const flows = new Map([...plans].map(([id, plan]) => [id, plan.definition]));
  return { plans, flows, library: (flowId) => flows.get(flowId) };
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

const unitLocation = (flow: FlowDefinition, task: FlowTask): UnitLocation => {
  if (!isFlowControlTask(task) || task.type === "stop") return leafLocation(flow, task);
  // A Run flow step and a control step run where their children run; Run flow runs its child on
  // the server today.
  if (task.type === "run_flow") return "server";
  // A Run on back end inside a control step ends the segment, so the control step is cut there.
  if (containsBackendRun(task)) return "mixed";
  const locations = new Set(
    flowTaskChildLists(task).flatMap((list) =>
      list.tasks.map((child) => unitLocation(flow, child)),
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
    for (const [key, item] of Object.entries(record)) if (key !== "reference") referencesIn(item, found);
  }
  return found;
};

const outputTypes = (steps: readonly FlowTask[]): Record<string, string> =>
  Object.fromEntries(
    steps.flatMap((step) =>
      (registered(step)?.outputs ?? []).map((output) => [`${step.id}.${output.key}`, output.type]),
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
          (producer === undefined ? undefined : outputTypes([producer])[key]) ?? "json";
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
  closed: boolean;
};

const sameGuard = (left: readonly FlowPathCondition[], right: readonly FlowPathCondition[]) =>
  left.length === right.length &&
  left.every(
    (condition, index) =>
      condition.taskId === right[index]!.taskId && condition.branch === right[index]!.branch,
  );

const cut = (flow: FlowDefinition, section: FlowPlanSection, tasks: readonly FlowTask[]) => {
  const drafts: Draft[] = [];
  const emit = (task: FlowTask, location: UnitLocation, guard: readonly FlowPathCondition[]) => {
    const current = drafts.at(-1);
    const kind =
      location === "neutral" ? (current?.kind ?? "server") : (location as "page" | "server");
    if (
      current !== undefined &&
      !current.closed &&
      current.kind === kind &&
      sameGuard(current.guard, guard)
    )
      current.tasks.push(task);
    else drafts.push({ kind, section, guard, tasks: [task], closed: false });
    if (task.type === "backend.run") drafts.at(-1)!.closed = true;
  };
  const walk = (list: readonly FlowTask[], guard: readonly FlowPathCondition[]) => {
    for (const task of list) {
      const location = unitLocation(flow, task);
      if (location !== "mixed") {
        emit(task, location, guard);
        continue;
      }
      switch (task.type) {
        case "if": {
          const node = task as Extract<FlowTask, { type: "if" }>;
          walk(node.then, [
            ...guard,
            { taskId: node.id, kind: "if", branch: "then", condition: node.condition },
          ]);
          if (node.else !== undefined)
            walk(node.else, [
              ...guard,
              { taskId: node.id, kind: "if", branch: "else", condition: node.condition },
            ]);
          break;
        }
        case "switch": {
          const node = task as Extract<FlowTask, { type: "switch" }>;
          for (const entry of node.cases)
            walk(entry.tasks, [
              ...guard,
              {
                taskId: node.id,
                kind: "switch",
                branch: entry.key,
                value: node.value,
                when: entry.when,
              },
            ]);
          if (node.default !== undefined)
            walk(node.default, [
              ...guard,
              { taskId: node.id, kind: "switch", branch: "default", value: node.value },
            ]);
          break;
        }
        case "sequential":
          walk((task as Extract<FlowTask, { type: "sequential" }>).tasks, guard);
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
  walk(tasks, []);
  return drafts;
};

/** Compiles one validated flow into its plan. Throws `FlowPlanError` naming the step it refuses. */
export const compileFlowPlan = (flow: FlowDefinition): FlowPlan => {
  prepareFlowFormulas(flow);
  const drafts = [
    ...cut(flow, "tasks", flow.tasks),
    ...cut(flow, "errors", flow.errors),
    ...cut(flow, "finally", flow.finally),
  ];
  const segments = drafts.map((draft, index): FlowPlanSegment => {
    const id = `${flow.id}:${index}`;
    if (draft.kind === "page")
      return { kind: "page", id, section: draft.section, guard: draft.guard, tasks: draft.tasks };
    const steps = allSteps(draft.tasks);
    const produced = new Set(steps.map((step) => step.id));
    const inputs = inputTypes(flow, [...draft.tasks, ...draft.guard], produced, id);
    const outputs = outputTypes(steps);
    return {
      kind: "server",
      id,
      section: draft.section,
      guard: draft.guard,
      tasks: draft.tasks,
      inputs,
      outputs,
      changes: steps.some((step) => {
        const effect = registered(step)?.effect;
        return effect === "change" || effect === "background_start";
      }),
      setBasedChanges: setBasedChanges(steps),
      endsWithBackendRun: draft.tasks.at(-1)?.type === "backend.run",
      fingerprint: fingerprintCanonicalValue({ tasks: draft.tasks, inputs, outputs }),
      labels: steps.flatMap((step) => {
        const title = registered(step)?.title;
        return title === undefined ? [] : [title];
      }),
    };
  });
  const declared = (record: Readonly<Record<string, { type: string }>>) =>
    Object.fromEntries(Object.entries(record).map(([name, value]) => [name, value.type]));
  return {
    flowId: flow.id,
    definition: flow,
    segments,
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
              labels: segment.labels,
            },
      ),
    },
  };
};

/** Compiles every flow of one release. One flow per identity; an ambiguous release is refused. */
export const compileFlowPlans = (flows: readonly FlowDefinition[]): FlowPlanSet => {
  const plans = new Map<string, FlowPlan>();
  for (const flow of flows) {
    const id = String(flow.id);
    if (plans.has(id)) throw new FlowPlanError(id, undefined, "two flows share one identity");
    plans.set(id, compileFlowPlan(flow));
  }
  return planSet(plans);
};

/** Why a binding's plan cannot run as bound, or undefined. Publication refuses it by name. */
export const flowBindingPlanIssue = (
  plan: FlowPlan,
  binding: Readonly<{ event: string; settings?: Readonly<{ concurrency?: string }> | undefined }>,
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
  application: Readonly<{ content: PlannedContent }>;
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
  Readonly<{ modules: readonly PlannedContent[]; set: FlowPlanSet }>
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
      plans.set(id, compileFlowPlan(flow));
    } catch (error) {
      if (!(error instanceof FlowPlanError)) throw error;
      console.error(`[flows] flow ${id} cannot be planned: ${error.reason}`);
    }
  }
  if (ambiguous.size > 0) throw new Error("FLOW_IDENTITY_AMBIGUOUS");
  const set = planSet(plans);
  releasePlans.set(releaseSet.application.content, { modules, set });
  return set;
};
