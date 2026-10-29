import { flowOperationOutputMembers } from "../workflows/flow-operation-output-members";
import {
  resumeFlowRun as resumeCore,
  startFlowRun as startCore,
  type FlowLibrary,
  type FlowOutputMemberTypeResolver,
  type FlowRunResume,
  type FlowRunStart,
  type FlowRunState,
  type FlowTaskTraceObserver,
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
) => startCore(start, library, serverOutputMemberType, observer);

export const resumeFlowRun = (
  previous: FlowRunState,
  resume: FlowRunResume,
  library: FlowLibrary,
  observer?: FlowTaskTraceObserver,
) => resumeCore(previous, resume, library, serverOutputMemberType, observer);
