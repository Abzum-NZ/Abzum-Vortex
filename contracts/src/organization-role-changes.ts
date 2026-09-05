import { z } from "zod";
import { correlationIdSchema, descriptionSchema, labelSchema } from "./common";
import {
  actorIdSchema,
  builderKeySchema,
  fingerprintSchema,
  organizationIdSchema,
  revisionSchema,
  roleActivationPolicyIdSchema,
  roleIdSchema,
} from "./identifiers";
import {
  affectedRoleAssignmentManifestSchema,
  affectedRoleAssignmentSchema,
  preparedApplicationRoleTemplatesSchema,
  roleActivationPolicyReferenceSchema,
  roleActivationPolicyRevisionSchema,
  rolePermissionEntrySchema,
  rolePrivilegeClassificationSchema,
  roleRecentAuthenticationRequirementSchema,
  roleSchema,
} from "./organization-access-catalogue";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);
const normalizedUuid = (value: string): string => value.toLowerCase();
const representsSameInstant = (left: string, right: string): boolean =>
  Date.parse(left) === Date.parse(right);

const permissionIdentity = (permission: z.infer<typeof rolePermissionEntrySchema>) => [
  permission.applicationRootId === undefined
    ? undefined
    : normalizedUuid(permission.applicationRootId),
  permission.ownerKind,
  normalizedUuid(permission.ownerId),
  normalizedUuid(permission.permissionId),
];

const comparePermissionIdentity = (
  left: z.infer<typeof rolePermissionEntrySchema>,
  right: z.infer<typeof rolePermissionEntrySchema>,
): number => {
  const leftIdentity = permissionIdentity(left);
  const rightIdentity = permissionIdentity(right);
  for (let index = 0; index < leftIdentity.length; index += 1) {
    const leftValue = leftIdentity[index];
    const rightValue = rightIdentity[index];
    if (leftValue === rightValue) continue;
    if (leftValue === undefined) return 1;
    if (rightValue === undefined) return -1;
    return leftValue < rightValue ? -1 : 1;
  }
  return 0;
};

const roleChangePermissionSetSchema = z
  .array(rolePermissionEntrySchema)
  .min(1)
  .superRefine((permissions, context) => {
    const identities = permissions.map((permission) =>
      JSON.stringify(permissionIdentity(permission)),
    );
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        message: "Role-change permission identities must be unique",
      });
  });

export const organizationRoleNewActivationPolicySchema = z
  .object({
    activationPolicyId: roleActivationPolicyIdSchema,
    revision: javascriptSafeRevisionSchema,
    maximumActivationDurationSeconds: z
      .number()
      .finite()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    reasonRequired: z.boolean(),
    recentAuthentication: roleRecentAuthenticationRequirementSchema,
    independentApprovalRequired: z.boolean(),
  })
  .strict();

export const organizationRolePolicyChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("standing") }).strict(),
  z
    .object({
      kind: z.literal("activation_required"),
      activationPolicy: z.discriminatedUnion("selection", [
        z
          .object({
            selection: z.literal("existing"),
            reference: roleActivationPolicyReferenceSchema,
          })
          .strict(),
        z
          .object({
            selection: z.literal("new"),
            policy: organizationRoleNewActivationPolicySchema,
          })
          .strict(),
      ]),
    })
    .strict(),
]);

const roleConfigurationFields = {
  key: builderKeySchema,
  label: labelSchema,
  description: descriptionSchema,
  privilegeClassification: rolePrivilegeClassificationSchema,
  assignmentPolicy: organizationRolePolicyChoiceSchema,
};

const roleIdentityFields = {
  organizationId: organizationIdSchema,
  roleId: roleIdSchema,
};

const currentTemplateFields = {
  preparedTemplates: preparedApplicationRoleTemplatesSchema,
  sourceRoleId: roleIdSchema,
  templateContinuityRevision: javascriptSafeRevisionSchema,
  permissions: roleChangePermissionSetSchema,
};

export const organizationRoleChangeCandidateSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create_custom"),
      ...roleIdentityFields,
      ...roleConfigurationFields,
      permissions: roleChangePermissionSetSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("create_custom_from_template"),
      ...roleIdentityFields,
      ...roleConfigurationFields,
      ...currentTemplateFields,
    })
    .strict(),
  z
    .object({
      operation: z.literal("accept_new_application_role"),
      ...roleIdentityFields,
      ...roleConfigurationFields,
      ...currentTemplateFields,
    })
    .strict(),
  z
    .object({
      operation: z.literal("revise_metadata_policy"),
      ...roleIdentityFields,
      expectedRoleRevision: javascriptSafeRevisionSchema,
      ...roleConfigurationFields,
    })
    .strict(),
  z
    .object({
      operation: z.literal("revise_custom_permissions"),
      ...roleIdentityFields,
      expectedRoleRevision: javascriptSafeRevisionSchema,
      ...roleConfigurationFields,
      permissions: roleChangePermissionSetSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("accept_application_role_revision"),
      ...roleIdentityFields,
      expectedRoleRevision: javascriptSafeRevisionSchema,
      ...roleConfigurationFields,
      ...currentTemplateFields,
    })
    .strict(),
  z
    .object({
      operation: z.literal("retire_role"),
      ...roleIdentityFields,
      expectedRoleRevision: javascriptSafeRevisionSchema,
    })
    .strict(),
]);

const hasTemplateEvidence = (
  candidate: z.infer<typeof organizationRoleChangeCandidateSchema>,
): candidate is Extract<
  z.infer<typeof organizationRoleChangeCandidateSchema>,
  {
    operation:
      | "create_custom_from_template"
      | "accept_new_application_role"
      | "accept_application_role_revision";
  }
> =>
  candidate.operation === "create_custom_from_template" ||
  candidate.operation === "accept_new_application_role" ||
  candidate.operation === "accept_application_role_revision";

const isApplicationAcceptance = (
  candidate: z.infer<typeof organizationRoleChangeCandidateSchema>,
): boolean =>
  candidate.operation === "accept_new_application_role" ||
  candidate.operation === "accept_application_role_revision";

const newPolicy = (candidate: z.infer<typeof organizationRoleChangeCandidateSchema>) => {
  if (!("assignmentPolicy" in candidate)) return undefined;
  return candidate.assignmentPolicy.kind === "activation_required" &&
    candidate.assignmentPolicy.activationPolicy.selection === "new"
    ? candidate.assignmentPolicy.activationPolicy.policy
    : undefined;
};

const permissionEvidenceMatches = (
  permission: z.infer<typeof rolePermissionEntrySchema>,
  source: z.infer<
    typeof preparedApplicationRoleTemplatesSchema
  >["templates"][number]["livePermissions"][number],
  registrationRevision: number,
  catalogueFingerprint: string,
): boolean =>
  JSON.stringify(permissionIdentity(permission)) ===
    JSON.stringify([
      normalizedUuid(source.applicationRootId),
      source.ownerKind,
      normalizedUuid(source.ownerId),
      normalizedUuid(source.permission.permissionId),
    ]) &&
  permission.acceptedRegistrationRevision === registrationRevision &&
  permission.catalogueFingerprint === catalogueFingerprint &&
  permission.meaningFingerprint === source.meaningFingerprint;

