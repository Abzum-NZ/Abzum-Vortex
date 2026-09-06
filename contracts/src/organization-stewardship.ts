import { z } from "zod";
import { correlationIdSchema, descriptionSchema, labelSchema } from "./common";
import {
  actorIdSchema,
  builderKeySchema,
  delegationAuthorityIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  revisionSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
  timestampSchema,
} from "./identifiers";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);
const representsSameInstant = (left: string, right: string): boolean =>
  Date.parse(left) === Date.parse(right);
const representsSameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/**
 * Immutable provenance for explicit stewardship adoption plus current change
 * evidence. The original identifiers are not current owner or authority flags;
 * current stewardship is re-established from live Access facts.
 */
export const organizationStewardshipRequirementSchema = z
  .object({
    organizationId: organizationIdSchema,
    revision: javascriptSafeRevisionSchema,
    originalOrganizationAccountId: organizationAccountIdSchema,
    originalRoleId: roleIdSchema,
    originalRoleAssignmentId: roleAssignmentIdSchema,
    originalDelegationAuthorityId: delegationAuthorityIdSchema,
    adoptedByActorId: actorIdSchema,
    adoptedAt: timestampSchema,
    adoptionCorrelationId: correlationIdSchema,
    changedByActorId: actorIdSchema,
    changedAt: timestampSchema,
    changeCorrelationId: correlationIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.changedAt) < Date.parse(value.adoptedAt))
      context.addIssue({
        code: "custom",
        path: ["changedAt"],
        message: "The stewardship requirement change cannot precede adoption",
      });
    if (
      value.revision === 1 &&
      (!representsSameUuid(value.changedByActorId, value.adoptedByActorId) ||
        !representsSameUuid(value.changeCorrelationId, value.adoptionCorrelationId) ||
        !representsSameInstant(value.changedAt, value.adoptedAt))
    )
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "The initial stewardship requirement must retain exact adoption evidence",
      });
  });

export const organizationStewardshipAdoptionCommandSchema = z
  .object({
    operation: z.literal("adopt_organization_stewardship"),
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    roleId: roleIdSchema,
    roleKey: builderKeySchema,
    roleLabel: labelSchema,
    roleDescription: descriptionSchema,
    roleAssignmentId: roleAssignmentIdSchema,
    delegationAuthorityId: delegationAuthorityIdSchema,
    changedBy: actorIdSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export const organizationStewardshipAdoptionResultSchema = z
  .object({
    outcome: z.enum(["changed", "unchanged"]),
    operation: z.literal("adopt_organization_stewardship"),
    requirement: organizationStewardshipRequirementSchema,
    accessVersion: javascriptSafeRevisionSchema,
    correlationId: correlationIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!representsSameUuid(value.requirement.adoptionCorrelationId, value.correlationId))
      context.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: "The result must be bound to the original stewardship adoption",
      });
    if (
      value.outcome === "changed" &&
      (value.requirement.revision !== 1 ||
        !representsSameUuid(value.requirement.changeCorrelationId, value.correlationId))
    )
      context.addIssue({
        code: "custom",
        path: ["requirement"],
        message: "A changed adoption result must contain the initial requirement",
      });
  });

export type OrganizationStewardshipRequirement = z.infer<
  typeof organizationStewardshipRequirementSchema
>;
export type OrganizationStewardshipAdoptionCommand = z.infer<
  typeof organizationStewardshipAdoptionCommandSchema
>;
export type OrganizationStewardshipAdoptionResult = z.infer<
  typeof organizationStewardshipAdoptionResultSchema
>;
