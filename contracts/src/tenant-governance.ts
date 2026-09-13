import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  administrationDuplicateKeySchema,
  identityIdSchema,
  organizationIdSchema,
  revisionSchema,
  tenantAdministratorAssignmentIdSchema,
  tenantIdSchema,
  timestampSchema,
} from "./identifiers";
import { tenantStructuralCapabilitySetSchema } from "./identity-access";
import type { tenantStructuralCapabilitySchema } from "./identity-access";

const pageLimitSchema = z.number().int().min(1).max(100);
const pageFor = <Cursor extends z.ZodType>(cursor: Cursor) =>
  z.object({ limit: pageLimitSchema, after: cursor.optional() }).strict();

export const tenantLauncherEntrySchema = z
  .object({ tenantId: tenantIdSchema, displayName: z.string().trim().min(1).max(120) })
  .strict();
export const tenantLauncherPageSchema = z
  .object({ entries: z.array(tenantLauncherEntrySchema), next: tenantIdSchema.optional() })
  .strict();
export const tenantLauncherQuerySchema = pageFor(tenantIdSchema);

export const tenantHierarchyEntrySchema = z
  .object({
    organizationId: organizationIdSchema,
    parentOrganizationId: organizationIdSchema.optional(),
    shortName: z.string().trim().min(1).max(63),
    displayName: z.string().trim().min(1).max(120),
    state: z.enum(["active", "suspended", "archived", "removal_pending"]),
    revision: revisionSchema,
  })
  .strict();
export const tenantHierarchyQuerySchema = z
  .object({ tenantId: tenantIdSchema, page: pageFor(organizationIdSchema) })
  .strict();
export const tenantHierarchyPageSchema = z
  .object({ entries: z.array(tenantHierarchyEntrySchema), next: organizationIdSchema.optional() })
  .strict();
export const tenantOrganizationQuerySchema = z
  .object({ tenantId: tenantIdSchema, organizationId: organizationIdSchema })
  .strict();

export const tenantAssignmentViewSchema = z
  .object({
    assignmentId: tenantAdministratorAssignmentIdSchema,
    identityId: identityIdSchema,
    capabilities: tenantStructuralCapabilitySetSchema,
    startsAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    revision: revisionSchema,
    outcome: z.enum(["scheduled", "active", "expired", "revoked"]),
  })
  .strict();
export const tenantAssignmentQuerySchema = z
  .object({ tenantId: tenantIdSchema, page: pageFor(tenantAdministratorAssignmentIdSchema) })
  .strict();
export const tenantAssignmentPageSchema = z
  .object({
    entries: z.array(tenantAssignmentViewSchema),
    next: tenantAdministratorAssignmentIdSchema.optional(),
  })
  .strict();

export const tenantGovernanceReadRefusalSchema = z
  .object({ outcome: z.literal("refused"), code: z.enum(["invalid_request", "unavailable"]) })
  .strict();
export const tenantLauncherResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), page: tenantLauncherPageSchema }).strict(),
  tenantGovernanceReadRefusalSchema,
]);
export const tenantHierarchyResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), page: tenantHierarchyPageSchema }).strict(),
  tenantGovernanceReadRefusalSchema,
]);
export const tenantOrganizationResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), organization: tenantHierarchyEntrySchema }).strict(),
  tenantGovernanceReadRefusalSchema,
]);
export const tenantAssignmentReadResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), page: tenantAssignmentPageSchema }).strict(),
  tenantGovernanceReadRefusalSchema,
]);

const assignmentWindow = {
  capabilities: tenantStructuralCapabilitySetSchema,
  startsAt: timestampSchema,
  expiresAt: timestampSchema.optional(),
};
export const grantTenantAdministratorCommandSchema = z
  .object({
    operation: z.literal("grant_tenant_administrator"),
    duplicateKey: administrationDuplicateKeySchema,
    tenantId: tenantIdSchema,
    identityId: identityIdSchema,
    ...assignmentWindow,
  })
  .strict()
  .refine(
    (value) =>
      value.expiresAt === undefined || Date.parse(value.expiresAt) > Date.parse(value.startsAt),
    { path: ["expiresAt"], message: "Expiry must follow start" },
  );
