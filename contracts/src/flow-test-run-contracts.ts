import { z } from "zod";
import { jsonValueSchema } from "./common";
import { flowIdSchema } from "./flow-contracts";
import { formContinuationIntentSchema } from "./form-continuation-contracts";
import { builderKeySchema } from "./identifiers";

const previewInstallationIdSchema = z
  .uuid()
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000");

export const flowTestRunRequestSchema = z
  .object({
    previewInstallationId: previewInstallationIdSchema,
    flowId: flowIdSchema,
    sampleInputs: z.record(builderKeySchema, jsonValueSchema).default({}),
  })
  .strict();

export const flowTestRunFailureSchema = z
  .object({
    outcome: z.enum(["refused", "conflict", "validation", "uncertain", "failed"]),
    code: z.string().min(1).max(120),
    taskId: builderKeySchema.optional(),
  })
  .strict();

export const flowTestRunResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      outputs: z.record(builderKeySchema, jsonValueSchema),
      stopped: builderKeySchema.optional(),
    })
    .strict(),
  z.object({ status: z.literal("failed"), failure: flowTestRunFailureSchema }).strict(),
]);

export const flowTestRunTaskOutcomeSchema = z.enum([
  "completed",
  "committed",
  "background_pending",
  "refused",
  "conflict",
  "validation",
  "uncertain",
  "failed",
  "simulated",
]);

export const flowTestRunTaskTraceEntrySchema = z
  .object({
    flowId: flowIdSchema,
    taskId: builderKeySchema,
    taskType: z.string().min(1).max(200),
    iteration: z.string().min(1).max(200),
    outcome: flowTestRunTaskOutcomeSchema,
    failure: flowTestRunFailureSchema.optional(),
    intent: formContinuationIntentSchema.optional(),
  })
  .strict();

export const flowTestRunRefusalSchema = z
  .object({
    kind: z.literal("refused"),
    reason: z.enum([
      "invalid_request",
      "preview_unavailable",
      "preview_expired",
      "flow_unavailable",
      "flow_not_runnable",
      "flow_not_authorized",
      "server_time_limit",
    ]),
    location: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("preview") }).strict(),
      z.object({ kind: z.literal("flow"), flowId: flowIdSchema }).strict(),
    ]),
  })
  .strict();

export const flowTestRunResponseSchema = z.discriminatedUnion("kind", [
  flowTestRunRefusalSchema,
  z
    .object({
      kind: z.literal("finished"),
      runId: z.uuid(),
      flowId: flowIdSchema,
      result: flowTestRunResultSchema,
      trace: z.array(flowTestRunTaskTraceEntrySchema).max(10_000),
      intents: z.array(formContinuationIntentSchema).max(10_000),
    })
    .strict(),
]);

export type FlowTestRunRequest = z.input<typeof flowTestRunRequestSchema>;
export type FlowTestRunFailure = z.infer<typeof flowTestRunFailureSchema>;
export type FlowTestRunResult = z.infer<typeof flowTestRunResultSchema>;
export type FlowTestRunTaskOutcome = z.infer<typeof flowTestRunTaskOutcomeSchema>;
export type FlowTestRunTaskTraceEntry = z.infer<typeof flowTestRunTaskTraceEntrySchema>;
export type FlowTestRunResponse = z.infer<typeof flowTestRunResponseSchema>;
