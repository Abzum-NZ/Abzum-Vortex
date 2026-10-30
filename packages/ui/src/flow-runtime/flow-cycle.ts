import type { TypedFieldValue } from "@vortex/platform/schema";

/** The flow/component pairs already visited by one field-change cycle. */
export type FlowEventCycle = Readonly<{
  depth: number;
  visited: readonly Readonly<{ flowId: string; controlId: string }>[];
}>;

export type FlowCycleRefusal = "flow_reentry" | "depth_limit";

export const startFlowEventCycle = (flowId: string, controlId: string): FlowEventCycle => ({
  depth: 0,
  visited: [{ flowId, controlId }],
});

/** Adds the next flow, refusing a repeated pair or more than three flow-set levels. */
export const continueFlowEventCycle = (
  previous: FlowEventCycle,
  flowId: string,
  controlId: string,
): Readonly<{ cycle: FlowEventCycle }> | Readonly<{ reason: FlowCycleRefusal }> => {
  if (previous.depth >= 3) return { reason: "depth_limit" };
  if (
    previous.visited.some(
      (entry) =>
        entry.flowId.toLowerCase() === flowId.toLowerCase() &&
        entry.controlId.toLowerCase() === controlId.toLowerCase(),
    )
  )
    return { reason: "flow_reentry" };
  return {
    cycle: { depth: previous.depth + 1, visited: [...previous.visited, { flowId, controlId }] },
  };
};

/** The one event a flow emits after it sets a field. */
export const flowSetFieldChange = (
  cycle: FlowEventCycle,
  fieldKey: string,
  value: TypedFieldValue,
) => ({
  event: "field_changed" as const,
  fieldKey,
  value,
  origin: "flow" as const,
  depth: cycle.depth + 1,
  immediate: true,
  cycle,
});
