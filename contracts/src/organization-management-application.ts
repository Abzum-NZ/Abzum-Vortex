import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  actorIdSchema,
  applicationRootIdSchema,
  organizationIdSchema,
  revisionSchema,
  roleIdSchema,
} from "./identifiers";
import { organizationStewardshipRequirementSchema } from "./organization-stewardship";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);
const representsSameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

export const organizationManagementApplicationRequirementOperationSchema = z.enum([
  "activate_management_application_requirement",
  "replace_management_application_requirement",
]);

/**
 * The D1 adoption record with one exact management-application binding. The
 * historical required role revision supplies the immutable required entry set;
 * these fields are not a copied permission snapshot or current authority.
 */
export const organizationManagementApplicationRequirementSchema =
  organizationStewardshipRequirementSchema
    .safeExtend({
      managementApplicationRootId: applicationRootIdSchema,
      managementRoleId: roleIdSchema,
      requiredRoleRevision: javascriptSafeRevisionSchema,
    })
    .superRefine((value, context) => {
      if (value.revision < 2)
        context.addIssue({
          code: "custom",
          path: ["revision"],
          message: "A management-application binding must follow stewardship adoption",
        });
    });

const organizationManagementApplicationRequirementChangeFields = {
  organizationId: organizationIdSchema,
  expectedRequirementRevision: javascriptSafeRevisionSchema,
  applicationRootId: applicationRootIdSchema,
  roleId: roleIdSchema,
  expectedRoleRevision: javascriptSafeRevisionSchema,
  changedBy: actorIdSchema,
  correlationId: correlationIdSchema,
} as const;

export const organizationManagementApplicationRequirementChangeCommandSchema = z.discriminatedUnion(
  "operation",
  [
    z
      .object({
        operation: z.literal("activate_management_application_requirement"),
        ...organizationManagementApplicationRequirementChangeFields,
      })
      .strict(),
    z
      .object({
        operation: z.literal("replace_management_application_requirement"),
        ...organizationManagementApplicationRequirementChangeFields,
      })
      .strict(),
  ],
);

export const organizationManagementApplicationRequirementChangeResultSchema = z
  .object({
    outcome: z.literal("changed"),
    operation: organizationManagementApplicationRequirementOperationSchema,
    requirement: organizationManagementApplicationRequirementSchema,
    accessVersion: javascriptSafeRevisionSchema,
    correlationId: correlationIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!representsSameUuid(value.requirement.changeCorrelationId, value.correlationId))
      context.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: "The result must retain the management-binding change correlation",
      });
  });

export type OrganizationManagementApplicationRequirementOperation = z.infer<
  typeof organizationManagementApplicationRequirementOperationSchema
>;
export type OrganizationManagementApplicationRequirement = z.infer<
  typeof organizationManagementApplicationRequirementSchema
>;
export type OrganizationManagementApplicationRequirementChangeCommand = z.infer<
  typeof organizationManagementApplicationRequirementChangeCommandSchema
>;
export type OrganizationManagementApplicationRequirementChangeResult = z.infer<
  typeof organizationManagementApplicationRequirementChangeResultSchema
>;
