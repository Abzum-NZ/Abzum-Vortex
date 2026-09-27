import { z } from "zod";
import {
  formContinuationAnswerSchema,
  formContinuationReceiptSchema,
  formContinuationTargetSchema,
} from "./form-continuation-contracts";
import { flowIdSchema } from "./flow-contracts";
import { containedComponentIdSchema, recordIdSchema, revisionSchema } from "./identifiers";

const installationRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const releaseKeySchema = z.string().min(1).max(200);

const bindingInvocationSchema = z
  .object({
    kind: z.literal("binding"),
    installationRevision: installationRevisionSchema,
    releaseKey: releaseKeySchema,
    bindingId: containedComponentIdSchema,
    flowId: flowIdSchema,
    /** One identity per user gesture, so a repeated request for the same click is the same run. */
    clickId: z.uuid(),
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
    releaseKey: releaseKeySchema,
    flowId: flowIdSchema,
    continuation: z.string().min(16).max(128),
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
  bindingInvocationSchema,
  continuationInvocationSchema,
]);

export type FlowBindingInvocation = z.input<typeof flowBindingInvocationSchema>;
