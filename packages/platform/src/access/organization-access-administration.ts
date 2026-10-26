import { z } from "zod";
import {
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  delegationAuthorityIdSchema,
  groupIdSchema,
  membershipIdSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  roleActivationIdSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
  timestampSchema,
} from "../catalogue/identifiers";
import { descriptionSchema, labelSchema } from "../catalogue/common";
import {
  rolePrivilegeClassificationSchema,
  roleRecentAuthenticationRequirementSchema,
} from "./organization-access-catalogue";
import {
  organizationAccessActionSchema,
  organizationAccessExactPermissionSchema,
} from "./organization-access-decision";
import { preparedOrganizationRoleChangeSchema } from "./organization-role-changes";
import { permissionFieldPolicySchema, permissionRecordScopeSchema } from "./permissions";

export const organizationAdministrationGroupSchema = z
  .object({
    groupId: groupIdSchema,
    key: builderKeySchema,
    label: labelSchema,
    state: z.enum(["active", "retired"]),
    revision: revisionSchema,
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
      accessVersion: revisionSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("unavailable"),
      accessVersion: revisionSchema,
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
    expectedGroupRevision: revisionSchema,
    label: labelSchema,
  })
  .strict();

export const retireOrganizationAdministrationGroupCommandSchema = z
  .object({
    groupId: groupIdSchema,
    expectedGroupRevision: revisionSchema,
  })
  .strict();

export const changeOrganizationAdministrationGroupResultSchema = z
  .object({
    group: organizationAdministrationGroupSchema,
    accessVersion: revisionSchema,
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
    revision: revisionSchema,
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

export const removeOrganizationAdministrationMembershipCommandSchema = z
  .object({
    membershipId: membershipIdSchema,
    expectedMembershipRevision: revisionSchema,
  })
  .strict();

export const changeOrganizationAdministrationMembershipResultSchema = z
  .object({
    membership: organizationAdministrationMembershipSchema,
    accessVersion: revisionSchema,
  })
  .strict();

export const addOrganizationAdministrationMembershipCommandSchema = z
  .object({
    groupId: groupIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    startsAt: timestampSchema.optional(),
    expiresAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.startsAt !== undefined &&
      value.expiresAt !== undefined &&
      Date.parse(value.expiresAt) <= Date.parse(value.startsAt)
    )
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Membership expiry must follow its start",
      });
  });

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
      maximumActivationDurationSeconds: revisionSchema,
      reasonRequired: z.boolean(),
      recentAuthentication: roleRecentAuthenticationRequirementSchema,
      requiredCallerExecutionBindingId: containedComponentIdSchema.optional(),
    })
    .strict(),
]);

const organizationAdministrationRoleFields = {
  roleId: roleIdSchema,
  key: builderKeySchema,
  label: labelSchema,
  roleKind: z.enum(["application", "custom"]),
  lifecycle: z.enum(["active", "acceptance_required", "unavailable", "retired"]),
  liveRevision: revisionSchema,
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
    /**
     * Stored accepted configuration only; this is not an effective-access result. Each entry
     * carries the meaning the role accepted (its record scope and field policy), which may be
     * older than the registered one until the role revision is accepted.
     */
    acceptedPermissions: z.array(
      organizationAdministrationPermissionSchema.safeExtend({
        recordScope: permissionRecordScopeSchema.optional(),
        fieldPolicy: permissionFieldPolicySchema.optional(),
      }),
    ),
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

export const readOrganizationAdministrationRoleCommandSchema = z
  .object({ roleId: roleIdSchema })
  .strict();

export const readOrganizationAdministrationRoleResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      role: organizationAdministrationRoleDetailSchema,
      accessVersion: revisionSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("unavailable"),
      accessVersion: revisionSchema,
    })
    .strict(),
]);

export const reviseOrganizationAdministrationRoleMetadataCommandSchema = z
  .object({
    roleId: roleIdSchema,
    expectedRoleRevision: revisionSchema,
    label: labelSchema,
    description: descriptionSchema,
  })
  .strict();

export const retireOrganizationAdministrationRoleCommandSchema = z
  .object({
    roleId: roleIdSchema,
    expectedRoleRevision: revisionSchema,
  })
  .strict();

export const changeOrganizationAdministrationRoleAuthorityCommandSchema = z
  .object({
    evidence: preparedOrganizationRoleChangeSchema,
  })
  .strict();

/**
 * The bounded configuration an administrator supplies to prepare one create-custom-role or
 * accept-application-role-template change. It names permissions or a published template but never a
 * fingerprint: the server derives the exact current evidence for the caller's organisation. The
 * explicit acceptance is a visible, required choice, so a broadening template is accepted on
 * purpose rather than by submitting a form.
 */
export const organizationAdministrationRoleChangePreparationOperationSchema = z.enum([
  "create_custom",
  "accept_new_application_role",
]);

