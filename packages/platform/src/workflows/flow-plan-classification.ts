import { fingerprintCanonicalValue } from "../definition/canonical-json-definition";
import { flowTaskChildLists, type FlowDefinition, type FlowTask } from "./flow-contracts";
import type { FlowReference, FlowValue } from "./flow-values";
import type { FlowPlanSegment, FlowServerSegment } from "./flow-plan";

type References = (value: unknown) => FlowReference[];

const stepsOf = (tasks: readonly FlowTask[]): FlowTask[] =>
  tasks.flatMap((task) => [task, ...flowTaskChildLists(task).flatMap((child) => stepsOf(child.tasks))]);

const keyOf = (reference: FlowReference): string | undefined => {
  if (reference.source === "variable") return `vars.${reference.name}`;
  if (reference.source === "task_output") return `outputs.${reference.task}.${reference.key}`;
  return undefined;
};

/** Classifies explicit handoffs once for all bindings of a flow. */
export const classifyFlowSegments = (
  flow: FlowDefinition,
  original: readonly FlowPlanSegment[],
  references: References,
  serverOnly: (reference: FlowReference) => boolean,
  inputTypes: (values: readonly unknown[], produced: ReadonlySet<string>, id: string) => Record<string, string>,
  lookupFlow: (id: string) => FlowDefinition | undefined,
): FlowPlanSegment[] => {
  const completionExpressions = Object.fromEntries(
    (flow.execution === "interactive" ? Object.entries(flow.outputs) : [])
      .filter(([, output]) => references(output.value).some(serverOnly))
      .map(([name, output]) => [name, output.value]),
  ) as Record<string, FlowValue>;
  const segments = [...original];
  if (Object.keys(completionExpressions).length > 0) {
    const id = `${flow.id}:${segments.length}`;
    const finalOutputTypes = Object.fromEntries(
      Object.keys(completionExpressions).map((name) => [name, flow.outputs[name]!.type]),
    );
    const inputs = inputTypes(Object.values(completionExpressions), new Set(), id);
    const completion: FlowServerSegment = {
      kind: "server", id, section: "finally", guard: [], tasks: [], firstTaskPath: [],
      inputs, outputs: {}, outputMembers: {}, carriedInputs: {}, carriedOutputs: {},
      carriedRetainKeys: [], finalOutputExpressions: completionExpressions, finalOutputTypes,
      changes: false, accessChange: false, multiTransaction: false, preScopeLock: null,
      setBasedChanges: [], endsWithBackendRun: false,
      fingerprint: fingerprintCanonicalValue({ section: "finally", tasks: [], inputs, finalOutputExpressions: completionExpressions, finalOutputTypes }),
      labels: [],
    };
    segments.push(completion);
  }
  const pageReads = new Set(references([
    ...segments.flatMap((segment) => [segment.guard, ...(segment.kind === "page" ? [segment.tasks] : [])]),
    ...Object.values(flow.outputs).map((output) => output.value),
  ]).flatMap((reference) => { const key = keyOf(reference); return key === undefined ? [] : [key]; }));
  const allTasks = stepsOf([...flow.tasks, ...flow.errors, ...flow.finally]);
  const childOutputType = (name: string): string | undefined => {
    const parts = name.split(".");
    if (parts[0] !== "outputs" || parts.length !== 3) return undefined;
    const task = allTasks.find((candidate) => candidate.id === parts[1]);
    if (task?.type !== "run_flow") return undefined;
    const child = lookupFlow(String((task as Extract<FlowTask, { type: "run_flow" }>).flowId));
    return child?.outputs[parts[2]!]?.type;
  };
  const writes = segments.map((segment) => {
    if (segment.kind !== "server") return {} as Record<string, string>;
    const result: Record<string, string> = { ...segment.outputs };
    for (const task of stepsOf(segment.tasks)) {
      if (task.type === "run_flow") {
        const child = lookupFlow(String((task as Extract<FlowTask, { type: "run_flow" }>).flowId));
        for (const [name, declaration] of Object.entries(child?.outputs ?? {}))
          result[`outputs.${task.id}.${name}`] = declaration.type;
      }
      if (task.type !== "data.set_variable" || !("properties" in task)) continue;
      const name = task.properties.variable;
      const names = name?.kind === "literal" && typeof name.literal.value === "string"
        ? [name.literal.value] : Object.keys(flow.variables);
      for (const variable of names) {
        const declaration = flow.variables[variable];
        if (declaration !== undefined) result[`vars.${variable}`] = declaration.type;
      }
    }
    return result;
  });
  const reads = segments.map((segment, index) => {
    if (segment.kind !== "server") return new Set<string>();
    return new Set([...Object.keys(segment.inputs), ...Object.keys(writes[index]!).filter((name) => name.startsWith("vars."))].filter((name) => name.startsWith("vars.") || name.startsWith("outputs.")));
  });
  return segments.map((segment, index): FlowPlanSegment => {
    if (segment.kind !== "server") return segment;
    const inputs: Record<string, string> = { ...segment.inputs };
    for (const name of Object.keys(inputs)) inputs[name] = childOutputType(name) ?? inputs[name]!;
    // A conditional variable write retains the previous value even if this segment has no explicit read.
    for (const [name, type] of Object.entries(writes[index]!))
      if (name.startsWith("vars.")) inputs[name] ??= type;
    const outputs: Record<string, string> = {};
    const carriedOutputs: Record<string, string> = {};
    const carriedInputs: Record<string, string> = {};
    for (const [name, type] of Object.entries(writes[index]!)) {
      if (pageReads.has(name)) outputs[name] = type;
      else if (reads.slice(index + 1).some((set) => set.has(name))) carriedOutputs[name] = type;
    }
    for (const [name, type] of Object.entries(inputs)) {
      if (pageReads.has(name)) continue;
      if (name.startsWith("vars.") || writes.slice(0, index).some((part) => Object.hasOwn(part, name))) carriedInputs[name] = type;
    }
    const carriedRetainKeys = [...new Set(
      writes.slice(0, index).flatMap((part) => Object.keys(part)).filter((name) =>
        !pageReads.has(name) && reads.slice(index + 1).some((set) => set.has(name))),
    )];
    const fingerprint = fingerprintCanonicalValue({
      base: segment.fingerprint, inputs, outputs, carriedInputs, carriedOutputs, carriedRetainKeys,
      finalOutputExpressions: segment.finalOutputExpressions, finalOutputTypes: segment.finalOutputTypes,
    });
    return { ...segment, inputs, outputs, carriedInputs, carriedOutputs, carriedRetainKeys, fingerprint };
  });
};
