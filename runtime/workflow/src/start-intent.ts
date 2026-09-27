import "server-only";

import {
  applicationRootIdSchema,
  flowIdSchema,
  flowLiteralSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
  type FlowLiteral,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";
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
