import { z } from "zod";
import { applicationRoleSchema } from "./application-contracts";
import { correlationIdSchema, descriptionSchema, labelSchema } from "./common";
import {
  actorIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  delegationAuthorityIdSchema,
  fingerprintSchema,
  groupIdSchema,
  membershipIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  permissionIdSchema,
  platformIdSchema,
  revisionSchema,
  roleActivationIdSchema,
  roleActivationPolicyIdSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
  timestampSchema,
} from "./identifiers";
import {
  permissionRegistryDefinitionReleaseSchema,
  permissionRegistryEntryCandidateSchema,
  preparedApplicationPermissionRegistrationSchema,
} from "./permission-registry";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);
const javascriptSafeDurationSecondsSchema = z
  .number()
  .finite()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const applicationReleaseEvidenceSchema = permissionRegistryDefinitionReleaseSchema.and(
  z.object({ kind: z.literal("application") }),
);

const addPermissionScopeIssue = (
  value: { applicationRootId?: string | undefined; ownerKind: string; ownerId: string },
  context: z.RefinementCtx,
) => {
  if ((value.ownerKind === "platform") !== (value.applicationRootId === undefined))
    context.addIssue({
      code: "custom",
      path: ["applicationRootId"],
      message: "Only application and module permissions carry application context",
    });
  if (
    value.ownerKind === "application" &&
    String(value.ownerId) !== String(value.applicationRootId)
  )
    context.addIssue({
      code: "custom",
      path: ["ownerId"],
      message: "An application permission must match its application context",
    });
};

const exactPermissionScopeFields = {
  applicationRootId: applicationRootIdSchema.optional(),
  ownerKind: z.enum(["platform", "application", "module"]),
  ownerId: platformIdSchema,
  permissionId: permissionIdSchema,
};

/** Exact accepted use/delegation authority. Keys and display labels are deliberately absent. */
export const rolePermissionEntrySchema = z
  .object({
    kind: z.literal("exact"),
    ...exactPermissionScopeFields,
    acceptedRegistrationRevision: javascriptSafeRevisionSchema,
    catalogueFingerprint: fingerprintSchema,
    continuityRevision: javascriptSafeRevisionSchema,
    meaningFingerprint: fingerprintSchema,
  })
  .strict()
  .superRefine(addPermissionScopeIssue);

/** Retained package export, corrected from the unused legacy wildcard union to exact live authority. */
export const permissionEntrySchema = rolePermissionEntrySchema;

const rolePermissionSetSchema = z
  .array(rolePermissionEntrySchema)
  .superRefine((entries, context) => {
    const identities = entries.map(
      (entry) =>
        `${entry.applicationRootId ?? "platform"}:${entry.ownerKind}:${entry.ownerId}:${entry.permissionId}`,
    );
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        message: "A role permission identity may appear only once",
      });
  });

const creationAndChangeEvidenceFields = {
  createdByActorId: actorIdSchema,
  createdAt: timestampSchema,
  changedByActorId: actorIdSchema,
  changedAt: timestampSchema,
  changeCorrelationId: correlationIdSchema,
};

const addCreationTimeIssue = (
  value: { createdAt: string; changedAt: string },
  context: z.RefinementCtx,
) => {
  if (Date.parse(value.changedAt) < Date.parse(value.createdAt))
    context.addIssue({
      code: "custom",
      path: ["changedAt"],
      message: "The last change cannot precede creation",
    });
};

/** Protected classification is independent from whether assignments are standing or activated. */
export const rolePrivilegeClassificationSchema = z.enum(["standard", "privileged"]);

export const roleRecentAuthenticationRequirementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("primary"),
      maximumAgeSeconds: javascriptSafeDurationSecondsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("multi_factor"),
      maximumAgeSeconds: javascriptSafeDurationSecondsSchema,
    })
    .strict(),
]);

/** Exact immutable policy evidence pinned by an activation-required role revision. */
export const roleActivationPolicyReferenceSchema = z
  .object({
    activationPolicyId: roleActivationPolicyIdSchema,
    revision: javascriptSafeRevisionSchema,
    fingerprint: fingerprintSchema,
  })
  .strict();

