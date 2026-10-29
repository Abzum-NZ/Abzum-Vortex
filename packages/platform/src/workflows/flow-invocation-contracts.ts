import { z } from "zod";
import { formContinuationReceiptSchema, formContinuationTargetSchema } from "./form-continuation-contracts";
import { formContinuationAnswerSchema } from "./form-continuation-answer";
import { containedComponentIdSchema, recordIdSchema, revisionSchema } from "../catalogue/identifiers";
import { flowIdSchema } from "../catalogue/identifiers";
import { jsonValueSchema } from "../catalogue/common";

const installationRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const runStartInvocationSchema = z
  .object({
    kind: z.literal("run_start"),
    installationRevision: installationRevisionSchema,
    bindingId: containedComponentIdSchema,
    flowId: flowIdSchema,
    clickId: z.uuid(),
    sourceTablePlacementId: containedComponentIdSchema.optional(),
  })
  .strict();

const bindingInvocationSchema = z
  .object({
    kind: z.literal("binding"),
    installationRevision: installationRevisionSchema,
    bindingId: containedComponentIdSchema,
    flowId: flowIdSchema,
    /** A row form's source table; the gate revalidates it and the subject against that table. */
    sourceTablePlacementId: containedComponentIdSchema.optional(),
    entrySegments: z.array(z.object({
      segmentId: z.string().min(1).max(200),
      fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    }).strict()).max(500),
    segment: z.object({
      segmentId: z.string().min(1).max(200),
      fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    }).strict().optional(),
    /** One identity per user gesture, so a repeated request for the same click is the same run. */
    clickId: z.uuid(),
    seed: z.record(z.string().min(1).max(300), jsonValueSchema),
    iteration: z.string().min(1).max(200),
    carriedValues: z.string().min(1).max(65_536).optional(),
    /** The values the surface itself supplies, by the name of the binding's `caller` input. */
    callerInputs: z.record(z.string().min(1).max(100), z.unknown()).default({}),
    /** The record the surface was rendered for and the revision it showed (evidence only). */
    subject: z
      .object({
        recordId: recordIdSchema,
        revision: revisionSchema.max(Number.MAX_SAFE_INTEGER - 1),
      })
      .strict()
      .optional(),
  })
  .strict();

const continuationInvocationSchema = z
  .object({
    kind: z.literal("continuation"),
    installationRevision: installationRevisionSchema,
    flowId: flowIdSchema,
    /** The row form's source table, supplied by the page and revalidated by the gate. */
    sourceTablePlacementId: containedComponentIdSchema.optional(),
    continuation: z.string().min(16).max(128),
    carriedValues: z.string().min(1).max(65_536).optional(),
    answer: formContinuationAnswerSchema,
    /**
     * The exact paused target and run receipt the surface last saw. Both are evidence: the server
     * compares them with trusted state so a caller cannot skip inputs or name a different node.
     */
    target: formContinuationTargetSchema.optional(),
    receipt: formContinuationReceiptSchema.optional(),
  })
  .strict();

/** The one request contract shared by the flow client, endpoint and route. */
export const flowBindingInvocationSchema = z.discriminatedUnion("kind", [
  runStartInvocationSchema,
  bindingInvocationSchema,
  continuationInvocationSchema,
]);

export type FlowBindingInvocation = z.input<typeof flowBindingInvocationSchema>;
