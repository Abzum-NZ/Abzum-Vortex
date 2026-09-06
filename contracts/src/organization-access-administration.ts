import { z } from "zod";
import {
  applicationRootIdSchema,
  builderKeySchema,
  delegationAuthorityIdSchema,
  groupIdSchema,
  membershipIdSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
  timestampSchema,
} from "./identifiers";
import { descriptionSchema, labelSchema } from "./common";
import {
  rolePrivilegeClassificationSchema,
  roleRecentAuthenticationRequirementSchema,
} from "./organization-access-catalogue";
import {
  organizationAccessActionSchema,
  organizationAccessExactPermissionSchema,
} from "./organization-access-decision";

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

export const createOrganizationAdministrationGroupCommandSchema = z
  .object({
    key: builderKeySchema,
    label: labelSchema,
  })
  .strict();

export const renameOrganizationAdministrationGroupCommandSchema = z
  .object({
    groupId: groupIdSchema,
    expectedGroupRevision: javascriptSafeRevisionSchema,
    label: labelSchema,
  })
  .strict();

export const changeOrganizationAdministrationGroupResultSchema = z
  .object({
    group: organizationAdministrationGroupSchema,
    accessVersion: javascriptSafeRevisionSchema,
  })
  .strict();

export const organizationAdministrationMembershipTemporalStateSchema = z.enum([
  "active",
  "scheduled",
  "expired",
  "revoked",
]);

export const organizationAdministrationMembershipSchema = z
  .object({
    membershipId: membershipIdSchema,
    groupId: groupIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    accountDisplayName: z.string().trim().min(1).max(120),
    revision: javascriptSafeRevisionSchema,
    startsAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    state: z.enum(["live", "revoked"]),
    temporalState: organizationAdministrationMembershipTemporalStateSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt !== undefined && Date.parse(value.expiresAt) <= Date.parse(value.startsAt))
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Membership expiry must follow its start",
      });
    if ((value.state === "revoked") !== (value.temporalState === "revoked"))
      context.addIssue({
        code: "custom",
        path: ["temporalState"],
        message: "Only a revoked membership has revoked temporal state",
      });
  });

export const listOrganizationAdministrationMembershipsCommandSchema = z
  .object({
    groupId: groupIdSchema,
    pageSize: z.number().int().min(1).max(100),
    afterMembershipId: membershipIdSchema.optional(),
  })
  .strict();

export const listOrganizationAdministrationMembershipsResultSchema = z
  .object({
    groupId: groupIdSchema,
    memberships: z.array(organizationAdministrationMembershipSchema).max(100),
    nextAfterMembershipId: membershipIdSchema.optional(),
    accessVersion: javascriptSafeRevisionSchema,
  })
  .strict();

export const readOrganizationAdministrationMembershipCommandSchema = z
  .object({ membershipId: membershipIdSchema })
  .strict();

export const readOrganizationAdministrationMembershipResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("available"),
        membership: organizationAdministrationMembershipSchema,
        accessVersion: javascriptSafeRevisionSchema,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("unavailable"),
        accessVersion: javascriptSafeRevisionSchema,
      })
      .strict(),
  ],
);

export const organizationAdministrationPermissionSchema = z
  .object({
    reference: organizationAccessExactPermissionSchema,
    key: namespacedKeySchema,
    label: labelSchema,
    description: descriptionSchema,
    recordTypeId: recordTypeIdSchema.optional(),
    action: organizationAccessActionSchema,
    administrative: z.boolean(),
  })
  .strict();

export const listOrganizationAdministrationPermissionsCommandSchema = z
  .object({
    pageSize: z.number().int().min(1).max(100),
    after: organizationAccessExactPermissionSchema.optional(),
  })
  .strict();

export const listOrganizationAdministrationPermissionsResultSchema = z
  .object({
    permissions: z.array(organizationAdministrationPermissionSchema).max(100),
    nextAfter: organizationAccessExactPermissionSchema.optional(),
    accessVersion: javascriptSafeRevisionSchema,
  })
  .strict();

export const readOrganizationAdministrationPermissionCommandSchema = z
  .object({ reference: organizationAccessExactPermissionSchema })
  .strict();

export const readOrganizationAdministrationPermissionResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("available"),
        permission: organizationAdministrationPermissionSchema,
        accessVersion: javascriptSafeRevisionSchema,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("unavailable"),
        accessVersion: javascriptSafeRevisionSchema,
      })
      .strict(),
  ],
);

export const organizationAdministrationRoleSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("custom") }).strict(),
  z
    .object({
      kind: z.literal("application"),
      applicationRootId: applicationRootIdSchema,
      sourceRoleId: roleIdSchema,
    })
    .strict(),
]);

export const organizationAdministrationRoleAssignmentPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("standing") }).strict(),
  z
    .object({
      kind: z.literal("activation_required"),
      maximumActivationDurationSeconds: javascriptSafeRevisionSchema,
      reasonRequired: z.boolean(),
      recentAuthentication: roleRecentAuthenticationRequirementSchema,
      independentApprovalRequired: z.boolean(),
    })
    .strict(),
]);

const organizationAdministrationRoleFields = {
  roleId: roleIdSchema,
  key: builderKeySchema,
  label: labelSchema,
  roleKind: z.enum(["application", "custom"]),
  lifecycle: z.enum(["active", "acceptance_required", "unavailable", "retired"]),
  liveRevision: javascriptSafeRevisionSchema,
  privilegeClassification: rolePrivilegeClassificationSchema,
  assignmentPolicy: organizationAdministrationRoleAssignmentPolicySchema,
  source: organizationAdministrationRoleSourceSchema,
  acceptedPermissionCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
};

const addOrganizationAdministrationRoleIssues = (
  value: {
    roleKind: "application" | "custom";
    lifecycle: "active" | "acceptance_required" | "unavailable" | "retired";
    source: z.infer<typeof organizationAdministrationRoleSourceSchema>;
  },
  context: z.RefinementCtx,
) => {
  if (value.roleKind !== value.source.kind)
    context.addIssue({
      code: "custom",
      path: ["source"],
      message: "The safe role source must match its stored role kind",
    });
  if (value.roleKind === "custom" && !["active", "retired"].includes(value.lifecycle))
    context.addIssue({
      code: "custom",
      path: ["lifecycle"],
      message: "A custom role has only active or retired current lifecycle",
    });
};

export const organizationAdministrationRoleSummarySchema = z
  .object(organizationAdministrationRoleFields)
  .strict()
  .superRefine(addOrganizationAdministrationRoleIssues);

export const organizationAdministrationRoleDetailSchema = z
  .object({
    ...organizationAdministrationRoleFields,
    description: descriptionSchema,
    /** Stored accepted configuration only; this is not an effective-access result. */
    acceptedPermissions: z.array(organizationAdministrationPermissionSchema),
  })
  .strict()
  .superRefine((value, context) => {
    addOrganizationAdministrationRoleIssues(value, context);
    if (value.acceptedPermissions.length !== value.acceptedPermissionCount)
      context.addIssue({
        code: "custom",
        path: ["acceptedPermissions"],
        message: "The accepted permission detail must match its safe count",
      });
  });

export const listOrganizationAdministrationRolesCommandSchema = z
  .object({
    pageSize: z.number().int().min(1).max(100),
    afterRoleId: roleIdSchema.optional(),
  })
  .strict();

export const listOrganizationAdministrationRolesResultSchema = z
  .object({
    roles: z.array(organizationAdministrationRoleSummarySchema).max(100),
    nextAfterRoleId: roleIdSchema.optional(),
    accessVersion: javascriptSafeRevisionSchema,
  })
  .strict();

export const readOrganizationAdministrationRoleCommandSchema = z
  .object({ roleId: roleIdSchema })
  .strict();

export const readOrganizationAdministrationRoleResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      role: organizationAdministrationRoleDetailSchema,
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

export const organizationAdministrationApplicationRoleTemplateReferenceSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    sourceRoleId: roleIdSchema,
  })
  .strict();