export const roleAssignmentPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("standing") }).strict(),
  z
    .object({
      kind: z.literal("activation_required"),
      activationPolicy: roleActivationPolicyReferenceSchema,
    })
    .strict(),
]);

/** Role-scoped immutable activation-policy revision; #34 remains the sole decision boundary. */
export const roleActivationPolicyRevisionSchema = z
  .object({
    organizationId: organizationIdSchema,
    roleId: roleIdSchema,
    activationPolicyId: roleActivationPolicyIdSchema,
    revision: javascriptSafeRevisionSchema,
    fingerprint: fingerprintSchema,
    maximumActivationDurationSeconds: javascriptSafeDurationSecondsSchema,
    reasonRequired: z.boolean(),
    recentAuthentication: roleRecentAuthenticationRequirementSchema,
    independentApprovalRequired: z.boolean(),
    changedByActorId: actorIdSchema,
    changedAt: timestampSchema,
    changeCorrelationId: correlationIdSchema,
  })
  .strict();

export const applicationRoleSourceReferenceSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    sourceRoleId: roleIdSchema,
    sourceRelease: applicationReleaseEvidenceSchema,
    sourceTemplateFingerprint: fingerprintSchema,
    sourceCatalogueFingerprint: fingerprintSchema,
    acceptedRegistrationRevision: javascriptSafeRevisionSchema,
    templateContinuityRevision: javascriptSafeRevisionSchema,
    acceptedGrantFingerprint: fingerprintSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (String(value.sourceRelease.rootId) !== String(value.applicationRootId))
      context.addIssue({
        code: "custom",
        path: ["sourceRelease"],
        message: "The source release must match the role's application context",
      });
  });

export const customRoleTemplateProvenanceSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    sourceRoleId: roleIdSchema,
    sourceRelease: applicationReleaseEvidenceSchema,
    sourceTemplateFingerprint: fingerprintSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (String(value.sourceRelease.rootId) !== String(value.applicationRootId))
      context.addIssue({
        code: "custom",
        path: ["sourceRelease"],
        message: "Template provenance must retain its exact application release",
      });
  });

const liveRoleFields = {
  roleId: roleIdSchema,
  organizationId: organizationIdSchema,
  key: builderKeySchema,
  label: labelSchema,
  description: descriptionSchema,
  liveRevision: javascriptSafeRevisionSchema,
  privilegeClassification: rolePrivilegeClassificationSchema,
  assignmentPolicy: roleAssignmentPolicySchema,
  policyContinuityRevision: javascriptSafeRevisionSchema,
  authorityContinuityRevision: javascriptSafeRevisionSchema,
  permissions: rolePermissionSetSchema,
  ...creationAndChangeEvidenceFields,
};

const applicationRoleRegistrationSchema = z
  .object({
    ...liveRoleFields,
    kind: z.literal("application"),
    lifecycle: z.enum(["active", "acceptance_required", "unavailable", "retired"]),
    applicationRootId: applicationRootIdSchema,
    source: applicationRoleSourceReferenceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addCreationTimeIssue(value, context);
    if (String(value.source.applicationRootId) !== String(value.applicationRootId))
      context.addIssue({
        code: "custom",
        path: ["source", "applicationRootId"],
        message: "The source and assignable role must use one application context",
      });
    if (value.permissions.length === 0 && value.lifecycle === "active")
      context.addIssue({
        code: "custom",
        path: ["permissions"],
        message: "An active application role requires accepted permissions",
      });
    if (
      value.permissions.some(
        (permission) =>
          permission.ownerKind === "platform" ||
          String(permission.applicationRootId) !== String(value.applicationRootId) ||
          permission.catalogueFingerprint !== value.source.sourceCatalogueFingerprint ||
          permission.acceptedRegistrationRevision !== value.source.acceptedRegistrationRevision,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["permissions"],
        message:
          "An application role requires one exact application registration and catalogue scope",
      });
  });

const customRoleSchema = z
  .object({
    ...liveRoleFields,
    kind: z.literal("custom"),
    lifecycle: z.enum(["active", "retired"]),
    permissions: rolePermissionSetSchema.min(1),
    derivedFromTemplate: customRoleTemplateProvenanceSchema.optional(),
  })
  .strict()
  .superRefine(addCreationTimeIssue);

