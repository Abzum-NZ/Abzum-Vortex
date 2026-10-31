import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "../catalogue/common";
import { builderKeySchema, queryIdSchema, recordIdSchema } from "../catalogue/identifiers";
import type { FlowTaskOutcome } from "../rules/flow-interpreter";
import { reportUnexpectedFailure } from "./definition-error";
import { carriesSensitive, requestOutcome } from "./flow-orchestrator-support";
import type { FlowOrchestratorDependencies, Run } from "./flow-orchestrator-types";

/** A query step reads at most one keyset page: the flow's page size, 1 to 200, when it names one. */
const queryPageSizeSchema = z.number().int().min(1).max(200).optional();

/** The table's sealed "every matching record" token and the records left out of it. */
const matchingSchema = z
  .object({
    token: z.string().min(16).max(65_536),
    excluded: z.array(recordIdSchema).max(10_000),
  })
  .strict();

/** How the task ended, in the runner's own terms (an outcome, and the page it read). */
type QueryTaskResult = Readonly<{
  outcome: FlowTaskOutcome;
  outputs?: Record<string, JsonValue>;
}>;

/**
 * Reads one bounded page of a declared query under the run's current authority: the query's own
 * rows, or, given a table's sealed selection, the rows that table's filters and search match now.
 */
export const runQueryTask = async (
  queryRecords: NonNullable<FlowOrchestratorDependencies["queryRecords"]>,
  run: Run,
  properties: Readonly<Record<string, { value?: unknown } | undefined>>,
): Promise<QueryTaskResult> => {
  const queryId = queryIdSchema.safeParse(properties.query?.value);
  const parameters = z
    .record(builderKeySchema, jsonValueSchema)
    .safeParse(properties.parameters?.value ?? {});
  const pageSize = queryPageSizeSchema.safeParse(properties.page_size?.value);
  const continuation = z
    .string()
    .max(65_536)
    .safeParse(properties.continuation?.value ?? "");
  const matching = Object.hasOwn(properties, "selection")
    ? matchingSchema.safeParse({
        token: properties.selection?.value,
        excluded: properties.excluded?.value ?? [],
      })
    : undefined;
  if (
    !queryId.success ||
    !parameters.success ||
    !pageSize.success ||
    !continuation.success ||
    matching?.success === false ||
    carriesSensitive(parameters.data, run.sensitive)
  )
    return { outcome: "validation" };
  try {
    const result = await queryRecords.read(run.authority.session, run.authority.selection, {
      queryId: queryId.data,
      parameters: parameters.data,
      pageSize: pageSize.data,
      continuation: continuation.data,
      ...(matching === undefined ? {} : { matching: matching.data }),
    });
    if (result.kind !== "available") return { outcome: requestOutcome(result.kind) };
    if (result.value.outcome !== "read") return { outcome: "refused" };
    return {
      outcome: "completed",
      outputs: {
        records: [...result.value.recordIds],
        rows: [...result.value.rows],
        continuation: result.value.continuation,
      },
    };
  } catch (error) {
    reportUnexpectedFailure("record query task", error);
    return { outcome: "failed" };
  }
};
