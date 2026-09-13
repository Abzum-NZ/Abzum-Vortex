import { z } from "zod";
import { invitationIdSchema, organizationAccountIdSchema, revisionSchema } from "./identifiers";
import { invitationSchema, organizationRuntimeSettingsSchema } from "./identity-access";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

export const organizationAdministrationAccountSummarySchema = z
  .object({
    organizationAccountId: organizationAccountIdSchema,
    displayName: z.string().trim().min(1).max(120).optional(),
    state: z.enum(["active", "suspended", "closed"]),
    language: z.string().min(2).max(35).optional(),
    timeZone: z.string().min(1).max(100).optional(),
    revision: javascriptSafeRevisionSchema,
  })
  .strict();

export const listOrganizationAccountsCommandSchema = z
  .object({
    pageSize: z.number().int().min(1).max(100),
    afterOrganizationAccountId: organizationAccountIdSchema.optional(),
  })
  .strict();

export const listOrganizationAccountsResultSchema = z
  .object({
    accounts: z.array(organizationAdministrationAccountSummarySchema).max(100),
    nextAfterOrganizationAccountId: organizationAccountIdSchema.optional(),
    accessVersion: javascriptSafeRevisionSchema,
  })
  .strict();

export const readOrganizationAccountCommandSchema = z
  .object({ organizationAccountId: organizationAccountIdSchema })
  .strict();

export const readOrganizationAccountResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      account: organizationAdministrationAccountSummarySchema,
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

export const listOrganizationInvitationsCommandSchema = z
  .object({
    pageSize: z.number().int().min(1).max(100),
    afterInvitationId: invitationIdSchema.optional(),
  })
  .strict();

export const listOrganizationInvitationsResultSchema = z
  .object({
    invitations: z.array(invitationSchema).max(100),
    nextAfterInvitationId: invitationIdSchema.optional(),
    accessVersion: javascriptSafeRevisionSchema,
  })
  .strict();

export const readOrganizationInvitationCommandSchema = z
  .object({ invitationId: invitationIdSchema })
  .strict();

export const readOrganizationInvitationResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      invitation: invitationSchema,
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

export const readOrganizationRuntimeSettingsCommandSchema = z.object({}).strict();

export const readOrganizationRuntimeSettingsResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      settings: organizationRuntimeSettingsSchema,
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

export type OrganizationAdministrationAccountSummary = z.infer<
  typeof organizationAdministrationAccountSummarySchema
>;
export type ListOrganizationAccountsCommand = z.infer<typeof listOrganizationAccountsCommandSchema>;
export type ListOrganizationAccountsResult = z.infer<typeof listOrganizationAccountsResultSchema>;
export type ReadOrganizationAccountCommand = z.infer<typeof readOrganizationAccountCommandSchema>;
export type ReadOrganizationAccountResult = z.infer<typeof readOrganizationAccountResultSchema>;
export type ListOrganizationInvitationsCommand = z.infer<
  typeof listOrganizationInvitationsCommandSchema
>;
export type ListOrganizationInvitationsResult = z.infer<
  typeof listOrganizationInvitationsResultSchema
>;
export type ReadOrganizationInvitationCommand = z.infer<
  typeof readOrganizationInvitationCommandSchema
>;
export type ReadOrganizationInvitationResult = z.infer<
  typeof readOrganizationInvitationResultSchema
>;
export type ReadOrganizationRuntimeSettingsCommand = z.infer<
  typeof readOrganizationRuntimeSettingsCommandSchema
>;
export type ReadOrganizationRuntimeSettingsResult = z.infer<
  typeof readOrganizationRuntimeSettingsResultSchema
>;
