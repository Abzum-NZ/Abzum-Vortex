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
import { logFault, logRefusal } from "../access/request-failure";
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
type FieldOptionsFlowOption = z.infer<typeof flowOptionSchema>;

/** The most steps an options flow's read loop takes before the read is refused. */
const maximumReadSteps = 20;

/**
 * `failed`: the flow could not give its options, and the failure was logged, once, where it was
 * found: a flaw of the flow's definition or a run the flow refused here, a refused query read by
 * the query's own line.
 */
type FieldOptionsFlowResult =
  | Readonly<{ kind: "options"; options: readonly FieldOptionsFlowOption[] }>
  | Readonly<{ kind: "failed" }>
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
  const definitionFault = (code: string): FieldOptionsFlowResult => {
    logFault("field-options", `options flow ${flowId}`, code);
    return { kind: "failed" };
  };
  // A link field holds its record as a record type and a record; a flow input names the record.
  const flowInputs = Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => [
      name,
      typeof value === "object" && value !== null && !Array.isArray(value) && "recordId" in value
        ? (value.recordId as JsonValue)
        : value,
    ]),
  );
  let step: FlowRunStep = startFlowRun(
    { runId: ports.runId, flowId, inputs: flowInputs, now: ports.now },
    ports.library,
  );
  for (let reads = 0; ; reads += 1) {
    if (step.kind === "boundary") {
      step = continueFlowRun(step.state, ports.library);
      continue;
    }
    if (step.kind === "finished") {
      if (step.result.status !== "completed") {
        const { outcome, code } = step.result.failure;
        // A run the flow refused (a required input the person has not filled in yet, a refusing
        // rule) is an expected answer; any other end is a fault.
        if (outcome !== "refused" && outcome !== "validation" && outcome !== "conflict")
          return definitionFault(`flow_${code}`);
        logRefusal("field-options", `options flow ${flowId}`, `flow_${code}`);
        return { kind: "failed" };
      }
      const declared = step.result.outputs.options;
      const parsed = flowOptionsSchema.safeParse(declared?.value);
      return parsed.success
        ? { kind: "options", options: parsed.data }
        : definitionFault("output_not_a_list_of_options");
    }
    if (step.kind !== "protected_task" || step.call.effect !== "read" || reads >= maximumReadSteps)
      return definitionFault("step_not_readable");
    const { call } = step;
    if (call.taskType !== "record.query")
      return definitionFault(`step_${call.taskType}_unsupported`);
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
      return definitionFault("query_step_invalid");
    const read = await ports.queryRecords.read(ports.session, ports.selection, {
      queryId: queryId.data,
      parameters: parameters.data,
      pageSize: pageSize.data,
      continuation: "",
    });
    if (read.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
    if (read.kind !== "available" || read.value.outcome !== "read") return { kind: "failed" };
    step = resumeFlowRun(
      step.state,
      {
        kind: "task_result",
        outcome: "completed",
        outputs: {
          records: [...read.value.recordIds],
          rows: [...read.value.rows],
          continuation: read.value.continuation,
        },
      },
      ports.library,
    );
  }
};