export const organizationAdministrationApplicationRoleTemplateSchema = z
  .object({
    reference: organizationAdministrationApplicationRoleTemplateReferenceSchema,
    key: builderKeySchema,
    label: labelSchema,
    permissionSelectionKind: z.enum(["exact", "application_wildcard"]),
    /** Published declaration keys, not accepted or effective permission evidence. */
    publishedPermissionKeys: z.array(namespacedKeySchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.publishedPermissionKeys).size !== value.publishedPermissionKeys.length)
      context.addIssue({
        code: "custom",
        path: ["publishedPermissionKeys"],
        message: "Published role-template permission keys must be unique",
      });
  });

export const listOrganizationAdministrationApplicationRoleTemplatesCommandSchema = z
  .object({
    pageSize: z.number().int().min(1).max(100),
    after: organizationAdministrationApplicationRoleTemplateReferenceSchema.optional(),
  })
  .strict();

export const listOrganizationAdministrationApplicationRoleTemplatesResultSchema = z
  .object({
    templates: z.array(organizationAdministrationApplicationRoleTemplateSchema).max(100),
    nextAfter: organizationAdministrationApplicationRoleTemplateReferenceSchema.optional(),
    accessVersion: javascriptSafeRevisionSchema,
  })
  .strict();

export const readOrganizationAdministrationApplicationRoleTemplateCommandSchema = z
  .object({ reference: organizationAdministrationApplicationRoleTemplateReferenceSchema })
  .strict();

export const readOrganizationAdministrationApplicationRoleTemplateResultSchema =
  z.discriminatedUnion("outcome", [
    z
      .object({
        outcome: z.literal("available"),
        template: organizationAdministrationApplicationRoleTemplateSchema,
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

export const organizationAdministrationAssignmentTemporalStateSchema = z.enum([
  "active",
  "scheduled",
  "expired",
  "revoked",
]);

export const organizationAdministrationAssignmentSubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("organization_account"),
      organizationAccountId: organizationAccountIdSchema,
      displayName: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      kind: z.literal("group"),
      groupId: groupIdSchema,
      key: builderKeySchema,
      label: labelSchema,
      state: z.enum(["active", "retired"]),
    })
    .strict(),
]);

export const organizationAdministrationAssignedRoleSchema = z
  .object({
    roleId: roleIdSchema,
    key: builderKeySchema,
    label: labelSchema,
    lifecycle: z.enum(["active", "acceptance_required", "unavailable", "retired"]),
  })
  .strict();

const organizationAdministrationTemporalFactFields = {
  revision: javascriptSafeRevisionSchema,
  startsAt: timestampSchema,
  expiresAt: timestampSchema.optional(),
  state: z.enum(["live", "revoked"]),
  temporalState: organizationAdministrationAssignmentTemporalStateSchema,
};

const addOrganizationAdministrationTemporalFactIssues = (
  value: {
    startsAt: string;
    expiresAt?: string | undefined;
    state: "live" | "revoked";
    temporalState: "active" | "scheduled" | "expired" | "revoked";
  },
  context: z.RefinementCtx,
) => {
  if (value.expiresAt !== undefined && Date.parse(value.expiresAt) <= Date.parse(value.startsAt))
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Assignment-ledger expiry must follow its start",
    });
  if ((value.state === "revoked") !== (value.temporalState === "revoked"))
    context.addIssue({
      code: "custom",
      path: ["temporalState"],
      message: "Only a revoked assignment-ledger fact has revoked temporal state",
    });
};

export const organizationAdministrationRoleAssignmentSchema = z
  .object({
    roleAssignmentId: roleAssignmentIdSchema,
    role: organizationAdministrationAssignedRoleSchema,
    assignee: organizationAdministrationAssignmentSubjectSchema,
    assignmentKind: z.enum(["standing", "eligible"]),
    ...organizationAdministrationTemporalFactFields,
  })
  .strict()
  .superRefine(addOrganizationAdministrationTemporalFactIssues);

export const listOrganizationAdministrationRoleAssignmentsCommandSchema = z
  .object({
    pageSize: z.number().int().min(1).max(100),
    afterRoleAssignmentId: roleAssignmentIdSchema.optional(),
  })
  .strict();

