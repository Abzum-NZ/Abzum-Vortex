import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  actorIdSchema,
  administrationReceiptIdSchema,
  applicationRootIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  revisionSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
} from "./identifiers";
import { preparedOrganizationRoleChangeSchema } from "./organization-role-changes";
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

/**
 * The frozen server-owned manifest for one bounded first-owner setup. App
 * composes it from the exact installed management-application release and the
 * nominated steward; Access owns applying it. It names no raw authority: the
 * operating-role evidence is the same prepared application-role acceptance the
 * protected role-change composition already validates.
 */
export const initialOperatingRoleGrantManifestSchema = z
  .object({
    manifestVersion: z.literal("1.0.0"),
    organizationId: organizationIdSchema,
    stewardOrganizationAccountId: organizationAccountIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: javascriptSafeRevisionSchema,
    provisioningReceiptId: administrationReceiptIdSchema,
    setupRevision: javascriptSafeRevisionSchema,
    setupActorId: actorIdSchema,
    correlationId: correlationIdSchema,
    roleAssignmentId: roleAssignmentIdSchema,
    operatingRoleChangeEvidence: preparedOrganizationRoleChangeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const candidate = value.operatingRoleChangeEvidence.candidate;
    if (candidate.operation !== "accept_new_application_role") {
      context.addIssue({
        code: "custom",
        path: ["operatingRoleChangeEvidence", "candidate"],
        message: "The operating role must be a first application-role acceptance",
      });
      return;
    }
    if (!representsSameUuid(candidate.organizationId, value.organizationId))
      context.addIssue({
        code: "custom",
        path: ["operatingRoleChangeEvidence", "candidate", "organizationId"],
        message: "The operating role must be accepted in the manifest organisation",
      });
    const registration = candidate.preparedTemplates.permissionRegistration;
    const basis = candidate.preparedTemplates.preparationBasis;
    if (
      basis.kind !== "current_active_registration" ||
      !representsSameUuid(registration.organizationId, value.organizationId) ||
      !representsSameUuid(registration.applicationRootId, value.applicationRootId) ||
      registration.applicationRelease.releaseRevision !== value.applicationReleaseRevision
    )
      context.addIssue({
        code: "custom",
        path: ["operatingRoleChangeEvidence", "candidate", "preparedTemplates"],
        message: "The operating role must derive from the named installed management-application release",
      });
    if (
      candidate.permissions.some(
        (permission) =>
          permission.ownerKind !== "application" ||
          permission.applicationRootId === undefined ||
          !representsSameUuid(permission.applicationRootId, value.applicationRootId) ||
          !representsSameUuid(permission.ownerId, value.applicationRootId),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["operatingRoleChangeEvidence", "candidate", "permissions"],
        message: "An initial operating role may hold only permissions of its management application",
      });
  });

export const initialOperatingRoleGrantResultSchema = z
  .object({
    outcome: z.enum(["established", "replayed"]),
    organizationId: organizationIdSchema,
    operatingRoleId: roleIdSchema,
    operatingRoleRevision: javascriptSafeRevisionSchema,
    roleAssignmentId: roleAssignmentIdSchema,
    roleAssignmentRevision: javascriptSafeRevisionSchema,
    managementApplicationRootId: applicationRootIdSchema,
    managementApplicationReleaseRevision: javascriptSafeRevisionSchema,
    managementRequiredRoleRevision: javascriptSafeRevisionSchema,
    setupRevision: javascriptSafeRevisionSchema,
    accessVersion: javascriptSafeRevisionSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export type InitialOperatingRoleGrantManifest = z.infer<
  typeof initialOperatingRoleGrantManifestSchema
>;
export type InitialOperatingRoleGrantResult = z.infer<
  typeof initialOperatingRoleGrantResultSchema
>;
