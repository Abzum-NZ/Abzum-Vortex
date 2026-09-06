import { z } from "zod";
import {
  builderKeySchema,
  groupIdSchema,
  membershipIdSchema,
  organizationAccountIdSchema,
  revisionSchema,
  timestampSchema,
} from "./identifiers";
import { labelSchema } from "./common";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

export const organizationAdministrationGroupSchema = z
  .object({
    groupId: groupIdSchema,
    key: builderKeySchema,
    label: labelSchema,
    state: z.enum(["active", "retired"]),
    revision: javascriptSafeRevisionSchema,
  })
  .strict();

export const listOrganizationAdministrationGroupsCommandSchema = z
  .object({
    pageSize: z.number().int().min(1).max(100),
    afterGroupId: groupIdSchema.optional(),
  })
  .strict();

export const listOrganizationAdministrationGroupsResultSchema = z
  .object({
    groups: z.array(organizationAdministrationGroupSchema).max(100),
    nextAfterGroupId: groupIdSchema.optional(),
    accessVersion: javascriptSafeRevisionSchema,
  })
  .strict();

export const readOrganizationAdministrationGroupCommandSchema = z
  .object({ groupId: groupIdSchema })
  .strict();

export const readOrganizationAdministrationGroupResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      group: organizationAdministrationGroupSchema,
      accessVersion: javascriptSafeRevisionSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("unavailable"),
      accessVersion: javascriptSafeRevisionSchema,
    })
    .strict(),
]);

export const createOrganizationAdministrationGroupCommandSchema = z
  .object({
    key: builderKeySchema,
    label: labelSchema,
  })
  .strict();

export const renameOrganizationAdministrationGroupCommandSchema = z
  .object({
    groupId: groupIdSchema,
    expectedGroupRevision: javascriptSafeRevisionSchema,
    label: labelSchema,
  })
  .strict();

export const changeOrganizationAdministrationGroupResultSchema = z
  .object({
    group: organizationAdministrationGroupSchema,
    accessVersion: javascriptSafeRevisionSchema,
  })
  .strict();

export const organizationAdministrationMembershipTemporalStateSchema = z.enum([
  "active",
  "scheduled",
  "expired",
  "revoked",
]);

export const organizationAdministrationMembershipSchema = z
  .object({
    membershipId: membershipIdSchema,
    groupId: groupIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    accountDisplayName: z.string().trim().min(1).max(120),
    revision: javascriptSafeRevisionSchema,
    startsAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    state: z.enum(["live", "revoked"]),
    temporalState: organizationAdministrationMembershipTemporalStateSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt !== undefined && Date.parse(value.expiresAt) <= Date.parse(value.startsAt))
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Membership expiry must follow its start",
      });
    if ((value.state === "revoked") !== (value.temporalState === "revoked"))
      context.addIssue({
        code: "custom",
        path: ["temporalState"],
        message: "Only a revoked membership has revoked temporal state",
      });
  });

export const listOrganizationAdministrationMembershipsCommandSchema = z
  .object({
    groupId: groupIdSchema,
    pageSize: z.number().int().min(1).max(100),
    afterMembershipId: membershipIdSchema.optional(),
  })
  .strict();

export const listOrganizationAdministrationMembershipsResultSchema = z
  .object({
    groupId: groupIdSchema,
    memberships: z.array(organizationAdministrationMembershipSchema).max(100),
    nextAfterMembershipId: membershipIdSchema.optional(),
    accessVersion: javascriptSafeRevisionSchema,
  })
  .strict();

export const readOrganizationAdministrationMembershipCommandSchema = z
  .object({ membershipId: membershipIdSchema })
  .strict();

export const readOrganizationAdministrationMembershipResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("available"),
        membership: organizationAdministrationMembershipSchema,
        accessVersion: javascriptSafeRevisionSchema,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("unavailable"),
        accessVersion: javascriptSafeRevisionSchema,
      })
      .strict(),
  ],
);

export type OrganizationAdministrationGroup = z.infer<typeof organizationAdministrationGroupSchema>;
export type ListOrganizationAdministrationGroupsCommand = z.infer<
  typeof listOrganizationAdministrationGroupsCommandSchema
>;
export type ListOrganizationAdministrationGroupsResult = z.infer<
  typeof listOrganizationAdministrationGroupsResultSchema
>;
export type ReadOrganizationAdministrationGroupCommand = z.infer<
  typeof readOrganizationAdministrationGroupCommandSchema
>;
export type ReadOrganizationAdministrationGroupResult = z.infer<
  typeof readOrganizationAdministrationGroupResultSchema
>;
export type CreateOrganizationAdministrationGroupCommand = z.infer<
  typeof createOrganizationAdministrationGroupCommandSchema
>;
export type RenameOrganizationAdministrationGroupCommand = z.infer<
  typeof renameOrganizationAdministrationGroupCommandSchema
>;
export type ChangeOrganizationAdministrationGroupResult = z.infer<
  typeof changeOrganizationAdministrationGroupResultSchema
>;
export type OrganizationAdministrationMembership = z.infer<
  typeof organizationAdministrationMembershipSchema
>;
export type ListOrganizationAdministrationMembershipsCommand = z.infer<
  typeof listOrganizationAdministrationMembershipsCommandSchema
>;
export type ListOrganizationAdministrationMembershipsResult = z.infer<
  typeof listOrganizationAdministrationMembershipsResultSchema
>;
export type ReadOrganizationAdministrationMembershipCommand = z.infer<
  typeof readOrganizationAdministrationMembershipCommandSchema
>;
export type ReadOrganizationAdministrationMembershipResult = z.infer<
  typeof readOrganizationAdministrationMembershipResultSchema
>;