export const changeTenantAdministratorCommandSchema = z
  .object({
    operation: z.literal("change_tenant_administrator"),
    duplicateKey: administrationDuplicateKeySchema,
    tenantId: tenantIdSchema,
    assignmentId: tenantAdministratorAssignmentIdSchema,
    expectedRevision: revisionSchema,
    ...assignmentWindow,
  })
  .strict()
  .refine(
    (value) =>
      value.expiresAt === undefined || Date.parse(value.expiresAt) > Date.parse(value.startsAt),
    { path: ["expiresAt"], message: "Expiry must follow start" },
  );
export const revokeTenantAdministratorCommandSchema = z
  .object({
    operation: z.literal("revoke_tenant_administrator"),
    duplicateKey: administrationDuplicateKeySchema,
    tenantId: tenantIdSchema,
    assignmentId: tenantAdministratorAssignmentIdSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

export const tenantAdministratorMutationRefusalCodeSchema = z.enum([
  "invalid_command",
  "duplicate_conflict",
  "stale_revision",
  "unavailable",
  "last_manager",
  "operation_unavailable",
]);
const acceptedMutation = {
  outcome: z.enum(["accepted", "replayed"]),
  assignmentId: tenantAdministratorAssignmentIdSchema,
  revision: revisionSchema,
  correlationId: correlationIdSchema,
  acceptedAt: timestampSchema,
};
const mutationResult = <
  Operation extends
    "grant_tenant_administrator" | "change_tenant_administrator" | "revoke_tenant_administrator",
>(
  operation: Operation,
) =>
  z.discriminatedUnion("outcome", [
    z.object({ ...acceptedMutation, operation: z.literal(operation) }).strict(),
    z
      .object({
        outcome: z.literal("refused"),
        operation: z.literal(operation),
        code: tenantAdministratorMutationRefusalCodeSchema,
      })
      .strict(),
  ]);
export const grantTenantAdministratorResultSchema = mutationResult("grant_tenant_administrator");
export const changeTenantAdministratorResultSchema = mutationResult("change_tenant_administrator");
export const revokeTenantAdministratorResultSchema = mutationResult("revoke_tenant_administrator");

export type TenantLauncherQuery = z.infer<typeof tenantLauncherQuerySchema>;
export type TenantLauncherResult = z.infer<typeof tenantLauncherResultSchema>;
export type TenantHierarchyQuery = z.infer<typeof tenantHierarchyQuerySchema>;
export type TenantHierarchyResult = z.infer<typeof tenantHierarchyResultSchema>;
export type TenantOrganizationQuery = z.infer<typeof tenantOrganizationQuerySchema>;
export type TenantOrganizationResult = z.infer<typeof tenantOrganizationResultSchema>;
export type TenantAssignmentQuery = z.infer<typeof tenantAssignmentQuerySchema>;
export type TenantAssignmentReadResult = z.infer<typeof tenantAssignmentReadResultSchema>;
export type GrantTenantAdministratorCommand = z.infer<typeof grantTenantAdministratorCommandSchema>;
export type ChangeTenantAdministratorCommand = z.infer<
  typeof changeTenantAdministratorCommandSchema
>;
export type RevokeTenantAdministratorCommand = z.infer<
  typeof revokeTenantAdministratorCommandSchema
>;
export type GrantTenantAdministratorResult = z.infer<typeof grantTenantAdministratorResultSchema>;
export type ChangeTenantAdministratorResult = z.infer<typeof changeTenantAdministratorResultSchema>;
export type RevokeTenantAdministratorResult = z.infer<typeof revokeTenantAdministratorResultSchema>;
export type TenantStructuralCapability = z.infer<typeof tenantStructuralCapabilitySchema>;
