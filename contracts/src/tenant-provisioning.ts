import { z } from "zod";
import {
  administrationDuplicateKeySchema,
  administrationReceiptIdSchema,
  actorIdSchema,
  builderKeySchema,
  clusterIdSchema,
  identityIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  revisionSchema,
  tenantAdministratorAssignmentIdSchema,
  tenantIdSchema,
  timestampSchema,
} from "./identifiers";
import { organizationRuntimeSettingsSchema } from "./identity-access";

const displayNameSchema = z.string().trim().min(1).max(120);
const runtimeSettingsInputSchema = organizationRuntimeSettingsSchema.omit({
  organizationId: true,
  revision: true,
});

/** Trusted server configuration. It is deliberately separate from every command. */
export const configuredTenantAdministrationOperatorContextSchema = z
  .object({
    kind: z.literal("configured_system_operator"),
    clusterId: clusterIdSchema,
    systemActorId: actorIdSchema,
  })
  .strict();

export const provisionTenantCommandSchema = z
  .object({
    operation: z.literal("provision_tenant"),
    duplicateKey: administrationDuplicateKeySchema,
    tenant: z.object({ shortName: builderKeySchema, displayName: displayNameSchema }).strict(),
    rootOrganization: z
      .object({ shortName: builderKeySchema, displayName: displayNameSchema })
      .strict(),
    tenantSteward: z.object({ identityId: identityIdSchema }).strict(),
    organizationSteward: z
      .object({
        identityId: identityIdSchema,
        accountDisplayName: displayNameSchema,
        accountLanguage: organizationRuntimeSettingsSchema.shape.language,
        accountTimeZone: organizationRuntimeSettingsSchema.shape.timeZone,
      })
      .strict(),
    runtimeSettings: runtimeSettingsInputSchema,
  })
  .strict();

export const adoptTenantCommandSchema = z
  .object({
    operation: z.literal("adopt_tenant"),
    duplicateKey: administrationDuplicateKeySchema,
    tenantId: tenantIdSchema,
    tenantSteward: z.object({ identityId: identityIdSchema }).strict(),
  })
  .strict();

export const adoptOrganizationCommandSchema = z
  .object({
    operation: z.literal("adopt_organization"),
    duplicateKey: administrationDuplicateKeySchema,
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema,
    organizationSteward: z
      .object({
        identityId: identityIdSchema,
        organizationAccountId: organizationAccountIdSchema,
      })
      .strict(),
  })
  .strict();

export const configuredTenantAdministrationRefusalCodeSchema = z.enum([
  "invalid_command",
  "operator_not_configured",
  "duplicate_conflict",
  "scope_unavailable",
  "steward_unavailable",
  "operation_unavailable",
]);

const acceptedCommon = {
  outcome: z.enum(["accepted", "replayed"]),
  correlationId: administrationReceiptIdSchema,
  acceptedAt: timestampSchema,
};

const refusalFor = <Operation extends "provision_tenant" | "adopt_tenant" | "adopt_organization">(
  operation: Operation,
) =>
  z
    .object({
      outcome: z.literal("refused"),
      operation: z.literal(operation),
      code: configuredTenantAdministrationRefusalCodeSchema,
    })
    .strict();

export const provisionTenantAcceptedResultSchema = z
  .object({
    ...acceptedCommon,
    operation: z.literal("provision_tenant"),
    tenantId: tenantIdSchema,
    rootOrganizationId: organizationIdSchema,
    tenantAdministratorAssignmentId: tenantAdministratorAssignmentIdSchema,
    tenantAdministratorAssignmentRevision: revisionSchema,
    organizationAccountId: organizationAccountIdSchema,
    organizationAccountRevision: revisionSchema,
    accessVersion: revisionSchema,
  })
  .strict();
export const provisionTenantRefusalSchema = refusalFor("provision_tenant");
export const provisionTenantResultSchema = z.discriminatedUnion("outcome", [
  provisionTenantAcceptedResultSchema,
  provisionTenantRefusalSchema,
]);

export const adoptTenantAcceptedResultSchema = z
  .object({
    ...acceptedCommon,
    operation: z.literal("adopt_tenant"),
    tenantId: tenantIdSchema,
    tenantAdministratorAssignmentId: tenantAdministratorAssignmentIdSchema,
    tenantAdministratorAssignmentRevision: revisionSchema,
  })
  .strict();
export const adoptTenantRefusalSchema = refusalFor("adopt_tenant");
export const adoptTenantResultSchema = z.discriminatedUnion("outcome", [
  adoptTenantAcceptedResultSchema,
  adoptTenantRefusalSchema,
]);

export const adoptOrganizationAcceptedResultSchema = z
  .object({
    ...acceptedCommon,
    operation: z.literal("adopt_organization"),
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    accessVersion: revisionSchema,
  })
  .strict();
export const adoptOrganizationRefusalSchema = refusalFor("adopt_organization");
export const adoptOrganizationResultSchema = z.discriminatedUnion("outcome", [
  adoptOrganizationAcceptedResultSchema,
  adoptOrganizationRefusalSchema,
]);

export type ConfiguredTenantAdministrationOperatorContext = z.infer<
  typeof configuredTenantAdministrationOperatorContextSchema
>;
export type ProvisionTenantCommand = z.infer<typeof provisionTenantCommandSchema>;
export type ProvisionTenantResult = z.infer<typeof provisionTenantResultSchema>;
export type AdoptTenantCommand = z.infer<typeof adoptTenantCommandSchema>;
export type AdoptTenantResult = z.infer<typeof adoptTenantResultSchema>;
export type AdoptOrganizationCommand = z.infer<typeof adoptOrganizationCommandSchema>;
export type AdoptOrganizationResult = z.infer<typeof adoptOrganizationResultSchema>;
export type ConfiguredTenantAdministrationRefusalCode = z.infer<
  typeof configuredTenantAdministrationRefusalCodeSchema
>;
