import { z } from "zod";
import {
  actorIdSchema,
  applicationRootIdSchema,
  containedComponentIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  revisionSchema,
  ruleIdSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
} from "./identifiers";

/** The Access-owned identity selected by one compiled flow run-as binding. */
export const flowRunAsPrincipalActorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("specified_account"),
      organizationAccountId: organizationAccountIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("system"), systemActorId: actorIdSchema }).strict(),
]);

/** Expiry is evaluated at read time; revocation is an explicit stored state. */
export const flowRunAsPrincipalStateSchema = z.enum(["active", "revoked"]);
export const flowRunAsPrincipalEffectiveStateSchema = z.enum(["active", "revoked", "expired"]);

/**
 * An Access-owned, revisioned mapping from one exact compiled flow run-as binding to one
 * organisation account or registered System actor. It confers no task permission: each protected
 * step still requires its existing exact Access grant.
 */
export const flowRunAsPrincipalSchema = z
  .object({
    executionBindingId: containedComponentIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    flowId: ruleIdSchema,
    actor: flowRunAsPrincipalActorSchema,
    expiresAt: timestampSchema.optional(),
    state: flowRunAsPrincipalStateSchema,
    revision: revisionSchema,
    recordedAt: timestampSchema,
    revokedAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.state === "revoked") !== (value.revokedAt !== undefined))
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "Exactly a revoked run-as principal records its revocation time",
      });
  });

export type FlowRunAsPrincipalActor = z.infer<typeof flowRunAsPrincipalActorSchema>;
export type FlowRunAsPrincipalState = z.infer<typeof flowRunAsPrincipalStateSchema>;
export type FlowRunAsPrincipalEffectiveState = z.infer<
  typeof flowRunAsPrincipalEffectiveStateSchema
>;
export type FlowRunAsPrincipal = z.infer<typeof flowRunAsPrincipalSchema>;
