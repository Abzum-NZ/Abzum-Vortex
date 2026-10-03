import { z } from "zod";
import {
  administrationReceiptIdSchema,
  fingerprintSchema,
  identityIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  tenantIdSchema,
} from "./identifiers";
import {
  createTenantOrganizationAcceptedResultSchema,
  createTenantOrganizationCommandSchema,
} from "./tenant-governance";
import {
  provisionTenantAcceptedResultSchema,
  provisionTenantCommandSchema,
} from "./tenant-provisioning";

/** The original creation pair, never a claimed receipt or setup authority. */
export const organizationSetupReceiptCommandSchema = z.union([
  z
    .object({
      command: provisionTenantCommandSchema,
      result: provisionTenantAcceptedResultSchema,
    })
    .strict(),
  z
    .object({
      command: createTenantOrganizationCommandSchema,
      result: createTenantOrganizationAcceptedResultSchema,
    })
    .strict(),
]);

/** Immutable Identity evidence only; revisions and current authority are not attested. */
export const organizationSetupReceiptSchema = z
  .object({
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    identityId: identityIdSchema,
    operation: z.enum(["provision_tenant", "create_tenant_organization"]),
    receiptId: administrationReceiptIdSchema,
    commandFingerprint: fingerprintSchema,
  })
  .strict();

export const organizationSetupReceiptResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("available"), receipt: organizationSetupReceiptSchema }).strict(),
  z.object({ kind: z.literal("refused") }).strict(),
]);

export type OrganizationSetupReceiptCommand = z.infer<typeof organizationSetupReceiptCommandSchema>;
export type OrganizationSetupReceipt = z.infer<typeof organizationSetupReceiptSchema>;
export type OrganizationSetupReceiptResult = z.infer<typeof organizationSetupReceiptResultSchema>;