export const roleSchema = z.discriminatedUnion("kind", [
  applicationRoleRegistrationSchema,
  customRoleSchema,
]);

export const groupSchema = z
  .object({
    groupId: groupIdSchema,
    organizationId: organizationIdSchema,
    key: builderKeySchema,
    label: labelSchema,
    state: z.enum(["active", "retired"]),
    revision: javascriptSafeRevisionSchema,
    ...creationAndChangeEvidenceFields,
  })
  .strict()
  .superRefine(addCreationTimeIssue);

export const accessAssigneeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("organization_account"),
      organizationAccountId: organizationAccountIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("group"), groupId: groupIdSchema }).strict(),
]);

const effectiveGrantStateSchema = z.enum(["scheduled", "active", "expired", "revoked"]);
const temporalGrantFields = {
  startsAt: timestampSchema,
  expiresAt: timestampSchema.optional(),
  state: z.enum(["live", "revoked"]),
  grantedByActorId: actorIdSchema,
  grantedAt: timestampSchema,
  grantCorrelationId: correlationIdSchema,
  changedByActorId: actorIdSchema,
  changeCorrelationId: correlationIdSchema,
  revokedByActorId: actorIdSchema.optional(),
  revokedAt: timestampSchema.optional(),
  revocationCorrelationId: correlationIdSchema.optional(),
  changedAt: timestampSchema,
};

const addTemporalGrantIssues = (
  value: {
    startsAt: string;
    expiresAt?: string | undefined;
    state: "live" | "revoked";
    grantedAt: string;
    revokedByActorId?: string | undefined;
    revokedAt?: string | undefined;
    revocationCorrelationId?: string | undefined;
    changedAt: string;
  },
  context: z.RefinementCtx,
) => {
  if (value.expiresAt !== undefined && Date.parse(value.expiresAt) <= Date.parse(value.startsAt))
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Expiry must be later than the effective start",
    });
  const hasAnyRevocation =
    value.revokedByActorId !== undefined ||
    value.revokedAt !== undefined ||
    value.revocationCorrelationId !== undefined;
  const hasCompleteRevocation =
    value.revokedByActorId !== undefined &&
    value.revokedAt !== undefined &&
    value.revocationCorrelationId !== undefined;
  if (
    (value.state === "live" && hasAnyRevocation) ||
    (value.state === "revoked" && !hasCompleteRevocation)
  )
    context.addIssue({
      code: "custom",
      path: ["revokedAt"],
      message: "Revocation evidence is present exactly when the grant is revoked",
    });
  if (value.revokedAt !== undefined && Date.parse(value.revokedAt) < Date.parse(value.grantedAt))
    context.addIssue({
      code: "custom",
      path: ["revokedAt"],
      message: "Revocation cannot precede the grant",
    });
  if (Date.parse(value.changedAt) < Date.parse(value.grantedAt))
    context.addIssue({
      code: "custom",
      path: ["changedAt"],
      message: "The last change cannot precede the grant",
    });
  if (value.revokedAt !== undefined && Date.parse(value.changedAt) < Date.parse(value.revokedAt))
    context.addIssue({
      code: "custom",
      path: ["changedAt"],
      message: "The last change cannot precede revocation",
    });
};

export const groupMembershipSchema = z
  .object({
    membershipId: membershipIdSchema,
    organizationId: organizationIdSchema,
    groupId: groupIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    revision: javascriptSafeRevisionSchema,
    ...temporalGrantFields,
  })
  .strict()
  .superRefine(addTemporalGrantIssues);

export const groupMembershipEffectiveStateSchema = z
  .object({
    membership: groupMembershipSchema,
    effectiveState: effectiveGrantStateSchema,
  })
  .strict()
  .refine(
    (value) => (value.membership.state === "revoked") === (value.effectiveState === "revoked"),
    {
      path: ["effectiveState"],
      message: "Only a revoked membership has revoked effective state",
    },
  );

export const roleAssignmentKindSchema = z.enum(["standing", "eligible"]);

