import { z } from "zod";
import {
  safeFlowResultDescriptorSchema,
  safeFlowResultKindSchema,
} from "./application-flow-bindings";
import { jsonValueSchema } from "./common";
import { flowIdSchema } from "./flow-contracts";
import type { IdentitySession, OrganizationSelectionCandidate } from "./identity-access";
import {
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  platformIdSchema,
  revisionSchema,
} from "./identifiers";

/**
 * The web-independent form request and continuation contract of an interactive flow (#544).
 *
 * The flow orchestrator (App) implements `FormContinuationService`; the web page layer, an MCP
 * client or any future client calls it through dependency injection, so App never imports Page and
 * every client receives the same result contract. A caller supplies EVIDENCE about what it last saw:
 * the exact installation, release, form, flow and node, the private draft revision it answers from
 * and the receipt of the run so far. Evidence is only ever compared with trusted server state and is
 * never authority: the actor, organisation, permissions and the run itself come from the verified
 * session and the server-stored continuation, never from these values.
 */
export const formContinuationContractVersion = "1.0.0" as const;

const maximumAnswerValues = 500;

/** The exact installed application release an answer was prepared against. */
export const formContinuationInstallationSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    installationReleaseRevision: revisionSchema,
  })
  .strict();

/**
 * The exact paused task: the installation, the release of the flow set the run is bound to (an
 * opaque value issued by the server), the flow and node (task id) it is paused at and, for a form,
 * the form the node shows.
 */
export const formContinuationTargetSchema = z
  .object({
    installation: formContinuationInstallationSchema,
    releaseKey: z.string().min(1).max(512),
    flowId: flowIdSchema,
    nodeId: builderKeySchema,
    awaiting: z.enum(["form", "confirm"]),
    formId: containedComponentIdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.awaiting === "form") !== (value.formId !== undefined))
      context.addIssue({
        code: "custom",
        path: ["formId"],
        message: "Exactly a form node names its form",
      });
  });

/**
 * The receipt of the run so far: which run, and how many protected effects it has committed. The
 * server issues it with every result; a caller returns it so a stale or forged one is refused
 * instead of being trusted.
 */
export const formContinuationReceiptSchema = z
  .object({
    runId: z.uuid(),
    committedEffects: z.number().int().min(0).max(100),
  })
  .strict();

/** The private draft revision an answer was made from (#587); the draft itself stays with Page. */
export const formContinuationDraftEvidenceSchema = z
  .object({ draftId: platformIdSchema, revision: revisionSchema })
  .strict();

export const formContinuationAnswerSchema = z.discriminatedUnion("kind", [
  /** Continue or submit the form with its permitted answers. */
  z
    .object({
      kind: z.literal("submit"),
      values: z
        .record(z.string().min(1).max(200), jsonValueSchema)
        .refine((values) => Object.keys(values).length <= maximumAnswerValues, {
          message: "A form answer carries a bounded number of values",
        }),
    })
    .strict(),
  /** Cancel the form; the flow follows its declared not-submitted path. */
  z.object({ kind: z.literal("cancel") }).strict(),
  /** Answer a confirmation. */
  z.object({ kind: z.literal("confirm"), confirmed: z.boolean() }).strict(),
]);

/** Asks the server to start a flow the person may run, which may pause at a form. */
export const formContinuationStartRequestSchema = z
  .object({
    installation: formContinuationInstallationSchema,
    flowId: flowIdSchema,
    inputs: z.record(builderKeySchema, jsonValueSchema).default({}),
  })
  .strict();

/** Continues, submits or cancels the exact paused task with its continuation. */
export const formContinuationRequestSchema = z
  .object({
    target: formContinuationTargetSchema,
    continuation: z.string().min(16).max(128),
    answer: formContinuationAnswerSchema,
    receipt: formContinuationReceiptSchema.optional(),
    draft: formContinuationDraftEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const answersForm = value.answer.kind !== "confirm";
    if (answersForm !== (value.target.awaiting === "form"))
      context.addIssue({
        code: "custom",
        path: ["answer"],
        message: "The answer must match what the paused node is waiting for",
      });
  });

