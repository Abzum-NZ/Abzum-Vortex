import type { TypedFieldValue } from "@vortex/platform/schema";
import type { AgentGesture } from "../agent/page-driver";

/** The flow/component pairs already visited by one field-change cycle. */
export type FlowEventCycle = Readonly<{
  depth: number;
  visited: readonly Readonly<{ flowId: string; controlId: string }>[];
  /** The agent gesture that started the cycle: every run in it is the agent's. */
  agent?: AgentGesture;
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
    cycle: {
      depth: previous.depth + 1,
      visited: [...previous.visited, { flowId, controlId }],
      ...(previous.agent === undefined ? {} : { agent: previous.agent }),
    },
  };
};

/** Who sets a field's value: a flow step continues its cycle; an agent acts as the person. */
export type FieldWriteCause = FlowEventCycle | "agent";

/**
 * The one event a field emits after its value is set from outside a keystroke: a flow-set change
 * carries its cycle, and an agent's change is the person's own, settled at once.
 */
export const setFieldChange = (cause: FieldWriteCause, fieldKey: string, value: TypedFieldValue) =>
  cause === "agent"
    ? {
        event: "field_changed" as const,
        fieldKey,
        value,
        origin: "user" as const,
        depth: 0,
        immediate: true,
      }
    : {
        event: "field_changed" as const,
        fieldKey,
        value,
        origin: "flow" as const,
        depth: cause.depth + 1,
        immediate: true,
        cycle: cause,
      };