export const roleAssignmentSchema = z
  .object({
    roleAssignmentId: roleAssignmentIdSchema,
    organizationId: organizationIdSchema,
    roleId: roleIdSchema,
    assignee: accessAssigneeSchema,
    assignmentKind: roleAssignmentKindSchema,
    revision: javascriptSafeRevisionSchema,
    ...temporalGrantFields,
  })
  .strict()
  .superRefine(addTemporalGrantIssues);

/** Timing-only validity; an active eligible assignment is not effective permission. */
export const roleAssignmentEffectiveStateSchema = z
  .object({
    assignment: roleAssignmentSchema,
    effectiveState: effectiveGrantStateSchema,
  })
  .strict()
  .refine(
    (value) => (value.assignment.state === "revoked") === (value.effectiveState === "revoked"),
    {
      path: ["effectiveState"],
      message: "Only a revoked assignment has revoked effective state",
    },
  );

const exactEligibilityAssignmentReferenceSchema = z
  .object({
    roleAssignmentId: roleAssignmentIdSchema,
    revision: javascriptSafeRevisionSchema,
  })
  .strict();

const exactOriginatingMembershipReferenceSchema = z
  .object({
    membershipId: membershipIdSchema,
    revision: javascriptSafeRevisionSchema,
  })
  .strict();

export const roleActivationEligibilitySourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("direct"),
      eligibilityAssignment: exactEligibilityAssignmentReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("group"),
      eligibilityAssignment: exactEligibilityAssignmentReferenceSchema,
      originatingMembership: exactOriginatingMembershipReferenceSchema,
    })
    .strict(),
]);

const addRoleActivationIssues = (
  value: {
    state: "live" | "revoked";
    activatedAt: string;
    expiresAt: string;
    changedAt: string;
    revokedByActorId?: string | undefined;
    revokedAt?: string | undefined;
    revocationCorrelationId?: string | undefined;
  },
  context: z.RefinementCtx,
) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.activatedAt))
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Activation expiry must be later than activation",
    });

  const hasAnyRevocation =
    value.revokedByActorId !== undefined ||
    value.revokedAt !== undefined ||
    value.revocationCorrelationId !== undefined;
  const hasCompleteRevocation =
    value.revokedByActorId !== undefined &&
    value.revokedAt !== undefined &&
    value.revocationCorrelationId !== undefined;
  if (
    (value.state === "live" && hasAnyRevocation) ||
    (value.state === "revoked" && !hasCompleteRevocation)
  )
    context.addIssue({
      code: "custom",
      path: ["revokedAt"],
      message: "Revocation evidence is present exactly when the activation is revoked",
    });
  if (value.revokedAt !== undefined && Date.parse(value.revokedAt) < Date.parse(value.activatedAt))
    context.addIssue({
      code: "custom",
      path: ["revokedAt"],
      message: "Revocation cannot precede activation",
    });
  if (Date.parse(value.changedAt) < Date.parse(value.activatedAt))
    context.addIssue({
      code: "custom",
      path: ["changedAt"],
      message: "The last change cannot precede activation",
    });
  if (value.revokedAt !== undefined && Date.parse(value.changedAt) < Date.parse(value.revokedAt))
    context.addIssue({
      code: "custom",
      path: ["changedAt"],
      message: "The last change cannot precede revocation",
    });
};

/** Protected activation evidence only; #34 remains the sole effective-access decision boundary. */
export const roleActivationSchema = z
  .object({
    roleActivationId: roleActivationIdSchema,
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    roleId: roleIdSchema,
    revision: javascriptSafeRevisionSchema,
    historicalRoleRevision: javascriptSafeRevisionSchema,
    authorityContinuityRevision: javascriptSafeRevisionSchema,
    policyContinuityRevision: javascriptSafeRevisionSchema,
    activationPolicy: roleActivationPolicyReferenceSchema,
    eligibilitySource: roleActivationEligibilitySourceSchema,
    state: z.enum(["live", "revoked"]),
    activatedByActorId: actorIdSchema,
    activatedAt: timestampSchema,
    expiresAt: timestampSchema,
    activationCorrelationId: correlationIdSchema,
    changedByActorId: actorIdSchema,
    changedAt: timestampSchema,
    changeCorrelationId: correlationIdSchema,
    revokedByActorId: actorIdSchema.optional(),
    revokedAt: timestampSchema.optional(),
    revocationCorrelationId: correlationIdSchema.optional(),
  })
  .strict()
  .superRefine(addRoleActivationIssues);

