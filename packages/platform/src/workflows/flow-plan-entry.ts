import type { FlowTask } from "./flow-contracts";
import type { FlowPlan, FlowServerSegment } from "./flow-plan";

/** Every server segment a caller may start, in plan order. */
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
      const reached = combine([
        ...branch.cases.map((entry) => list(entry.tasks)),
        list(branch.default ?? []),
      ]);
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
  const failureBeforeFinally =
    errors !== undefined && (errors.falls || errors.stops || errors.pageFailure);
  const final =
    successBeforeFinally || failureBeforeFinally ? list(plan.definition.finally) : undefined;
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
