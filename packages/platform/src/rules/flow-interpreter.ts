import { parseFlowSegmentSeed } from "./flow-segment-seed";
import type { FlowPlan, FlowServerSegment } from "../workflows/flow-plan";
import type { FlowValue } from "../workflows/flow-values";
import { flowOperationOutputMembers } from "../workflows/flow-operation-output-members";
import {
  resumeFlowRun as resumeCore,
  startFlowSegment as segmentCore,
  continueFlowRun as continueCore,
  evaluateFlowValue as evaluateCore,
  startFlowRun as startCore,
  type FlowLibrary,
  type FlowOutputMemberTypeResolver,
  type FlowRunResume,
  type FlowRunStart,
  type FlowRunState,
  type FlowTaskTraceObserver,
  type FlowSegmentReplay,
} from "./flow-interpreter-core";

export * from "./flow-interpreter-core";

/** The server resolves operation output types from its protected operation catalogue. */
const serverOutputMemberType: FlowOutputMemberTypeResolver = (task, _taskId, outputKey, path) => {
  if (task?.type !== "operation.call" || outputKey !== "result" || path.length !== 1)
    return undefined;
  const members = flowOperationOutputMembers(task);
  return Object.hasOwn(members, path[0]!) ? members[path[0]!] : undefined;
};

export const startFlowRun = (
  start: FlowRunStart,
  library: FlowLibrary,
  observer?: FlowTaskTraceObserver,
  boundaryBefore?: ReadonlySet<string>,
) => startCore(start, library, serverOutputMemberType, observer, undefined, boundaryBefore);

export const resumeFlowRun = (
  previous: FlowRunState,
  resume: FlowRunResume,
  library: FlowLibrary,
  observer?: FlowTaskTraceObserver,
  segment?: FlowServerSegment,
  replay?: FlowSegmentReplay,
  boundaryBefore?: ReadonlySet<string>,
) =>
  resumeCore(
    previous,
    resume,
    library,
    serverOutputMemberType,
    observer,
    undefined,
    segment,
    replay,
    boundaryBefore,
  );

export const startFlowSegment = (
  plan: FlowPlan,
  segmentId: string,
  start: FlowRunStart,
  seed: Readonly<Record<string, unknown>>,
  library: FlowLibrary,
  replay?: FlowSegmentReplay,
) =>
  segmentCore(
    plan,
    segmentId,
    start,
    seed,
    library,
    serverOutputMemberType,
    parseFlowSegmentSeed,
    replay,
  );

export const continueFlowRun = (
  previous: FlowRunState,
  library: FlowLibrary,
  segment?: FlowServerSegment,
  replay?: FlowSegmentReplay,
  boundaryBefore?: ReadonlySet<string>,
  observer?: FlowTaskTraceObserver,
) =>
  continueCore(
    previous,
    library,
    serverOutputMemberType,
    undefined,
    segment,
    replay,
    boundaryBefore,
    observer,
  );

export const evaluateFlowValue = (
  flow: NonNullable<ReturnType<FlowLibrary>>,
  value: FlowValue,
  start: FlowRunStart,
) => evaluateCore(flow, value, start, serverOutputMemberType);
