import { z } from "zod";
import { correlationIdSchema, descriptionSchema, labelSchema } from "../catalogue/common";
import {
  actorIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  fingerprintSchema,
  organizationIdSchema,
  revisionSchema,
  roleActivationPolicyIdSchema,
  roleIdSchema,
} from "../catalogue/identifiers";
import {
  affectedRoleAssignmentManifestSchema,
  affectedRoleAssignmentSchema,
  roleActivationPolicyReferenceSchema,
  roleActivationPolicyRevisionSchema,
  rolePermissionEntrySchema,
  rolePrivilegeClassificationSchema,
  roleRecentAuthenticationRequirementSchema,
  roleSchema,
} from "./organization-access-catalogue";

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
    revision: revisionSchema,
    maximumActivationDurationSeconds: z
      .number()
      .finite()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    reasonRequired: z.boolean(),
    recentAuthentication: roleRecentAuthenticationRequirementSchema,
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

/**
 * The Application registration a template role change is prepared from. The writer reads the
 * source role's live permissions from this exact registration revision, so the evidence names the
 * registration instead of carrying its entries.
 */
export const organizationRoleTemplateSourceSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    registrationRevision: revisionSchema,
    releaseRevision: revisionSchema,
    catalogueFingerprint: fingerprintSchema,
  })
  .strict();

const currentTemplateFields = {
  templateSource: organizationRoleTemplateSourceSchema,
  sourceRoleId: roleIdSchema,
  templateContinuityRevision: revisionSchema,
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
      expectedRoleRevision: revisionSchema,
      ...roleConfigurationFields,
    })
    .strict(),
  z
    .object({
      operation: z.literal("revise_custom_permissions"),
      ...roleIdentityFields,
      expectedRoleRevision: revisionSchema,
      ...roleConfigurationFields,
      permissions: roleChangePermissionSetSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("accept_application_role_revision"),
      ...roleIdentityFields,
      expectedRoleRevision: revisionSchema,
      ...roleConfigurationFields,
      ...currentTemplateFields,
    })
    .strict(),
  z
    .object({
      operation: z.literal("retire_role"),
      ...roleIdentityFields,
      expectedRoleRevision: revisionSchema,
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

/**
 * Every permission of a template role change references the named registration revision and
 * catalogue. Whether the set is exactly the template's live projection is the writer's check: it
 * reads that projection from the registration in the same transaction.
 */
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
  const source = candidate.templateSource;
  if (
    candidate.permissions.some(
      (permission) =>
        permission.acceptedRegistrationRevision !== source.registrationRevision ||
        permission.catalogueFingerprint !== source.catalogueFingerprint,
    )
  )
    context.addIssue({
      code: "custom",
      path: ["candidate", "permissions"],
      message: "Template role permissions must come from the named Application registration",
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
    affectedAssignmentManifest: roleChangeManifestSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const candidate = value.candidate;
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
        normalizedUuid(manifest.roleId) !== normalizedUuid(candidate.roleId))
    )
      context.addIssue({
        code: "custom",
        path: ["affectedAssignmentManifest"],
        message: "The assignment manifest must name the role candidate's organization and role",
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
    accessVersion: revisionSchema,
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
