import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  actorIdSchema,
  delegationAuthorityIdSchema,
  organizationIdSchema,
  revisionSchema,
  timestampSchema,
} from "./identifiers";
import {
  accessAssigneeSchema,
  delegationAuthoritySchema,
  delegationScopeSchema,
  rolePermissionEntrySchema,
} from "./organization-access-catalogue";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);
const trustedChangeFields = {
  changedBy: actorIdSchema,
  correlationId: correlationIdSchema,
};

export const organizationDelegationScopeCandidateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("organization_catalogue") }).strict(),
  z
    .object({
      kind: z.literal("bounded"),
      permissions: z.array(rolePermissionEntrySchema).min(1),
    })
    .strict(),
]);

const grantDelegationCommandSchema = z
  .object({
    operation: z.literal("grant_delegation"),
    organizationId: organizationIdSchema,
    delegationAuthorityId: delegationAuthorityIdSchema,
    holder: accessAssigneeSchema,
    scope: delegationScopeSchema,
    startsAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    ...trustedChangeFields,
  })
  .strict()
  .refine(
    (value) =>
      value.expiresAt === undefined || Date.parse(value.expiresAt) > Date.parse(value.startsAt),
    {
      path: ["expiresAt"],
      message: "Delegation expiry must be later than its start",
    },
  );

export const organizationDelegationAuthorityChangeCommandSchema = z.discriminatedUnion(
  "operation",
  [
    grantDelegationCommandSchema,
    z
      .object({
        operation: z.literal("replace_delegation_scope"),
        organizationId: organizationIdSchema,
        delegationAuthorityId: delegationAuthorityIdSchema,
        expectedDelegationRevision: javascriptSafeRevisionSchema,
        scope: delegationScopeSchema,
        ...trustedChangeFields,
      })
      .strict(),
    z
      .object({
        operation: z.literal("revoke_delegation"),
        organizationId: organizationIdSchema,
        delegationAuthorityId: delegationAuthorityIdSchema,
        expectedDelegationRevision: javascriptSafeRevisionSchema,
        ...trustedChangeFields,
      })
      .strict(),
  ],
);

export const organizationDelegationAuthorityChangeResultSchema = z
  .object({
    outcome: z.literal("changed"),
    operation: z.enum(["grant_delegation", "replace_delegation_scope", "revoke_delegation"]),
    delegation: delegationAuthoritySchema,
    accessVersion: javascriptSafeRevisionSchema,
    correlationId: correlationIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const delegation = value.delegation;
    if (delegation.changeCorrelationId !== value.correlationId)
      context.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: "The result must be bound to the delegation change",
      });

    if (value.operation === "grant_delegation") {
      if (
        delegation.state !== "live" ||
        delegation.revision !== 1 ||
        delegation.grantedByActorId !== delegation.changedByActorId ||
        delegation.grantCorrelationId !== value.correlationId ||
        Date.parse(delegation.grantedAt) !== Date.parse(delegation.changedAt)
      )
        context.addIssue({
          code: "custom",
          path: ["delegation"],
          message: "A delegation grant must contain exact revision-one grant evidence",
        });
      return;
    }

    if (value.operation === "replace_delegation_scope") {
      if (delegation.state !== "live" || delegation.revision <= 1)
        context.addIssue({
          code: "custom",
          path: ["delegation"],
          message: "A delegation scope replacement must contain a live successor",
        });
      return;
    }

    if (
      delegation.state !== "revoked" ||
      delegation.revision <= 1 ||
      delegation.revokedByActorId !== delegation.changedByActorId ||
      delegation.revocationCorrelationId !== value.correlationId ||
      delegation.revokedAt === undefined ||
      Date.parse(delegation.revokedAt) !== Date.parse(delegation.changedAt)
    )
      context.addIssue({
        code: "custom",
        path: ["delegation"],
        message: "A revoked delegation must contain exact terminal change evidence",
      });
  });

export type OrganizationDelegationScopeCandidate = z.infer<
  typeof organizationDelegationScopeCandidateSchema
>;
export type OrganizationDelegationAuthorityChangeCommand = z.infer<
  typeof organizationDelegationAuthorityChangeCommandSchema
>;
export type OrganizationDelegationAuthorityChangeResult = z.infer<
  typeof organizationDelegationAuthorityChangeResultSchema
>;