export const listOrganizationAdministrationRoleAssignmentsResultSchema = z
  .object({
    assignments: z.array(organizationAdministrationRoleAssignmentSchema).max(100),
    nextAfterRoleAssignmentId: roleAssignmentIdSchema.optional(),
    accessVersion: javascriptSafeRevisionSchema,
  })
  .strict();

export const readOrganizationAdministrationRoleAssignmentCommandSchema = z
  .object({ roleAssignmentId: roleAssignmentIdSchema })
  .strict();

export const readOrganizationAdministrationRoleAssignmentResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("available"),
        assignment: organizationAdministrationRoleAssignmentSchema,
        accessVersion: javascriptSafeRevisionSchema,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("unavailable"),
        accessVersion: javascriptSafeRevisionSchema,
      })
      .strict(),
  ],
);

export const organizationAdministrationDelegationScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("organization_catalogue") }).strict(),
  z
    .object({
      kind: z.literal("bounded"),
      permissions: z.array(organizationAccessExactPermissionSchema).min(1),
    })
    .strict()
    .superRefine((value, context) => {
      const identities = value.permissions.map(
        (permission) =>
          `${permission.applicationRootId?.toLowerCase() ?? "platform"}:${permission.ownerKind}:${permission.ownerId.toLowerCase()}:${permission.permissionId.toLowerCase()}`,
      );
      if (new Set(identities).size !== identities.length)
        context.addIssue({
          code: "custom",
          path: ["permissions"],
          message: "A bounded delegation permission identity may appear only once",
        });
    }),
]);

export const organizationAdministrationDelegationAuthoritySchema = z
  .object({
    delegationAuthorityId: delegationAuthorityIdSchema,
    holder: organizationAdministrationAssignmentSubjectSchema,
    scope: organizationAdministrationDelegationScopeSchema,
    ...organizationAdministrationTemporalFactFields,
  })
  .strict()
  .superRefine(addOrganizationAdministrationTemporalFactIssues);

export const listOrganizationAdministrationDelegationAuthoritiesCommandSchema = z
  .object({
    pageSize: z.number().int().min(1).max(100),
    afterDelegationAuthorityId: delegationAuthorityIdSchema.optional(),
  })
  .strict();

export const listOrganizationAdministrationDelegationAuthoritiesResultSchema = z
  .object({
    delegations: z.array(organizationAdministrationDelegationAuthoritySchema).max(100),
    nextAfterDelegationAuthorityId: delegationAuthorityIdSchema.optional(),
    accessVersion: javascriptSafeRevisionSchema,
  })
  .strict();

export const readOrganizationAdministrationDelegationAuthorityCommandSchema = z
  .object({ delegationAuthorityId: delegationAuthorityIdSchema })
  .strict();

export const readOrganizationAdministrationDelegationAuthorityResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("available"),
        delegation: organizationAdministrationDelegationAuthoritySchema,
        accessVersion: javascriptSafeRevisionSchema,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("unavailable"),
        accessVersion: javascriptSafeRevisionSchema,
      })
      .strict(),
  ],
);

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
export type CreateOrganizationAdministrationGroupCommand = z.infer<
  typeof createOrganizationAdministrationGroupCommandSchema
>;
export type RenameOrganizationAdministrationGroupCommand = z.infer<
  typeof renameOrganizationAdministrationGroupCommandSchema
>;
export type ChangeOrganizationAdministrationGroupResult = z.infer<
  typeof changeOrganizationAdministrationGroupResultSchema
>;
export type OrganizationAdministrationMembership = z.infer<
  typeof organizationAdministrationMembershipSchema
>;
export type ListOrganizationAdministrationMembershipsCommand = z.infer<
  typeof listOrganizationAdministrationMembershipsCommandSchema
>;
export type ListOrganizationAdministrationMembershipsResult = z.infer<
  typeof listOrganizationAdministrationMembershipsResultSchema
>;
export type ReadOrganizationAdministrationMembershipCommand = z.infer<
  typeof readOrganizationAdministrationMembershipCommandSchema
>;
export type ReadOrganizationAdministrationMembershipResult = z.infer<
  typeof readOrganizationAdministrationMembershipResultSchema
>;
export type OrganizationAdministrationPermission = z.infer<
  typeof organizationAdministrationPermissionSchema