const addTemplateEvidenceIssues = (
  candidate: Extract<
    z.infer<typeof organizationRoleChangeCandidateSchema>,
    {
      operation:
        | "create_custom_from_template"
        | "accept_new_application_role"
        | "accept_application_role_revision";
    }
  >,
  context: z.RefinementCtx,
) => {
  const prepared = candidate.preparedTemplates;
  const registrationRevision =
    prepared.preparationBasis.kind === "current_active_registration"
      ? prepared.preparationBasis.registrationRevision
      : undefined;
  if (
    registrationRevision === undefined ||
    normalizedUuid(prepared.permissionRegistration.organizationId) !==
      normalizedUuid(candidate.organizationId)
  ) {
    context.addIssue({
      code: "custom",
      path: ["candidate", "preparedTemplates"],
      message: "Role acceptance requires current same-organization template evidence",
    });
    return;
  }

  const selected = prepared.templates.filter(
    (entry) => normalizedUuid(entry.template.roleId) === normalizedUuid(candidate.sourceRoleId),
  );
  if (selected.length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["candidate", "sourceRoleId"],
      message: "Role acceptance requires one exact prepared source role",
    });
    return;
  }

  const livePermissions = selected[0]!.livePermissions;
  const matches = candidate.permissions.map((permission) =>
    livePermissions.filter((source) =>
      permissionEvidenceMatches(
        permission,
        source,
        registrationRevision,
        prepared.permissionRegistration.applicationCatalogueFingerprint,
      ),
    ),
  );
  if (
    matches.some((entries) => entries.length !== 1) ||
    (isApplicationAcceptance(candidate) && candidate.permissions.length !== livePermissions.length)
  )
    context.addIssue({
      code: "custom",
      path: ["candidate", "permissions"],
      message:
        candidate.operation === "create_custom_from_template"
          ? "A custom template copy may contain only current live template permissions"
          : "Application role acceptance requires the complete current live template projection",
    });
};

const roleChangeManifestSchema = affectedRoleAssignmentManifestSchema.superRefine(
  (manifest, context) => {
    const identities = manifest.assignments.map((assignment) =>
      normalizedUuid(assignment.roleAssignmentId),
    );
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["assignments"],
        message: "Affected assignments must be unique after UUID normalization",
      });
    if (identities.some((identity, index) => index > 0 && identities[index - 1]! > identity))
      context.addIssue({
        code: "custom",
        path: ["assignments"],
        message: "Affected assignments must use normalized identifier order",
      });
  },
);

export const preparedOrganizationRoleChangeSchema = z
  .object({
    contractVersion: z.literal("1.0.0"),
    candidate: organizationRoleChangeCandidateSchema,
    newActivationPolicyFingerprint: fingerprintSchema.optional(),
    acceptedGrantFingerprint: fingerprintSchema.optional(),
    roleCandidateFingerprint: fingerprintSchema,
    affectedAssignmentManifest: roleChangeManifestSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const candidate = value.candidate;
    const policyIsNew = newPolicy(candidate) !== undefined;
    if (policyIsNew !== (value.newActivationPolicyFingerprint !== undefined))
      context.addIssue({
        code: "custom",
        path: ["newActivationPolicyFingerprint"],
        message: "New policy evidence is present exactly when a policy revision is created",
      });
    if (isApplicationAcceptance(candidate) !== (value.acceptedGrantFingerprint !== undefined))
      context.addIssue({
        code: "custom",
        path: ["acceptedGrantFingerprint"],
        message: "Application acceptance requires its separate provenance fingerprint",
      });

    const permissions = "permissions" in candidate ? candidate.permissions : undefined;
    if (
      permissions?.some(
        (permission, index) =>
          index > 0 && comparePermissionIdentity(permissions[index - 1]!, permission) >= 0,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["candidate", "permissions"],
        message: "Role-change permissions must use deterministic normalized identity order",
      });

    if (hasTemplateEvidence(candidate)) addTemplateEvidenceIssues(candidate, context);

    const manifest = value.affectedAssignmentManifest;
    if (
      (candidate.operation === "create_custom" ||
        candidate.operation === "create_custom_from_template" ||
        candidate.operation === "accept_new_application_role" ||
        candidate.operation === "retire_role") &&
      manifest !== undefined
    )
      context.addIssue({
        code: "custom",
        path: ["affectedAssignmentManifest"],
        message: "This role-change intent cannot carry an affected-assignment manifest",
      });
    if (
      manifest !== undefined &&
      (normalizedUuid(manifest.organizationId) !== normalizedUuid(candidate.organizationId) ||
        normalizedUuid(manifest.roleId) !== normalizedUuid(candidate.roleId) ||
        manifest.roleCandidateFingerprint !== value.roleCandidateFingerprint)
    )
      context.addIssue({
        code: "custom",
        path: ["affectedAssignmentManifest"],
        message: "The assignment manifest must bind the exact role candidate",
      });
  });

