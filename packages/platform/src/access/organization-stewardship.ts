import { z } from "zod";
import {
  delegationAuthorityIdSchema,
  organizationAccountIdSchema,
  revisionSchema,
  roleAssignmentIdSchema,
} from "../catalogue/identifiers";

export const organizationStewardshipAppointmentCommandSchema = z
  .object({
    operation: z.literal("appoint_organization_steward"),
    organizationAccountId: organizationAccountIdSchema,
    expectedAccountRevision: revisionSchema,
  })
  .strict();

export const organizationStewardshipAppointmentResultSchema = z
  .object({
    outcome: z.enum(["changed", "unchanged"]),
    operation: z.literal("appoint_organization_steward"),
    organizationAccountId: organizationAccountIdSchema,
    roleAssignmentId: roleAssignmentIdSchema,
    delegationAuthorityId: delegationAuthorityIdSchema,
    accessVersion: revisionSchema,
  })
  .strict();

/** A conflict proves only that an authorized target's expected revision is stale. */
export const organizationStewardshipAppointmentAttemptSchema = z.union([
  organizationStewardshipAppointmentResultSchema,
  z
    .object({
      outcome: z.literal("conflict"),
      operation: z.literal("appoint_organization_steward"),
    })
    .strict(),
]);
export type OrganizationStewardshipAppointmentCommand = z.infer<
  typeof organizationStewardshipAppointmentCommandSchema
>;
export type OrganizationStewardshipAppointmentAttempt = z.infer<
  typeof organizationStewardshipAppointmentAttemptSchema
>;