>;
export type ListOrganizationAdministrationPermissionsCommand = z.infer<
  typeof listOrganizationAdministrationPermissionsCommandSchema
>;
export type ListOrganizationAdministrationPermissionsResult = z.infer<
  typeof listOrganizationAdministrationPermissionsResultSchema
>;
export type ReadOrganizationAdministrationPermissionCommand = z.infer<
  typeof readOrganizationAdministrationPermissionCommandSchema
>;
export type ReadOrganizationAdministrationPermissionResult = z.infer<
  typeof readOrganizationAdministrationPermissionResultSchema
>;
export type OrganizationAdministrationRoleSummary = z.infer<
  typeof organizationAdministrationRoleSummarySchema
>;
export type OrganizationAdministrationRoleDetail = z.infer<
  typeof organizationAdministrationRoleDetailSchema
>;
export type ListOrganizationAdministrationRolesCommand = z.infer<
  typeof listOrganizationAdministrationRolesCommandSchema
>;
export type ListOrganizationAdministrationRolesResult = z.infer<
  typeof listOrganizationAdministrationRolesResultSchema
>;
export type ReadOrganizationAdministrationRoleCommand = z.infer<
  typeof readOrganizationAdministrationRoleCommandSchema
>;
export type ReadOrganizationAdministrationRoleResult = z.infer<
  typeof readOrganizationAdministrationRoleResultSchema
>;
export type OrganizationAdministrationApplicationRoleTemplateReference = z.infer<
  typeof organizationAdministrationApplicationRoleTemplateReferenceSchema
>;
export type OrganizationAdministrationApplicationRoleTemplate = z.infer<
  typeof organizationAdministrationApplicationRoleTemplateSchema
>;
export type ListOrganizationAdministrationApplicationRoleTemplatesCommand = z.infer<
  typeof listOrganizationAdministrationApplicationRoleTemplatesCommandSchema
>;
export type ListOrganizationAdministrationApplicationRoleTemplatesResult = z.infer<
  typeof listOrganizationAdministrationApplicationRoleTemplatesResultSchema
>;
export type ReadOrganizationAdministrationApplicationRoleTemplateCommand = z.infer<
  typeof readOrganizationAdministrationApplicationRoleTemplateCommandSchema
>;
export type ReadOrganizationAdministrationApplicationRoleTemplateResult = z.infer<
  typeof readOrganizationAdministrationApplicationRoleTemplateResultSchema
>;
export type OrganizationAdministrationAssignmentSubject = z.infer<
  typeof organizationAdministrationAssignmentSubjectSchema
>;
export type OrganizationAdministrationRoleAssignment = z.infer<
  typeof organizationAdministrationRoleAssignmentSchema
>;
export type ListOrganizationAdministrationRoleAssignmentsCommand = z.infer<
  typeof listOrganizationAdministrationRoleAssignmentsCommandSchema
>;
export type ListOrganizationAdministrationRoleAssignmentsResult = z.infer<
  typeof listOrganizationAdministrationRoleAssignmentsResultSchema
>;
export type ReadOrganizationAdministrationRoleAssignmentCommand = z.infer<
  typeof readOrganizationAdministrationRoleAssignmentCommandSchema
>;
export type ReadOrganizationAdministrationRoleAssignmentResult = z.infer<
  typeof readOrganizationAdministrationRoleAssignmentResultSchema
>;
export type OrganizationAdministrationDelegationAuthority = z.infer<
  typeof organizationAdministrationDelegationAuthoritySchema
>;
export type ListOrganizationAdministrationDelegationAuthoritiesCommand = z.infer<
  typeof listOrganizationAdministrationDelegationAuthoritiesCommandSchema
>;
export type ListOrganizationAdministrationDelegationAuthoritiesResult = z.infer<
  typeof listOrganizationAdministrationDelegationAuthoritiesResultSchema
>;
export type ReadOrganizationAdministrationDelegationAuthorityCommand = z.infer<
  typeof readOrganizationAdministrationDelegationAuthorityCommandSchema
>;
export type ReadOrganizationAdministrationDelegationAuthorityResult = z.infer<
  typeof readOrganizationAdministrationDelegationAuthorityResultSchema
>;
