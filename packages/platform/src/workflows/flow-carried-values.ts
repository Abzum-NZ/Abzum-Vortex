import "server-only";

import { z } from "zod";
import { jsonValueSchema } from "../catalogue/common";
import { sameId } from "../catalogue/runtime-primitives";
import type { QueryContinuationKey } from "../queries/continuation-token";
import { openToken, sealToken } from "../queries/sealed-token";
import { typedValueMatchesType } from "../rules/condition-types";
import type { FlowRuntimeValue } from "../rules/flow-formula";
import type { FlowServerSegment } from "./flow-plan";

const purpose = "vortex.flow.carried-values.v1";
const maximumTokenLength = 65_536;
const identitySchema = z.object({
  flowId: z.uuid(),
  bindingId: z.uuid(),
  runId: z.uuid(),
  identityId: z.uuid(),
  organizationId: z.uuid(),
  applicationRootId: z.uuid(),
}).strict();
const payloadSchema = identitySchema.extend({
  values: z.record(z.string().min(1).max(300), z.object({
    type: z.string().min(1).max(100),
    value: jsonValueSchema,
  }).strict()),
}).strict();

type CarryIdentity = z.infer<typeof identitySchema>;
type CarryValues = Readonly<Record<string, FlowRuntimeValue>>;
type CarryActor = Omit<CarryIdentity, "runId">;

class FlowCarriedValuesError extends Error {
  constructor() {
    super("vortex.flow.carried_values_invalid");
    this.name = "FlowCarriedValuesError";
  }
}

/** Open an opaque run-bound token and validate each read declared by the segment. */
export const openFlowCarriedValues = (
  token: string | undefined,
  key: QueryContinuationKey,
  identity: CarryActor,
  segment: FlowServerSegment,
): Readonly<{ runId?: string; values: CarryValues }> => {
  let values: CarryValues = {};
  let runId: string | undefined;
  if (token !== undefined) {
    if (token.length > maximumTokenLength) throw new FlowCarriedValuesError();
    const opened = openToken(key, purpose, token);
    if (opened.kind !== "opened") throw new FlowCarriedValuesError();
    const parsed = payloadSchema.safeParse(opened.payload);
    if (!parsed.success || Object.keys(identity).some((name) =>
      !sameId(identity[name as keyof CarryActor], parsed.data[name as keyof CarryActor]),
    )) throw new FlowCarriedValuesError();
    values = parsed.data.values;
    runId = parsed.data.runId;
  }
  for (const [name, type] of Object.entries(segment.carriedInputs)) {
    const value = values[name];
    if (value !== undefined && (value.type !== type ||
      (value.value !== null && !typedValueMatchesType(value.value, type, "flow"))))
      throw new FlowCarriedValuesError();
  }
  return { values, ...(runId === undefined ? {} : { runId }) };
};

/** Keep only values needed after this segment and add its new server-only outputs. */
export const sealFlowCarriedValues = (
  previous: CarryValues,
  produced: CarryValues,
  key: QueryContinuationKey,
  identity: CarryIdentity,
  segment: FlowServerSegment | undefined,
  includeRunId: boolean,
): string | undefined => {
  const values: Record<string, FlowRuntimeValue> = Object.create(null);
  for (const name of segment?.carriedRetainKeys ?? []) {
    if (previous[name] !== undefined) values[name] = previous[name]!;
  }
  for (const [name, value] of Object.entries(produced)) {
    const type = segment?.carriedOutputs[name];
    if (type === undefined || value.type !== type ||
      (value.value !== null && !typedValueMatchesType(value.value, type, "flow")))
      throw new FlowCarriedValuesError();
    values[name] = value;
  }
  if (!includeRunId && Object.keys(values).length === 0) return undefined;
  const token = sealToken(key, purpose, payloadSchema.parse({ ...identity, values }));
  if (token.length > maximumTokenLength) throw new FlowCarriedValuesError();
  return token;
};
