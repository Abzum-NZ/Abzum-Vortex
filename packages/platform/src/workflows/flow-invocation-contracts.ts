import { z } from "zod";
import { containedComponentIdSchema, recordIdSchema, revisionSchema } from "../catalogue/identifiers";
import { flowIdSchema } from "../catalogue/identifiers";
import { jsonValueSchema } from "../catalogue/common";

const entrySegmentsSchema = z.array(z.object({
  segmentId: z.string().min(1).max(200),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict()).max(500);

const runStartInvocationSchema = z
  .object({
    kind: z.literal("run_start"),
    bindingId: containedComponentIdSchema,
    flowId: flowIdSchema,
    clickId: z.uuid(),
    entrySegments: entrySegmentsSchema,
    sourceTablePlacementId: containedComponentIdSchema.optional(),
  })
  .strict();

const bindingInvocationSchema = z
  .object({
    kind: z.literal("binding"),
    bindingId: containedComponentIdSchema,
    flowId: flowIdSchema,
    /** A row form's source table; the gate revalidates it and the subject against that table. */
    sourceTablePlacementId: containedComponentIdSchema.optional(),
    entrySegments: entrySegmentsSchema,
    /** The one server segment of the flow's plan this request runs; the page runner drives the rest. */
    segment: z.object({
      segmentId: z.string().min(1).max(200),
      fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    }).strict(),
    /** One identity per user gesture, so a repeated request for the same click is the same run. */
    clickId: z.uuid(),
    seed: z.record(z.string().min(1).max(300), jsonValueSchema),
    iteration: z.string().min(1).max(200),
    phase: z.enum(["success", "page_failure"]).optional(),
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

/** The one request contract shared by the flow client, endpoint and route. */
export const flowBindingInvocationSchema = z.discriminatedUnion("kind", [
  runStartInvocationSchema,
  bindingInvocationSchema,
]);

export type FlowBindingInvocation = z.input<typeof flowBindingInvocationSchema>;