/** Timing-only status; successful parsing does not establish current eligibility or permission. */
export const roleActivationTemporalStateSchema = z
  .object({
    activation: roleActivationSchema,
    temporalState: z.enum(["active", "expired", "revoked"]),
  })
  .strict()
  .refine(
    (value) => (value.activation.state === "revoked") === (value.temporalState === "revoked"),
    {
      path: ["temporalState"],
      message: "Only a revoked activation has revoked temporal state",
    },
  );

export const delegationScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("organization_catalogue") }).strict(),
  z
    .object({
      kind: z.literal("bounded"),
      permissions: rolePermissionSetSchema.min(1),
      scopeFingerprint: fingerprintSchema,
    })
    .strict(),
]);

export const delegationAuthoritySchema = z
  .object({
    delegationAuthorityId: delegationAuthorityIdSchema,
    organizationId: organizationIdSchema,
    holder: accessAssigneeSchema,
    scope: delegationScopeSchema,
    revision: javascriptSafeRevisionSchema,
    ...temporalGrantFields,
  })
  .strict()
  .superRefine(addTemporalGrantIssues);

export const delegationAuthorityEffectiveStateSchema = z
  .object({
    delegation: delegationAuthoritySchema,
    effectiveState: effectiveGrantStateSchema,
  })
  .strict()
  .refine(
    (value) => (value.delegation.state === "revoked") === (value.effectiveState === "revoked"),
    {
      path: ["effectiveState"],
      message: "Only revoked delegation has revoked effective state",
    },
  );

/** Current availability plus a retained tombstone; a later identical meaning starts new continuity. */
export const permissionContinuitySchema = z
  .object({
    organizationId: organizationIdSchema,
    ...exactPermissionScopeFields,
    state: z.enum(["available", "unavailable"]),
    continuityRevision: javascriptSafeRevisionSchema,
    meaningFingerprint: fingerprintSchema,
    lastProcessedRegistrationRevision: javascriptSafeRevisionSchema,
    changedAt: timestampSchema,
  })
  .strict()
  .superRefine(addPermissionScopeIssue);

export const applicationRoleTemplateContinuitySchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    sourceRoleId: roleIdSchema,
    state: z.enum(["available", "unavailable"]),
    continuityRevision: javascriptSafeRevisionSchema,
    sourceTemplateFingerprint: fingerprintSchema,
    lastProcessedRegistrationRevision: javascriptSafeRevisionSchema,
    changedAt: timestampSchema,
  })
  .strict();

export const affectedRoleAssignmentSchema = z
  .object({
    roleAssignmentId: roleAssignmentIdSchema,
    expectedRevision: javascriptSafeRevisionSchema,
    assignee: accessAssigneeSchema,
  })
  .strict();

export const affectedRoleAssignmentManifestSchema = z
  .object({
    organizationId: organizationIdSchema,
    roleId: roleIdSchema,
    roleCandidateFingerprint: fingerprintSchema,
    assignments: z.array(affectedRoleAssignmentSchema),
    manifestFingerprint: fingerprintSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const identities = value.assignments.map((assignment) => String(assignment.roleAssignmentId));
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["assignments"],
        message: "Affected assignments must be unique",
      });
    if (identities.some((identity, index) => index > 0 && identities[index - 1]! > identity))
      context.addIssue({
        code: "custom",
        path: ["assignments"],
        message: "Affected assignments must use deterministic identifier order",
      });
  });

export const preparedApplicationRoleTemplateSchema = z
  .object({
    template: applicationRoleSchema,
    sourceTemplateFingerprint: fingerprintSchema,
    sourcePermissions: z.array(permissionRegistryEntryCandidateSchema).min(1),
    livePermissions: z.array(permissionRegistryEntryCandidateSchema),
  })
  .strict();

export const applicationRoleTemplatePreparationBasisSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("registration_candidate") }).strict(),
  z
    .object({
      kind: z.literal("current_active_registration"),
      registrationRevision: javascriptSafeRevisionSchema,
    })
    .strict(),
]);

