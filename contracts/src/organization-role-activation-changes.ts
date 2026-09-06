import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  actorIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  revisionSchema,
  roleActivationIdSchema,
  roleIdSchema,
} from "./identifiers";
import {
  roleActivationEligibilitySourceSchema,
  roleActivationSchema,
} from "./organization-access-catalogue";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);
const requestedDurationSecondsSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const trustedChangeFields = {
  changedBy: actorIdSchema,
  correlationId: correlationIdSchema,
};

export const organizationRoleActivationChangeCommandSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("activate_role"),
      organizationId: organizationIdSchema,
      roleActivationId: roleActivationIdSchema,
      organizationAccountId: organizationAccountIdSchema,
      roleId: roleIdSchema,
      expectedRoleRevision: javascriptSafeRevisionSchema,
      requestedDurationSeconds: requestedDurationSecondsSchema,
      eligibilitySource: roleActivationEligibilitySourceSchema,
      ...trustedChangeFields,
    })
    .strict(),
  z
    .object({
      operation: z.literal("revoke_role_activation"),
      organizationId: organizationIdSchema,
      roleActivationId: roleActivationIdSchema,
      expectedActivationRevision: javascriptSafeRevisionSchema,
      ...trustedChangeFields,
    })
    .strict(),
]);

export const organizationRoleActivationChangeResultSchema = z
  .object({
    outcome: z.literal("changed"),
    operation: z.enum(["activate_role", "revoke_role_activation"]),
    activation: roleActivationSchema,
    accessVersion: javascriptSafeRevisionSchema,
    correlationId: correlationIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const activation = value.activation;
    if (activation.changeCorrelationId !== value.correlationId)
      context.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: "The result must be bound to the activation change",
      });

    if (value.operation === "activate_role") {
      if (
        activation.state !== "live" ||
        activation.revision !== 1 ||
        activation.activatedByActorId !== activation.changedByActorId ||
        activation.activationCorrelationId !== value.correlationId ||
        Date.parse(activation.activatedAt) !== Date.parse(activation.changedAt)
      )
        context.addIssue({
          code: "custom",
          path: ["activation"],
          message: "An activation result must contain exact revision-one activation evidence",
        });
      return;
    }

    if (
      activation.state !== "revoked" ||
      activation.revision <= 1 ||
      activation.revokedByActorId !== activation.changedByActorId ||
      activation.revocationCorrelationId !== value.correlationId ||
      activation.revokedAt === undefined ||
      Date.parse(activation.revokedAt) !== Date.parse(activation.changedAt)
    )
      context.addIssue({
        code: "custom",
        path: ["activation"],
        message: "A revocation result must contain exact terminal change evidence",
      });
  });

export type OrganizationRoleActivationChangeCommand = z.infer<
  typeof organizationRoleActivationChangeCommandSchema
>;
export type OrganizationRoleActivationChangeResult = z.infer<
  typeof organizationRoleActivationChangeResultSchema
>;