export const formContinuationIntentSchema = z
  .object({
    kind: z.enum([
      "show_message",
      "show_form",
      "confirm",
      "navigate",
      "refresh",
      "set_panel",
      "set_filter",
    ]),
    taskId: builderKeySchema,
    properties: z.record(z.string(), jsonValueSchema),
  })
  .strict();

/** A task the platform cannot run yet; it fails closed with a located notice. */
export const formContinuationUnavailableNoticeSchema = z
  .object({
    taskId: builderKeySchema,
    taskType: z.string().min(1).max(200),
    code: z.literal("not_yet_available"),
    requires: z.string().min(1).max(500),
  })
  .strict();

const resultCommon = {
  runId: z.uuid(),
  receipt: formContinuationReceiptSchema,
  intents: z.array(formContinuationIntentSchema).max(200),
  unavailable: z.array(formContinuationUnavailableNoticeSchema).max(200),
};

export const formContinuationRefusalReasonSchema = z.enum([
  /** Nothing can be said: not permitted, not runnable, or the input was not acceptable. */
  "unavailable",
  /** The installed release changed since the caller last saw it; restart from the current one. */
  "stale_installation",
  /**
   * The continuation cannot be resumed: unknown, expired, already used, foreign, or the exact node
   * or receipt no longer matches. One neutral reason, so a replay or forgery learns nothing.
   */
  "not_resumable",
]);

/**
 * The one result every client receives. A finished result carries the shared safe outcome and its
 * fixed presentation: a change that committed before a later failure is `partial`, never a plain
 * failure, and a result that cannot be confirmed is `uncertain`, never success.
 */
export const formContinuationOutcomeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("form_requested"),
      ...resultCommon,
      target: formContinuationTargetSchema,
      continuation: z.string().min(16).max(128),
      expiresAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("finished"),
      ...resultCommon,
      result: safeFlowResultKindSchema,
      presentation: safeFlowResultDescriptorSchema,
      failure: z.object({ code: z.string().min(1).max(100), taskId: builderKeySchema.optional() }).strict().optional(),
      stopped: z.string().min(1).max(200).optional(),
      outputs: z.record(z.string(), jsonValueSchema),
      draft: formContinuationDraftEvidenceSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("refused"), reason: formContinuationRefusalReasonSchema }).strict(),
]);

export type FormContinuationInstallation = z.infer<typeof formContinuationInstallationSchema>;
export type FormContinuationTarget = z.infer<typeof formContinuationTargetSchema>;
export type FormContinuationReceipt = z.infer<typeof formContinuationReceiptSchema>;
export type FormContinuationDraftEvidence = z.infer<typeof formContinuationDraftEvidenceSchema>;
export type FormContinuationAnswer = z.infer<typeof formContinuationAnswerSchema>;
export type FormContinuationStartRequest = z.input<typeof formContinuationStartRequestSchema>;
export type FormContinuationRequest = z.input<typeof formContinuationRequestSchema>;
export type FormContinuationIntent = z.infer<typeof formContinuationIntentSchema>;
export type FormContinuationUnavailableNotice = z.infer<
  typeof formContinuationUnavailableNoticeSchema
>;
export type FormContinuationRefusalReason = z.infer<typeof formContinuationRefusalReasonSchema>;
export type FormContinuationOutcome = z.infer<typeof formContinuationOutcomeSchema>;

/**
 * The port a web or MCP caller uses. The caller supplies the verified session and organisation
 * selection it already holds; neither is ever read from the request. Implementations never throw
 * to the caller: every failure is a `refused` outcome.
 */
export interface FormContinuationService {
  /** Starts a flow for the verified person; the result may be a form request to continue. */
  request(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    request: FormContinuationStartRequest,
  ): Promise<FormContinuationOutcome>;
  /** Continues, submits, cancels or confirms the exact paused node. */
  continue(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    request: FormContinuationRequest,
  ): Promise<FormContinuationOutcome>;
}