export const prepareOrganizationAdministrationRoleChangeCommandSchema = z
  .object({
    operation: organizationAdministrationRoleChangePreparationOperationSchema,
    roleKey: builderKeySchema,
    label: labelSchema,
    description: descriptionSchema,
    privilegeClassification: rolePrivilegeClassificationSchema,
    permissionReferences: z
      .array(organizationAccessExactPermissionSchema)
      .min(1)
      .max(500)
      .optional(),
    templateApplicationRootId: applicationRootIdSchema.optional(),
    sourceRoleId: roleIdSchema.optional(),
    acceptBroadenedAuthority: z.enum(["accept", "decline"]),
  })
  .strict()
  .superRefine((value, context) => {
    const creatingCustom = value.operation === "create_custom";
    const acceptingTemplate = value.operation === "accept_new_application_role";
    if (creatingCustom !== (value.permissionReferences !== undefined))
      context.addIssue({
        code: "custom",
        path: ["permissionReferences"],
        message: "Only a custom role names its own permission references",
      });
    if ((value.templateApplicationRootId !== undefined) !== acceptingTemplate)
      context.addIssue({
        code: "custom",
        path: ["templateApplicationRootId"],
        message: "Accepting a template names its exact application",
      });
    if ((value.sourceRoleId !== undefined) !== acceptingTemplate)
      context.addIssue({
        code: "custom",
        path: ["sourceRoleId"],
        message: "Accepting a template names its exact source role",
      });
  });

/**
 * The only caller-supplied facts for accepting a pending revision of an existing Application
 * role. The protected reader resolves the role's source and configuration from its current row.
 */
export const prepareOrganizationAdministrationRoleRevisionAcceptanceCommandSchema = z
  .object({
    operation: z.literal("accept_application_role_revision"),
    roleId: roleIdSchema,
    expectedRoleRevision: revisionSchema,
    acceptBroadenedAuthority: z.enum(["accept", "decline"]),
  })
  .strict();

export const changeOrganizationAdministrationRoleResultSchema = z
  .object({
    role: organizationAdministrationRoleSummarySchema,
    accessVersion: revisionSchema,
  })
  .strict();

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
      // A person who has just joined has no display name until they set their profile.
      displayName: z.string().trim().min(1).max(120).optional(),
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
  revision: revisionSchema,
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

export const revokeOrganizationAdministrationRoleAssignmentCommandSchema = z
  .object({
    roleAssignmentId: roleAssignmentIdSchema,
    expectedAssignmentRevision: revisionSchema,
  })
  .strict();

export const changeOrganizationAdministrationRoleAssignmentResultSchema = z
  .object({
    assignment: organizationAdministrationRoleAssignmentSchema,
    accessVersion: revisionSchema,
  })
  .strict();

export type AssignOrganizationAdministrationRoleAssignmentResult =
  | ChangeOrganizationAdministrationRoleAssignmentResult
  | Readonly<{ outcome: "refused"; code: "role_acceptance_required"; roleId: string }>;

export const assignOrganizationAdministrationRoleAssignmentCommandSchema = z
  .object({
    roleId: roleIdSchema,
    expectedRoleRevision: revisionSchema,
    assigneeKind: z.enum(["organization_account", "group"]),
    organizationAccountId: organizationAccountIdSchema.optional(),
    groupId: groupIdSchema.optional(),
    assignmentKind: z.enum(["standing", "eligible"]),
    startsAt: timestampSchema.optional(),
    expiresAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const accountAssignee = value.assigneeKind === "organization_account";
    if (accountAssignee !== (value.organizationAccountId !== undefined))
      context.addIssue({
        code: "custom",
        path: ["organizationAccountId"],
        message: "Only an organisation-account assignee names an organisation account",
      });
    if (accountAssignee === (value.groupId !== undefined))
      context.addIssue({
        code: "custom",
        path: ["groupId"],
        message: "Only a Group assignee names a Group",
      });
    if (
      value.startsAt !== undefined &&
      value.expiresAt !== undefined &&
      Date.parse(value.expiresAt) <= Date.parse(value.startsAt)
    )
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Assignment expiry must follow its start",
      });
  });

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

/** Catalogue delegation is separate from role permissions and stewardship. */
export const grantOrganizationAdministrationDelegationAuthorityCommandSchema = z
  .object({
    holderKind: z.enum(["organization_account", "group"]),
    holderId: z.union([organizationAccountIdSchema, groupIdSchema]),
    expectedHolderRevision: revisionSchema,
  })
  .strict();

export const revokeOrganizationAdministrationDelegationAuthorityCommandSchema = z
  .object({
    delegationAuthorityId: delegationAuthorityIdSchema,
    expectedDelegationRevision: revisionSchema,
  })
  .strict();

export const changeOrganizationAdministrationDelegationAuthorityResultSchema = z
  .object({
    delegation: organizationAdministrationDelegationAuthoritySchema,
    accessVersion: revisionSchema,
  })
  .strict();

export const organizationAdministrationRoleActivationTemporalStateSchema = z.enum([
  "active",
  "expired",
  "revoked",
]);