export const organizationRoleChangePreparationSchema = z
  .object({
    candidate: organizationRoleChangeCandidateSchema,
    affectedAssignments: z.array(affectedRoleAssignmentSchema).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = value.affectedAssignments?.map((assignment) =>
      normalizedUuid(assignment.roleAssignmentId),
    );
    if (identities !== undefined && new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["affectedAssignments"],
        message: "Affected assignments must be unique after UUID normalization",
      });
  });

export const organizationRoleChangeCommandSchema = z
  .object({
    evidence: preparedOrganizationRoleChangeSchema,
    changedBy: actorIdSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export const organizationRoleChangeResultSchema = z
  .object({
    outcome: z.literal("changed"),
    operation: z.enum([
      "create_custom",
      "create_custom_from_template",
      "accept_new_application_role",
      "revise_metadata_policy",
      "revise_custom_permissions",
      "accept_application_role_revision",
      "retire_role",
    ]),
    role: roleSchema,
    createdActivationPolicy: roleActivationPolicyRevisionSchema.optional(),
    accessVersion: javascriptSafeRevisionSchema,
    correlationId: correlationIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const policy = value.createdActivationPolicy;
    if (value.operation === "retire_role" && policy !== undefined)
      context.addIssue({
        code: "custom",
        path: ["createdActivationPolicy"],
        message: "Role retirement cannot create an activation policy",
      });
    if (
      policy !== undefined &&
      (normalizedUuid(policy.organizationId) !== normalizedUuid(value.role.organizationId) ||
        normalizedUuid(policy.roleId) !== normalizedUuid(value.role.roleId) ||
        value.role.assignmentPolicy.kind !== "activation_required" ||
        normalizedUuid(value.role.assignmentPolicy.activationPolicy.activationPolicyId) !==
          normalizedUuid(policy.activationPolicyId) ||
        value.role.assignmentPolicy.activationPolicy.revision !== policy.revision ||
        value.role.assignmentPolicy.activationPolicy.fingerprint !== policy.fingerprint ||
        policy.changedByActorId !== value.role.changedByActorId ||
        policy.changeCorrelationId !== value.correlationId ||
        !representsSameInstant(policy.changedAt, value.role.changedAt))
    )
      context.addIssue({
        code: "custom",
        path: ["createdActivationPolicy"],
        message:
          "A created policy must be the exact policy created with and referenced by the role",
      });

    if (value.role.changeCorrelationId !== value.correlationId)
      context.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: "The result must be bound to the stored role change",
      });

    const createOperation =
      value.operation.startsWith("create_") || value.operation === "accept_new_application_role";
    if (
      (createOperation && value.role.liveRevision !== 1) ||
      (!createOperation && value.role.liveRevision <= 1)
    )
      context.addIssue({
        code: "custom",
        path: ["role", "liveRevision"],
        message: "The stored role revision must match the change intent",
      });
    if (
      ((value.operation === "create_custom" ||
        value.operation === "create_custom_from_template" ||
        value.operation === "revise_custom_permissions") &&
        (value.role.kind !== "custom" || value.role.lifecycle !== "active")) ||
      ((value.operation === "accept_new_application_role" ||
        value.operation === "accept_application_role_revision") &&
        (value.role.kind !== "application" || value.role.lifecycle !== "active")) ||
      (value.operation === "retire_role" && value.role.lifecycle !== "retired")
    )
      context.addIssue({
        code: "custom",
        path: ["role"],
        message: "The stored role kind and lifecycle must match the change intent",
      });
  });

export type OrganizationRoleNewActivationPolicy = z.infer<
  typeof organizationRoleNewActivationPolicySchema
>;
export type OrganizationRolePolicyChoice = z.infer<typeof organizationRolePolicyChoiceSchema>;
export type OrganizationRoleChangeCandidate = z.infer<typeof organizationRoleChangeCandidateSchema>;
export type OrganizationRoleChangePreparation = z.infer<
  typeof organizationRoleChangePreparationSchema
>;
export type PreparedOrganizationRoleChange = z.infer<typeof preparedOrganizationRoleChangeSchema>;
export type OrganizationRoleChangeCommand = z.infer<typeof organizationRoleChangeCommandSchema>;
export type OrganizationRoleChangeResult = z.infer<typeof organizationRoleChangeResultSchema>;
