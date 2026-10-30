import "server-only";

import { z } from "zod";
import type { JsonValue } from "../catalogue/common";
import {
  builderKeySchema,
  queryIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
} from "../catalogue/identifiers";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import { jsonValueSchema } from "../catalogue/common";
import {
  continueFlowRun,
  resumeFlowRun,
  startFlowRun,
  type FlowLibrary,
  type FlowRunStep,
} from "../rules/flow-interpreter";
import type { FlowOrchestratorDependencies } from "./flow-orchestrator-types";

/** One option an options flow returns: a choice key or a record reference, and its label. */
const flowOptionSchema = z
  .object({
    value: z.union([
      z.string().min(1).max(120),
      z.object({ recordTypeId: recordTypeIdSchema, recordId: recordIdSchema }).strict(),
    ]),
    label: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
  })
  .strict();
const flowOptionsSchema = z.array(flowOptionSchema).max(200);
export type FieldOptionsFlowOption = z.infer<typeof flowOptionSchema>;

/** The most steps an options flow's read loop takes before the read is refused. */
const maximumReadSteps = 20;

export type FieldOptionsFlowResult =
  | Readonly<{ kind: "options"; options: readonly FieldOptionsFlowOption[] }>
  | Readonly<{ kind: "failed"; reason: string }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/**
 * Runs one options flow with the one flow interpreter and returns the options it declares as its
 * `options` output. The flow holds only pure and read steps (publication refuses any other): a
 * `record.query` read runs under the viewer's own access through the query port; any other server
 * step ends the run as failed. Nothing is written and nothing is kept.
 */
export const runFieldOptionsFlow = async (
  ports: Readonly<{
    library: FlowLibrary;
    queryRecords: NonNullable<FlowOrchestratorDependencies["queryRecords"]>;
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    now: string;
    runId: string;
  }>,
  flowId: string,
  inputs: Readonly<Record<string, JsonValue>>,
): Promise<FieldOptionsFlowResult> => {
  let step: FlowRunStep = startFlowRun(
    { runId: ports.runId, flowId, inputs, now: ports.now },
    ports.library,
  );
  for (let reads = 0; ; reads += 1) {
    if (step.kind === "boundary") {
      step = continueFlowRun(step.state, ports.library);
      continue;
    }
    if (step.kind === "finished") {
      if (step.result.status !== "completed")
        return { kind: "failed", reason: `options flow ${step.result.failure.code}` };
      const declared = step.result.outputs.options;
      const parsed = flowOptionsSchema.safeParse(declared?.value);
      return parsed.success
        ? { kind: "options", options: parsed.data }
        : { kind: "failed", reason: "options flow output 'options' is not a list of options" };
    }
    if (step.kind !== "protected_task" || step.call.effect !== "read" || reads >= maximumReadSteps)
      return { kind: "failed", reason: "options flow holds a step an options read cannot run" };
    const { call } = step;
    if (call.taskType !== "record.query")
      return {
        kind: "failed",
        reason: `options flow step ${call.taskType} cannot run in an options read`,
      };
    const queryId = queryIdSchema.safeParse(call.properties.query?.value);
    const parameters = z
      .record(builderKeySchema, jsonValueSchema)
      .safeParse(call.properties.parameters?.value ?? {});
    const pageSize = z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .safeParse(call.properties.page_size?.value);
    if (!queryId.success || !parameters.success || !pageSize.success)
      return { kind: "failed", reason: "options flow query step is invalid" };
    const read = await ports.queryRecords.read(ports.session, ports.selection, {
      queryId: queryId.data,
      parameters: parameters.data,
      pageSize: pageSize.data,
      continuation: "",
    });
    if (read.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
    if (read.kind !== "available" || read.value.outcome !== "read")
      return { kind: "failed", reason: "options flow query is unavailable" };
    step = resumeFlowRun(
      step.state,
      {
        kind: "task_result",
        outcome: "completed",
        outputs: { records: [...read.value.recordIds], continuation: read.value.continuation },
      },
      ports.library,
    );
  }
};