const permissionCandidateEvidenceKey = (
  entry: z.infer<typeof permissionRegistryEntryCandidateSchema>,
) =>
  JSON.stringify([
    entry.applicationRootId,
    entry.ownerKind,
    entry.ownerId,
    entry.permission.permissionId,
    entry.permission.key,
    entry.permission.label,
    entry.permission.description,
    entry.permission.recordTypeId ?? null,
    entry.permission.actionKind,
    entry.permission.namedAction ?? null,
    entry.permission.administrative,
    entry.sourceRelease.kind,
    entry.sourceRelease.rootId,
    entry.sourceRelease.definitionKey,
    entry.sourceRelease.releaseRevision,
    entry.sourceRelease.releaseVersion,
    entry.sourceRelease.validationContractVersion,
    entry.sourceRelease.contentFingerprint,
    entry.sourceRelease.resolutionFingerprint,
    entry.meaningFingerprint,
  ]);

/**
 * Projects immutable Definition intent into permissions eligible for one live role candidate.
 * Exact selections remain unchanged; the source-only wildcard is narrower at the live boundary.
 */
export const projectLiveApplicationRolePermissions = (
  permissionSelection: z.infer<typeof applicationRoleSchema>["permissionSelection"],
  applicationRootId: z.infer<typeof applicationRootIdSchema>,
  sourcePermissions: readonly z.infer<typeof permissionRegistryEntryCandidateSchema>[],
) =>
  permissionSelection.kind === "exact"
    ? sourcePermissions
    : sourcePermissions.filter(
        (entry) =>
          entry.ownerKind === "application" &&
          String(entry.applicationRootId) === String(applicationRootId) &&
          String(entry.ownerId) === String(applicationRootId) &&
          entry.permission.administrative === false &&
          entry.permission.actionKind !== "export",
      );

/** Immutable server-prepared #22/#32 handoff. It contains evidence, never an authority decision. */
export const preparedApplicationRoleTemplatesSchema = z
  .object({
    contractVersion: z.literal("1.0.0"),
    preparationBasis: applicationRoleTemplatePreparationBasisSchema,
    permissionRegistration: preparedApplicationPermissionRegistrationSchema,
    templates: z.array(preparedApplicationRoleTemplateSchema).min(1),
    candidateFingerprint: fingerprintSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const roleIds = value.templates.map((entry) => String(entry.template.roleId));
    const keys = value.templates.map((entry) => entry.template.key);
    if (new Set(roleIds).size !== roleIds.length || new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["templates"],
        message: "Prepared application role identities and keys must be unique",
      });

    for (const [templateIndex, prepared] of value.templates.entries()) {
      const expectedKeys = prepared.template.permissionKeys;
      const sourceKeys = prepared.sourcePermissions.map((entry) => entry.permission.key);
      if (
        expectedKeys.length !== sourceKeys.length ||
        expectedKeys.some((key, index) => key !== sourceKeys[index])
      )
        context.addIssue({
          code: "custom",
          path: ["templates", templateIndex, "sourcePermissions"],
          message: "Source permissions must retain the template's exact deterministic key order",
        });

      const permissionSelection = prepared.template.permissionSelection;
      const wildcard = permissionSelection.kind === "application_wildcard";
      for (const [permissionIndex, source] of prepared.sourcePermissions.entries()) {
        const matches = value.permissionRegistration.entries.filter((candidate) => {
          if (candidate.permission.key !== source.permission.key) return false;
          if (!wildcard) return true;
          return (
            candidate.ownerKind === "application" &&
            String(candidate.applicationRootId) ===
              String(value.permissionRegistration.applicationRootId) &&
            String(candidate.ownerId) === String(value.permissionRegistration.applicationRootId) &&
            value.permissionRegistration.applicationPermissionIds.includes(
              candidate.permission.permissionId,
            )
          );
        });
        if (
          matches.length !== 1 ||
          permissionCandidateEvidenceKey(matches[0]!) !== permissionCandidateEvidenceKey(source)
        )
          context.addIssue({
            code: "custom",
            path: ["templates", templateIndex, "sourcePermissions", permissionIndex],
            message:
              "Each template key must resolve to exactly one registered owner-qualified permission",
          });
      }

      if (permissionSelection.kind === "application_wildcard") {
        if (
          permissionSelection.catalogueFingerprint !==
            value.permissionRegistration.applicationCatalogueFingerprint ||
          prepared.sourcePermissions.some(
            (entry) =>
              entry.ownerKind !== "application" ||
              String(entry.applicationRootId) !==
                String(value.permissionRegistration.applicationRootId) ||
              String(entry.ownerId) !== String(value.permissionRegistration.applicationRootId) ||
              !value.permissionRegistration.applicationPermissionIds.includes(
                entry.permission.permissionId,
              ),
          )
        )
          context.addIssue({
            code: "custom",
            path: ["templates", templateIndex, "sourcePermissions"],
            message:
              "Application wildcard evidence must use its verified application-only catalogue snapshot",
          });
      }

      const projected = projectLiveApplicationRolePermissions(
        permissionSelection,
        value.permissionRegistration.applicationRootId,
        prepared.sourcePermissions,
      );
      if (
        projected.length !== prepared.livePermissions.length ||
        projected.some(
          (entry, index) =>
            permissionCandidateEvidenceKey(entry) !==
            permissionCandidateEvidenceKey(prepared.livePermissions[index]!),
        )
      )
        context.addIssue({
          code: "custom",
          path: ["templates", templateIndex, "livePermissions"],
          message: "Live permissions must equal the deterministic projection of source intent",
        });
    }
  });

