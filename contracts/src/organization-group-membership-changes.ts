import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  actorIdSchema,
  groupIdSchema,
  membershipIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  revisionSchema,
  timestampSchema,
} from "./identifiers";
import { groupMembershipSchema } from "./organization-access-catalogue";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);
const trustedChangeFields = {
  changedBy: actorIdSchema,
  correlationId: correlationIdSchema,
};
const fixedWindowFields = {
  startsAt: timestampSchema,
  expiresAt: timestampSchema.optional(),
};
const windowIsOrdered = (value: { startsAt: string; expiresAt?: string | undefined }): boolean =>
  value.expiresAt === undefined || Date.parse(value.expiresAt) > Date.parse(value.startsAt);

export const organizationGroupMembershipChangeCommandSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("add_membership"),
      organizationId: organizationIdSchema,
      membershipId: membershipIdSchema,
      groupId: groupIdSchema,
      organizationAccountId: organizationAccountIdSchema,
      ...fixedWindowFields,
      ...trustedChangeFields,
    })
    .strict()
    .refine(windowIsOrdered, {
      path: ["expiresAt"],
      message: "Membership expiry must be later than its start",
    }),
  z
    .object({
      operation: z.literal("remove_membership"),
      organizationId: organizationIdSchema,
      membershipId: membershipIdSchema,
      expectedMembershipRevision: javascriptSafeRevisionSchema,
      ...trustedChangeFields,
    })
    .strict(),
  z
    .object({
      operation: z.literal("restore_membership"),
      organizationId: organizationIdSchema,
      membershipId: membershipIdSchema,
      expectedMembershipRevision: javascriptSafeRevisionSchema,
      ...trustedChangeFields,
    })
    .strict(),
  z
    .object({
      operation: z.literal("renew_membership"),
      organizationId: organizationIdSchema,
      membershipId: membershipIdSchema,
      expectedMembershipRevision: javascriptSafeRevisionSchema,
      replacementMembershipId: membershipIdSchema,
      ...fixedWindowFields,
      ...trustedChangeFields,
    })
    .strict()
    .refine(
      (value) => value.membershipId.toLowerCase() !== value.replacementMembershipId.toLowerCase(),
      {
        path: ["replacementMembershipId"],
        message: "A renewed membership requires a distinct identity",
      },
    )
    .refine(windowIsOrdered, {
      path: ["expiresAt"],
      message: "Membership expiry must be later than its start",
    }),
]);

const commonResultFields = {
  outcome: z.literal("changed"),
  membership: groupMembershipSchema,
  accessVersion: javascriptSafeRevisionSchema,
  correlationId: correlationIdSchema,
};

export const organizationGroupMembershipChangeResultSchema = z
  .discriminatedUnion("operation", [
    z.object({ operation: z.literal("add_membership"), ...commonResultFields }).strict(),
    z.object({ operation: z.literal("remove_membership"), ...commonResultFields }).strict(),
    z.object({ operation: z.literal("restore_membership"), ...commonResultFields }).strict(),
    z
      .object({
        operation: z.literal("renew_membership"),
        ...commonResultFields,
        closedPredecessor: groupMembershipSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    const membership = value.membership;
    if (membership.changeCorrelationId !== value.correlationId)
      context.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: "The result must be bound to the membership change",
      });

    if (
      value.operation === "add_membership" &&
      (membership.state !== "live" ||
        membership.revision !== 1 ||
        membership.grantedByActorId !== membership.changedByActorId ||
        membership.grantCorrelationId !== value.correlationId ||
        Date.parse(membership.grantedAt) !== Date.parse(membership.changedAt))
    )
      context.addIssue({
        code: "custom",
        path: ["membership"],
        message: "An added membership must contain exact revision-one grant evidence",
      });

    if (
      value.operation === "remove_membership" &&
      (membership.state !== "revoked" ||
        membership.revision <= 1 ||
        membership.revokedByActorId !== membership.changedByActorId ||
        membership.revocationCorrelationId !== value.correlationId ||
        membership.revokedAt === undefined ||
        Date.parse(membership.revokedAt) !== Date.parse(membership.changedAt))
    )
      context.addIssue({
        code: "custom",
        path: ["membership"],
        message: "A removed membership must contain exact revocation evidence",
      });

    if (
      value.operation === "restore_membership" &&
      (membership.state !== "live" || membership.revision <= 1)
    )
      context.addIssue({
        code: "custom",
        path: ["membership"],
        message: "A restored membership must contain a live successor",
      });

    if (value.operation !== "renew_membership") return;
    const predecessor = value.closedPredecessor;
    if (
      membership.state !== "live" ||
      membership.revision !== 1 ||
      membership.grantedByActorId !== membership.changedByActorId ||
      membership.grantCorrelationId !== value.correlationId ||
      Date.parse(membership.grantedAt) !== Date.parse(membership.changedAt) ||
      predecessor.state !== "revoked" ||
      predecessor.revision <= 1 ||
      predecessor.membershipId.toLowerCase() === membership.membershipId.toLowerCase() ||
      predecessor.organizationId !== membership.organizationId ||
      predecessor.groupId !== membership.groupId ||
      predecessor.organizationAccountId !== membership.organizationAccountId ||
      predecessor.revokedByActorId !== predecessor.changedByActorId ||
      predecessor.changeCorrelationId !== value.correlationId ||
      predecessor.revocationCorrelationId !== value.correlationId ||
      predecessor.revokedAt === undefined ||
      Date.parse(predecessor.revokedAt) !== Date.parse(predecessor.changedAt)
    )
      context.addIssue({
        code: "custom",
        path: ["closedPredecessor"],
        message: "Renewal must bind one closed predecessor and one distinct live grant",
      });
  });

export type OrganizationGroupMembershipChangeCommand = z.infer<
  typeof organizationGroupMembershipChangeCommandSchema
>;
export type OrganizationGroupMembershipChangeResult = z.infer<
  typeof organizationGroupMembershipChangeResultSchema
>;
