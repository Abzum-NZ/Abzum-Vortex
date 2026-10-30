import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "../catalogue/common";
import { flowIdSchema } from "../catalogue/identifiers";
import type { FlowProtectedTaskCall, FlowTaskOutcome } from "../rules/flow-interpreter";
import { carriesSensitive } from "./flow-orchestrator-support";
import type { FlowOrchestratorDependencies, Run } from "./flow-orchestrator-types";

/** A Run on back end task, checked and ready to hand to the back-end adapter. */
export type BackendTaskPlan = Readonly<{
  kind: "backend";
  flowId: string;
  mode: "await" | "start";
  inputs: Readonly<Record<string, JsonValue>>;
  commandId: string;
}>;

/** Reads the task's flow, mode and inputs; undefined when any of them is not valid. */
export const planBackendTask = (
  call: FlowProtectedTaskCall,
  run: Run,
  commandId: string,
): BackendTaskPlan | undefined => {
  const flowId = flowIdSchema.safeParse(call.properties.flow?.value);
  const mode = z.enum(["await", "start"]).safeParse(call.properties.mode?.value);
  const inputs = z
    .record(z.string(), jsonValueSchema)
    .safeParse(call.properties.inputs?.value ?? {});
  if (
    !flowId.success ||
    !mode.success ||
    !inputs.success ||
    carriesSensitive(inputs.data, run.sensitive)
  )
    return undefined;
  return {
    kind: "backend",
    flowId: flowId.data,
    mode: mode.data,
    inputs: inputs.data,
    commandId,
  };
};

/**
 * Hands the child flow to the back-end adapter, once per command: a repeat returns the first run.
 * `await` returns the child's outputs; `start` returns its reference and the child runs after the
 * reply.
 */
export const runBackendTask = async (
  dependencies: FlowOrchestratorDependencies,
  run: Run,
  plan: BackendTaskPlan,
  taskId: string,
): Promise<{
  result: { outcome: FlowTaskOutcome; outputs?: Record<string, JsonValue> };
  stored: Record<string, JsonValue>;
}> => {
  const { session, selection } = run.authority;
  const actorId =
    run.authority.kind === "actor"
      ? run.authority.actorId
      : await dependencies.resolveActor?.(session, selection);
  if (
    actorId === undefined ||
    dependencies.backend === undefined ||
    selection.applicationRootId === undefined
  )
    return { result: { outcome: "failed" }, stored: {} };
  const started = await dependencies.backend.run({
    organizationId: selection.organizationId,
    applicationRootId: selection.applicationRootId,
    actorId,
    flowId: plan.flowId,
    origin: "backend_run",
    sourceKey: plan.commandId,
    mode: plan.mode,
    inputs: plan.inputs,
  });
  if (started.kind === "unavailable") return { result: { outcome: "uncertain" }, stored: {} };
  if (started.kind === "not_finished") {
    console.error(
      `[flows] back-end run ${started.backendRunId} of task ${taskId} ${started.state}: ${started.failureCode}`,
    );
    return {
      result: { outcome: started.state === "refused" ? "refused" : "failed" },
      stored: {},
    };
  }
  const outputs: Record<string, JsonValue> =
    started.kind === "finished"
      ? { run: started.backendRunId, outputs: started.outputs }
      : { run: started.backendRunId };
  return {
    result: {
      outcome: started.kind === "finished" ? "completed" : "background_pending",
      outputs,
    },
    stored: outputs,
  };
};