export type RolePermissionEntry = z.infer<typeof rolePermissionEntrySchema>;
export type PermissionEntry = z.infer<typeof permissionEntrySchema>;
export type RolePrivilegeClassification = z.infer<typeof rolePrivilegeClassificationSchema>;
export type RoleRecentAuthenticationRequirement = z.infer<
  typeof roleRecentAuthenticationRequirementSchema
>;
export type RoleActivationPolicyReference = z.infer<typeof roleActivationPolicyReferenceSchema>;
export type RoleAssignmentPolicy = z.infer<typeof roleAssignmentPolicySchema>;
export type RoleActivationPolicyRevision = z.infer<typeof roleActivationPolicyRevisionSchema>;
export type ApplicationRoleSourceReference = z.infer<typeof applicationRoleSourceReferenceSchema>;
export type CustomRoleTemplateProvenance = z.infer<typeof customRoleTemplateProvenanceSchema>;
export type Role = z.infer<typeof roleSchema>;
export type Group = z.infer<typeof groupSchema>;
export type AccessAssignee = z.infer<typeof accessAssigneeSchema>;
export type GroupMembership = z.infer<typeof groupMembershipSchema>;
export type GroupMembershipEffectiveState = z.infer<typeof groupMembershipEffectiveStateSchema>;
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;
export type RoleAssignmentKind = z.infer<typeof roleAssignmentKindSchema>;
export type RoleAssignmentEffectiveState = z.infer<typeof roleAssignmentEffectiveStateSchema>;
export type RoleActivationEligibilitySource = z.infer<typeof roleActivationEligibilitySourceSchema>;
export type RoleActivation = z.infer<typeof roleActivationSchema>;
export type RoleActivationTemporalState = z.infer<typeof roleActivationTemporalStateSchema>;
export type DelegationScope = z.infer<typeof delegationScopeSchema>;
export type DelegationAuthority = z.infer<typeof delegationAuthoritySchema>;
export type DelegationAuthorityEffectiveState = z.infer<
  typeof delegationAuthorityEffectiveStateSchema
>;
export type PermissionContinuity = z.infer<typeof permissionContinuitySchema>;
export type ApplicationRoleTemplateContinuity = z.infer<
  typeof applicationRoleTemplateContinuitySchema
>;
export type AffectedRoleAssignment = z.infer<typeof affectedRoleAssignmentSchema>;
export type AffectedRoleAssignmentManifest = z.infer<typeof affectedRoleAssignmentManifestSchema>;
export type PreparedApplicationRoleTemplate = z.infer<typeof preparedApplicationRoleTemplateSchema>;
export type ApplicationRoleTemplatePreparationBasis = z.infer<
  typeof applicationRoleTemplatePreparationBasisSchema
>;
export type PreparedApplicationRoleTemplates = z.infer<
  typeof preparedApplicationRoleTemplatesSchema
>;
