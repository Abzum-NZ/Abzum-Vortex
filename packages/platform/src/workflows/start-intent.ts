import "server-only";

import {
  applicationRootIdSchema,
  correlationIdSchema,
  flowIdSchema,
  flowLiteralSchema,
  flowTriggerOriginSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
  type FlowLiteral,
} from "@vortex/contracts";
import { withRuntimeTransaction, type RequestDatabaseTransaction } from "@vortex/db";
import { z } from "zod";

/** One accepted start, written inside the caller's authorized request transaction. */
export const startIntentCommandSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    applicationReleaseVersion: stableDefinitionReleaseVersionSchema,
    flowRelease: z.discriminatedUnion("ownerKind", [
      z
        .object({
          ownerKind: z.literal("application"),
          rootId: applicationRootIdSchema,
          revision: revisionSchema,
          version: stableDefinitionReleaseVersionSchema,
        })
        .strict(),
      z
        .object({
          ownerKind: z.literal("module"),
          rootId: moduleRootIdSchema,
          revision: revisionSchema,
          version: stableDefinitionReleaseVersionSchema,
        })
        .strict(),
    ]),
    flowId: flowIdSchema,
    /** An Event occurrence; action invocation proof is reserved for #1398 and #667. */
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("event"), id: z.uuid() }).strict(),
      z.object({ kind: z.literal("action"), id: z.uuid() }).strict(),
    ]),
    /** The exact published trigger or parent task invocation, including its iteration. */
    trigger: z.discriminatedUnion("type", [
      z.object({ type: z.literal("run_background"), id: z.string().min(1).max(1300) }).strict(),
      z.object({ type: z.literal("Event"), id: z.string().min(1).max(1300) }).strict(),
    ]),
    inputs: z.record(z.string().min(1).max(200), flowLiteralSchema),
    triggerValues: z.record(z.string().min(1).max(200), flowLiteralSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const sourceForTrigger = {
      run_background: "action",
      Event: "event",
    } as const;
    if (value.source.kind !== sourceForTrigger[value.trigger.type])
      context.addIssue({ code: "custom", path: ["source"], message: "Source and trigger disagree" });
    if (
      value.flowRelease.ownerKind === "application" &&
      (value.flowRelease.rootId !== value.applicationRootId ||
        value.flowRelease.revision !== value.applicationReleaseRevision ||
        value.flowRelease.version !== value.applicationReleaseVersion)
    )
      context.addIssue({
        code: "custom",
        path: ["flowRelease"],
        message: "Application flow release differs from the installation",
      });
    if (Object.keys(value.inputs).length > 100 || Object.keys(value.triggerValues).length > 100)
      context.addIssue({ code: "custom", path: ["inputs"], message: "Too many start values" });
  });

export type StartIntentCommand = z.infer<typeof startIntentCommandSchema>;
export type AcceptedStartIntent = Readonly<{
  outcome: "accepted" | "existing";
  intentId: string;
  acceptedAt: string;
}>;

const resultSchema = z.object({
  outcome: z.enum(["accepted", "existing"]),
  intentId: z.uuid(),
  acceptedAt: timestampSchema,
});

/**
 * The caller owns the transaction. A record writer calls this before its save commits.
 * A rollback removes the intent, and dispatch cannot observe it before commit.
 * The database rechecks the exact installed flow and all declared types rather
 * than trusting this command. Record-free action starts stay unavailable until
 * their invocation proof is retained.
 */
