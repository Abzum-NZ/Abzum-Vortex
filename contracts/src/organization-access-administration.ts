import { z } from "zod";
import { builderKeySchema, groupIdSchema, revisionSchema } from "./identifiers";
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