const organizationAdministrationRoleActivationFields = {
  roleActivationId: roleActivationIdSchema,
  beneficiary: z
    .object({
      organizationAccountId: organizationAccountIdSchema,
      // A person who has just joined has no display name until they set their profile.
      displayName: z.string().trim().min(1).max(120).optional(),
    })
    .strict(),
  role: organizationAdministrationAssignedRoleSchema,
  revision: revisionSchema,
  historicalRoleRevision: revisionSchema,
  activatedAt: timestampSchema,
  expiresAt: timestampSchema,
  state: z.enum(["live", "revoked"]),
  temporalState: organizationAdministrationRoleActivationTemporalStateSchema,
};

const addOrganizationAdministrationRoleActivationIssues = (
  value: {
    activatedAt: string;
    expiresAt: string;
    state: "live" | "revoked";
    temporalState: "active" | "expired" | "revoked";
  },
  context: z.RefinementCtx,
) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.activatedAt))
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Activation expiry must follow activation",
    });
  if ((value.state === "revoked") !== (value.temporalState === "revoked"))
    context.addIssue({
      code: "custom",
      path: ["temporalState"],
      message: "Only a revoked activation has revoked temporal state",
    });
};

export const organizationAdministrationRoleActivationSummarySchema = z
  .object({
    ...organizationAdministrationRoleActivationFields,
    eligibilitySourceKind: z.enum(["direct", "group"]),
  })
  .strict()
  .superRefine(addOrganizationAdministrationRoleActivationIssues);

export const deactivateOrganizationAdministrationRoleActivationCommandSchema = z
  .object({
    roleActivationId: roleActivationIdSchema,
    expectedActivationRevision: revisionSchema,
  })
  .strict();

export const changeOrganizationAdministrationRoleActivationResultSchema = z
  .object({
    activation: organizationAdministrationRoleActivationSummarySchema,
    accessVersion: revisionSchema,
  })
  .strict();

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
export type RetireOrganizationAdministrationGroupCommand = z.infer<
  typeof retireOrganizationAdministrationGroupCommandSchema
>;
export type ChangeOrganizationAdministrationGroupResult = z.infer<
  typeof changeOrganizationAdministrationGroupResultSchema
>;
export type RemoveOrganizationAdministrationMembershipCommand = z.infer<
  typeof removeOrganizationAdministrationMembershipCommandSchema
>;
export type ChangeOrganizationAdministrationMembershipResult = z.infer<
  typeof changeOrganizationAdministrationMembershipResultSchema
>;
export type OrganizationAdministrationRoleSummary = z.infer<
  typeof organizationAdministrationRoleSummarySchema
>;
export type ReadOrganizationAdministrationRoleCommand = z.infer<
  typeof readOrganizationAdministrationRoleCommandSchema
>;
export type ReadOrganizationAdministrationRoleResult = z.infer<
  typeof readOrganizationAdministrationRoleResultSchema
>;
export type ReviseOrganizationAdministrationRoleMetadataCommand = z.infer<
  typeof reviseOrganizationAdministrationRoleMetadataCommandSchema
>;
export type RetireOrganizationAdministrationRoleCommand = z.infer<
  typeof retireOrganizationAdministrationRoleCommandSchema
>;
export type ChangeOrganizationAdministrationRoleAuthorityCommand = z.infer<
  typeof changeOrganizationAdministrationRoleAuthorityCommandSchema
>;
export type ChangeOrganizationAdministrationRoleResult = z.infer<
  typeof changeOrganizationAdministrationRoleResultSchema
>;
export type PrepareOrganizationAdministrationRoleChangeCommand = z.infer<
  typeof prepareOrganizationAdministrationRoleChangeCommandSchema
>;
export type PrepareOrganizationAdministrationRoleRevisionAcceptanceCommand = z.infer<
  typeof prepareOrganizationAdministrationRoleRevisionAcceptanceCommandSchema
>;
export type RevokeOrganizationAdministrationRoleAssignmentCommand = z.infer<
  typeof revokeOrganizationAdministrationRoleAssignmentCommandSchema
>;
export type ChangeOrganizationAdministrationRoleAssignmentResult = z.infer<
  typeof changeOrganizationAdministrationRoleAssignmentResultSchema
>;
export type RevokeOrganizationAdministrationDelegationAuthorityCommand = z.infer<
  typeof revokeOrganizationAdministrationDelegationAuthorityCommandSchema
>;
export type ChangeOrganizationAdministrationDelegationAuthorityResult = z.infer<
  typeof changeOrganizationAdministrationDelegationAuthorityResultSchema
>;
export type DeactivateOrganizationAdministrationRoleActivationCommand = z.infer<
  typeof deactivateOrganizationAdministrationRoleActivationCommandSchema
>;
export type ChangeOrganizationAdministrationRoleActivationResult = z.infer<
  typeof changeOrganizationAdministrationRoleActivationResultSchema
>;
export type AddOrganizationAdministrationMembershipCommand = z.infer<
  typeof addOrganizationAdministrationMembershipCommandSchema
>;
export type AssignOrganizationAdministrationRoleAssignmentCommand = z.infer<
  typeof assignOrganizationAdministrationRoleAssignmentCommandSchema
>;

export type GrantOrganizationAdministrationDelegationAuthorityCommand = z.infer<
  typeof grantOrganizationAdministrationDelegationAuthorityCommandSchema
>;