export const acceptFlowStartIntent = async (
  transaction: RequestDatabaseTransaction,
  candidate: StartIntentCommand,
): Promise<AcceptedStartIntent> => {
  const command = startIntentCommandSchema.parse(candidate);
  if (command.source.kind === "action") throw new Error("START_INTENT_SOURCE_UNVERIFIED");
  if (Object.keys(command.inputs).length > 0 || Object.keys(command.triggerValues).length > 0)
    throw new Error("START_INTENT_EVENT_VALUES_UNVERIFIED");
  const inputs = JSON.stringify(command.inputs satisfies Record<string, FlowLiteral>);
  const triggerValues = JSON.stringify(command.triggerValues satisfies Record<string, FlowLiteral>);
  if (Buffer.byteLength(inputs) > 65536 || Buffer.byteLength(triggerValues) > 65536)
    throw new Error("START_INTENT_VALUES_TOO_LARGE");

  const rows = await transaction.query<{ result: unknown }>`
    select vortex_workflow.accept_flow_start_intent(
      ${command.organizationId}::uuid,
      ${command.applicationRootId}::uuid,
      ${command.applicationReleaseRevision}::bigint,
      ${command.applicationReleaseVersion}::text,
      ${command.flowRelease.ownerKind}::text,
      ${command.flowRelease.rootId}::uuid,
      ${command.flowRelease.revision}::bigint,
      ${command.flowRelease.version}::text,
      ${command.flowId}::uuid,
      ${command.source.kind}::text,
      ${command.source.id}::uuid,
      ${command.trigger.type}::text,
      ${command.trigger.id}::text,
      ${inputs}::text::jsonb,
      ${triggerValues}::text::jsonb
    ) as result
  `;
  const parsed = rows.length === 1 ? resultSchema.safeParse(rows[0]?.result) : undefined;
  if (!parsed?.success) throw new Error("START_INTENT_STORAGE_RESULT_INVALID");
  return parsed.data;
};

const committedFlowStartIntentSchema = z
  .object({
    intentId: z.uuid(),
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    applicationReleaseVersion: stableDefinitionReleaseVersionSchema,
    flowRelease: z.discriminatedUnion("ownerKind", [
      z
        .object({
          ownerKind: z.literal("application"),
          rootId: applicationRootIdSchema,
          revision: revisionSchema,
          version: stableDefinitionReleaseVersionSchema,
          fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        })
        .strict(),
      z
        .object({
          ownerKind: z.literal("module"),
          rootId: moduleRootIdSchema,
          revision: revisionSchema,
          version: stableDefinitionReleaseVersionSchema,
          fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
    flowId: flowIdSchema,
    origin: flowTriggerOriginSchema,
    originId: z.uuid(),
    trigger: z.object({ type: z.literal("Event"), id: z.string().min(1).max(1300) }).strict(),
    inputs: z.record(z.string().min(1).max(200), flowLiteralSchema),
    triggerValues: z.record(z.string().min(1).max(200), flowLiteralSchema),
    correlationId: correlationIdSchema,
    acceptedAt: timestampSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    if (intent.origin !== "event")
      context.addIssue({
        code: "custom",
        path: ["origin"],
        message: "Only event intents are startable",
      });
    if (
      intent.flowRelease.ownerKind === "application" &&
      (intent.flowRelease.rootId !== intent.applicationRootId ||
        intent.flowRelease.revision !== intent.applicationReleaseRevision ||
        intent.flowRelease.version !== intent.applicationReleaseVersion)
    )
      context.addIssue({
        code: "custom",
        path: ["flowRelease"],
        message: "Application flow release differs from the installation",
      });
    if (Object.keys(intent.inputs).length > 100 || Object.keys(intent.triggerValues).length > 100)
      context.addIssue({ code: "custom", path: ["inputs"], message: "Too many start values" });
  });

const committedFlowStartIntentResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable") }).strict(),
  z
    .object({
      kind: z.literal("available"),
      intent: committedFlowStartIntentSchema,
    })
    .strict(),
]);

export type CommittedFlowStartIntent = z.infer<typeof committedFlowStartIntentSchema>;

/** Reads only a committed Event intent by its opaque identifier; all other inputs come from storage. */
export const readCommittedFlowStartIntent = async (
  intentIdCandidate: string,
): Promise<CommittedFlowStartIntent | undefined> => {
  const intentId = z.uuid().safeParse(intentIdCandidate);
  if (!intentId.success) return undefined;
  try {
    const rows = await withRuntimeTransaction((transaction) => transaction.query<{ result: unknown }>`
      select vortex_workflow.read_committed_flow_start_intent(${intentId.data}::uuid) as result
    `);
    if (rows.length !== 1) return undefined;
    const result = committedFlowStartIntentResultSchema.safeParse(rows[0]?.result);
    if (!result.success || result.data.kind !== "available") return undefined;
    if (result.data.intent.intentId.toLowerCase() !== intentId.data.toLowerCase()) return undefined;
    return result.data.intent;
  } catch {
    return undefined;
  }
};
