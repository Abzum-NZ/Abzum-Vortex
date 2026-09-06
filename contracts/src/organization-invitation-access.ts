import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  groupIdSchema,
  invitationIdSchema,
  membershipIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  revisionSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
  timestampSchema,
} from "./identifiers";
import {
  acceptOrganizationInvitationCommandSchema,
  invitationSchema,
  organizationAccountSchema,
} from "./identity-access";
import { roleAssignmentKindSchema } from "./organization-access-catalogue";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);
const fixedWindowFields = {
  startsAt: timestampSchema,
  expiresAt: timestampSchema.optional(),
};
const windowIsOrdered = (value: { startsAt: string; expiresAt?: string | undefined }): boolean =>
  value.expiresAt === undefined || Date.parse(value.expiresAt) > Date.parse(value.startsAt);
const normalized = (value: string): string => value.toLowerCase();

export const organizationInvitationMembershipIntentSchema = z
  .object({
    membershipId: membershipIdSchema,
    groupId: groupIdSchema,
    ...fixedWindowFields,
  })
  .strict()
  .refine(windowIsOrdered, {
    path: ["expiresAt"],
    message: "Membership intent expiry must be later than its start",
  });

export const organizationInvitationRoleAssignmentIntentSchema = z
  .object({
    roleAssignmentId: roleAssignmentIdSchema,
    roleId: roleIdSchema,
    expectedRoleRevision: javascriptSafeRevisionSchema,
    assignmentKind: roleAssignmentKindSchema,
    ...fixedWindowFields,
  })
  .strict()
  .refine(windowIsOrdered, {
    path: ["expiresAt"],
    message: "Role-assignment intent expiry must be later than its start",
  });

const exactIntentArraysSchema = z
  .object({
    membershipIntents: z.array(organizationInvitationMembershipIntentSchema),
    roleAssignmentIntents: z.array(organizationInvitationRoleAssignmentIntentSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.membershipIntents.length + value.roleAssignmentIntents.length === 0)
      context.addIssue({
        code: "custom",
        message: "Invitation access intent must contain at least one grant",
      });

    for (const [path, values] of [
      ["membershipIntents", value.membershipIntents.map((item) => item.membershipId)],
      ["roleAssignmentIntents", value.roleAssignmentIntents.map((item) => item.roleAssignmentId)],
    ] as const) {
      const identities = values.map(normalized);
      if (new Set(identities).size !== identities.length)
        context.addIssue({
          code: "custom",
          path: [path],
          message: "Invitation access intent identities must be unique",
        });
      if (identities.some((identity, index) => index > 0 && identities[index - 1]! >= identity))
        context.addIssue({
          code: "custom",
          path: [path],
          message: "Invitation access intents must use canonical identity order",
        });
    }
    const groupIdentities = value.membershipIntents.map((item) => normalized(item.groupId));
    if (new Set(groupIdentities).size !== groupIdentities.length)
      context.addIssue({
        code: "custom",
        path: ["membershipIntents"],
        message: "One invitation may create at most one membership in each Group",
      });
  });

export const organizationInvitationAccessIntentCandidateSchema = exactIntentArraysSchema;

export const organizationInvitationAccessIntentSchema = exactIntentArraysSchema.safeExtend({
  organizationId: organizationIdSchema,
  invitationId: invitationIdSchema,
  intendedByOrganizationAccountId: organizationAccountIdSchema,
  intendedAt: timestampSchema,
  intentCorrelationId: correlationIdSchema,
});

export const createOrganizationInvitationWithAccessIntentCommandSchema = z
  .object({
    operation: z.literal("create_organization_invitation_with_access_intent"),
    invitedEmail: z.email(),
    expiresAt: timestampSchema,
    accessIntent: organizationInvitationAccessIntentCandidateSchema,
  })
  .strict();

export const createOrganizationInvitationWithAccessIntentResultSchema = z
  .object({
    invitation: invitationSchema,
    accessIntent: organizationInvitationAccessIntentSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      normalized(value.invitation.organizationId) !==
        normalized(value.accessIntent.organizationId) ||
      normalized(value.invitation.invitationId) !== normalized(value.accessIntent.invitationId) ||
      normalized(value.invitation.invitedBy) !==
        normalized(value.accessIntent.intendedByOrganizationAccountId) ||
      Date.parse(value.invitation.invitedAt) !== Date.parse(value.accessIntent.intendedAt)
    )
      context.addIssue({
        code: "custom",
        path: ["accessIntent"],
        message: "Created invitation and access intent must retain one exact linkage",
      });
  });

/** The owner-only intent acceptance preserves the established verified-identity command shape. */
export const acceptOrganizationInvitationAccessCommandSchema =
  acceptOrganizationInvitationCommandSchema;

const acceptedAccessFields = {
  account: organizationAccountSchema,
  invitationId: invitationIdSchema,
  membershipIds: z.array(membershipIdSchema),
  roleAssignmentIds: z.array(roleAssignmentIdSchema),
  accessVersion: javascriptSafeRevisionSchema,
  correlationId: correlationIdSchema,
};

export const organizationInvitationAccessAcceptanceResultSchema = z
  .discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("accepted"), ...acceptedAccessFields }).strict(),
    z.object({ outcome: z.literal("already_accepted"), ...acceptedAccessFields }).strict(),
    z.object({ outcome: z.literal("unavailable") }).strict(),
    z.object({ outcome: z.literal("identity_inactive") }).strict(),
  ])
  .superRefine((value, context) => {
    if (value.outcome === "unavailable" || value.outcome === "identity_inactive") return;
    if (value.membershipIds.length + value.roleAssignmentIds.length === 0)
      context.addIssue({
        code: "custom",
        path: ["invitationId"],
        message: "Intent acceptance must retain at least one created-fact identity",
      });
    for (const [path, values] of [
      ["membershipIds", value.membershipIds],
      ["roleAssignmentIds", value.roleAssignmentIds],
    ] as const) {
      const identities = values.map(normalized);
      if (
        new Set(identities).size !== identities.length ||
        identities.some((identity, index) => index > 0 && identities[index - 1]! >= identity)
      )
        context.addIssue({
          code: "custom",
          path: [path],
          message: "Accepted intent identities must be unique and canonically ordered",
        });
    }
  });

export type OrganizationInvitationMembershipIntent = z.infer<
  typeof organizationInvitationMembershipIntentSchema
>;
export type OrganizationInvitationRoleAssignmentIntent = z.infer<
  typeof organizationInvitationRoleAssignmentIntentSchema
>;
export type OrganizationInvitationAccessIntentCandidate = z.infer<
  typeof organizationInvitationAccessIntentCandidateSchema
>;
export type OrganizationInvitationAccessIntent = z.infer<
  typeof organizationInvitationAccessIntentSchema
>;
export type CreateOrganizationInvitationWithAccessIntentCommand = z.infer<
  typeof createOrganizationInvitationWithAccessIntentCommandSchema
>;
export type CreateOrganizationInvitationWithAccessIntentResult = z.infer<
  typeof createOrganizationInvitationWithAccessIntentResultSchema
>;
export type AcceptOrganizationInvitationAccessCommand = z.infer<
  typeof acceptOrganizationInvitationAccessCommandSchema
>;
export type OrganizationInvitationAccessAcceptanceResult = z.infer<
  typeof organizationInvitationAccessAcceptanceResultSchema
>;
