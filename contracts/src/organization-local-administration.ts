import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  administrationDuplicateKeySchema,
  invitationIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  revisionSchema,
  timestampSchema,
} from "./identifiers";
import { invitationSchema, organizationRuntimeSettingsSchema } from "./identity-access";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

export const organizationAdministrationAccountSummarySchema = z
  .object({
    organizationAccountId: organizationAccountIdSchema,
    displayName: z.string().trim().min(1).max(120).optional(),
    state: z.enum(["active", "suspended", "closed", "closing", "deleted"]),
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

const organizationAccountLifecycleCommandFields = {
  duplicateKey: administrationDuplicateKeySchema,
  organizationAccountId: organizationAccountIdSchema,
  expectedRevision: javascriptSafeRevisionSchema,
};

export const suspendOrganizationAccountCommandSchema = z
  .object(organizationAccountLifecycleCommandFields)
  .strict();
export const reactivateOrganizationAccountCommandSchema = z
  .object(organizationAccountLifecycleCommandFields)
  .strict();
export const closeOrganizationAccountCommandSchema = z
  .object(organizationAccountLifecycleCommandFields)
  .strict();

export const createOrganizationInvitationForAdministrationCommandSchema = z
  .object({
    duplicateKey: administrationDuplicateKeySchema,
    invitedEmail: z.string().trim().toLowerCase().pipe(z.email()),
    expiresAt: timestampSchema,
  })
  .strict();

export const revokeOrganizationInvitationForAdministrationCommandSchema = z
  .object({
    duplicateKey: administrationDuplicateKeySchema,
    invitationId: invitationIdSchema,
    expectedRevision: javascriptSafeRevisionSchema,
  })
  .strict();

const acceptedOrganizationAccountLifecycleFields = {
  outcome: z.enum(["accepted", "replayed"]),
  organizationId: organizationIdSchema,
  organizationAccountId: organizationAccountIdSchema,
  revision: javascriptSafeRevisionSchema,
  correlationId: correlationIdSchema,
  acceptedAt: timestampSchema,
  accessVersion: javascriptSafeRevisionSchema,
};

const organizationAccountLifecycleResult = <
  Operation extends
    | "suspend_organization_account"
    | "reactivate_organization_account"
    | "close_organization_account",
>(
  operation: Operation,
) =>
  z
    .object({
      ...acceptedOrganizationAccountLifecycleFields,
      operation: z.literal(operation),
    })
    .strict();

export const suspendOrganizationAccountResultSchema = organizationAccountLifecycleResult(
  "suspend_organization_account",
);
export const reactivateOrganizationAccountResultSchema = organizationAccountLifecycleResult(
  "reactivate_organization_account",
);
export const closeOrganizationAccountResultSchema = organizationAccountLifecycleResult(
  "close_organization_account",
);

const organizationInvitationChangeFields = {
  organizationId: organizationIdSchema,
  invitationId: invitationIdSchema,
  revision: javascriptSafeRevisionSchema,
  correlationId: correlationIdSchema,
  acceptedAt: timestampSchema,
  accessVersion: javascriptSafeRevisionSchema,
};

export const createOrganizationInvitationForAdministrationResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("accepted"),
        operation: z.literal("create_organization_invitation"),
        ...organizationInvitationChangeFields,
        invitationSecret: z.string().min(32).max(2_000),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("replayed"),
        operation: z.literal("create_organization_invitation"),
        ...organizationInvitationChangeFields,
      })
      .strict(),
  ],
);

export const revokeOrganizationInvitationForAdministrationResultSchema = z
  .object({
    outcome: z.enum(["accepted", "replayed"]),
    operation: z.literal("revoke_organization_invitation"),
    ...organizationInvitationChangeFields,
  })
  .strict();

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
export type SuspendOrganizationAccountCommand = z.infer<
  typeof suspendOrganizationAccountCommandSchema
>;
export type ReactivateOrganizationAccountCommand = z.infer<
  typeof reactivateOrganizationAccountCommandSchema
>;
export type CloseOrganizationAccountCommand = z.infer<typeof closeOrganizationAccountCommandSchema>;
export type CreateOrganizationInvitationForAdministrationCommand = z.infer<
  typeof createOrganizationInvitationForAdministrationCommandSchema
>;
export type RevokeOrganizationInvitationForAdministrationCommand = z.infer<
  typeof revokeOrganizationInvitationForAdministrationCommandSchema
>;
export type SuspendOrganizationAccountResult = z.infer<
  typeof suspendOrganizationAccountResultSchema
>;
export type ReactivateOrganizationAccountResult = z.infer<
  typeof reactivateOrganizationAccountResultSchema
>;
export type CloseOrganizationAccountResult = z.infer<typeof closeOrganizationAccountResultSchema>;
export type CreateOrganizationInvitationForAdministrationResult = z.infer<
  typeof createOrganizationInvitationForAdministrationResultSchema
>;
export type RevokeOrganizationInvitationForAdministrationResult = z.infer<
  typeof revokeOrganizationInvitationForAdministrationResultSchema
>;
