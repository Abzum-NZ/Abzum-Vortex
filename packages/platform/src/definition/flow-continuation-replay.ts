import "server-only";

import { z } from "zod";
import { sameId } from "../catalogue/runtime-primitives";
import type { QueryContinuationKey } from "../queries/continuation-token";
import { openToken, sealToken } from "../queries/sealed-token";
import {
  formContinuationIntentSchema,
  formContinuationUnavailableNoticeSchema,
} from "../workflows/form-continuation-contracts";
import type { FlowOrchestratorResponse } from "./flow-orchestrator-types";

const purpose = "vortex.flow.continuation-replay.v1";
const identitySchema = z
  .object({
    organizationId: z.uuid(),
    applicationRootId: z.uuid(),
    identityId: z.uuid(),
    flowId: z.uuid(),
    bindingId: z.uuid(),
    runId: z.uuid(),
  })
  .strict();
const replySchema = z
  .object({
    kind: z.literal("suspended"),
    runId: z.uuid(),
    awaiting: z.enum(["form", "confirm"]),
    nodeId: z.string().min(1).max(200),
    releaseKey: z.string().min(1).max(512),
    committedEffects: z.number().int().min(0).max(100),
    intents: z.array(formContinuationIntentSchema).max(200),
    continuation: z.string().min(16).max(128),
    unavailable: z.array(formContinuationUnavailableNoticeSchema).max(200),
  })
  .strict();
const payloadSchema = z.object({ identity: identitySchema, reply: replySchema }).strict();

type Identity = z.infer<typeof identitySchema>;
type Suspended = Extract<FlowOrchestratorResponse, { kind: "suspended" }>;
type ReplyWithoutExpiry = Omit<Suspended, "expiresAt">;

/** Seal the child token and page intent for the parent continuation's private replay record. */
export const sealContinuationReplay = (
  key: QueryContinuationKey,
  identity: Identity,
  reply: ReplyWithoutExpiry,
): string => {
  if (!sameId(identity.runId, reply.runId))
    throw new Error("FLOW_CONTINUATION_REPLAY_RUN_MISMATCH");
  const token = sealToken(key, purpose, payloadSchema.parse({ identity, reply }));
  if (token.length > 1_000_000) throw new Error("FLOW_CONTINUATION_REPLAY_TOO_LARGE");
  return token;
};

/** Open a recorded reply only for the verified caller and the same bound flow run. */
export const openContinuationReplay = (
  key: QueryContinuationKey,
  identity: Identity,
  token: string,
  expiresAt: string,
): Suspended => {
  if (token.length > 1_000_000) throw new Error("FLOW_CONTINUATION_REPLAY_INVALID");
  const opened = openToken(key, purpose, token);
  if (opened.kind !== "opened") throw new Error("FLOW_CONTINUATION_REPLAY_INVALID");
  const payload = payloadSchema.parse(opened.payload);
  if (
    Object.keys(identity).some(
      (name) => !sameId(identity[name as keyof Identity], payload.identity[name as keyof Identity]),
    ) ||
    !sameId(payload.reply.runId, identity.runId)
  )
    throw new Error("FLOW_CONTINUATION_REPLAY_IDENTITY_MISMATCH");
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.valueOf()))
    throw new Error("FLOW_CONTINUATION_REPLAY_EXPIRY_INVALID");
  return { ...payload.reply, expiresAt: expiry.toISOString() };
};
