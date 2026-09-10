import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  applicationRootIdSchema,
  containedComponentIdSchema,
  directShareIdSchema,
  fieldIdSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  permissionIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  storageContractIdSchema,
  timestampSchema,
} from "./identifiers";
import {
  rolePermissionEntrySchema,
  roleRecentAuthenticationRequirementSchema,
} from "./organization-access-catalogue";
import { permissionDeclarationSchema, permissionRecordScopeSchema } from "./permissions";
import { permissionRegistryDefinitionReleaseSchema } from "./permission-registry";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);
const representsSameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const addExactPermissionScopeIssue = (
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
    !representsSameUuid(value.ownerId, value.applicationRootId ?? "")
  )
    context.addIssue({
      code: "custom",
      path: ["ownerId"],
      message: "An application permission must match its application context",
    });
};

/**
 * Exact authority identity required by an operation. Historical acceptance and
 * continuity evidence is discovered from current facts by the database decision.
 */
export const organizationAccessExactPermissionSchema = z
  .object({
    applicationRootId: rolePermissionEntrySchema.shape.applicationRootId,
    ownerKind: rolePermissionEntrySchema.shape.ownerKind,
    ownerId: rolePermissionEntrySchema.shape.ownerId,
    permissionId: rolePermissionEntrySchema.shape.permissionId,
  })
  .strict()
  .superRefine(addExactPermissionScopeIssue);

/** Exact catalogue action binding. Record-scoped policy is intentionally unsupported in slice 1. */
export const organizationAccessActionSchema = z
  .object({
    actionKind: permissionDeclarationSchema.shape.actionKind,
    namedAction: permissionDeclarationSchema.shape.namedAction,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.actionKind === "named") !== (value.namedAction !== undefined))
      context.addIssue({
        code: "custom",
        path: ["namedAction"],
        message: "Named actions are present only for the named action kind",
      });
  });

export const organizationAccessTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("organization") }).strict(),
  z
    .object({
      kind: z.literal("application"),
      applicationRootId: applicationRootIdSchema,
    })
    .strict(),
]);

const organizationRecordBindingSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    recordTypeId: recordTypeIdSchema,
    storageContractId: storageContractIdSchema,
    storageScope: z.enum(["organization_shared", "application_contained"]),
  })
  .strict();

const exactPermissionIdentity = (permission: {
  applicationRootId?: string | undefined;
  ownerKind: string;
  ownerId: string;
  permissionId: string;
}): string =>
  [
    permission.applicationRootId?.toLowerCase() ?? "platform",
    permission.ownerKind,
    permission.ownerId.toLowerCase(),
    permission.permissionId.toLowerCase(),
  ].join(":");

const boundedManagementScopeSchema = z
  .object({
    kind: z.literal("bounded"),
    permissions: z.array(organizationAccessExactPermissionSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = value.permissions.map(exactPermissionIdentity);
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["permissions"],
        message: "A managed permission identity may appear only once",
      });
  });

/** Minimal current management scope; it is not accepted-registration or continuity evidence. */
export const organizationAccessManagementScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("organization_catalogue") }).strict(),
  boundedManagementScopeSchema,
]);

export const organizationAccessAuthorityRequirementSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("permission") }).strict(),
    z
      .object({
        kind: z.literal("delegated_management"),
        before: organizationAccessManagementScopeSchema,
        after: organizationAccessManagementScopeSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.kind === "delegated_management" &&
      value.before.kind === "none" &&
      value.after.kind === "none"
    )
      context.addIssue({
        code: "custom",
        path: ["after"],
        message: "Delegated management requires a before or after scope",
      });
  });

/**
 * Server-owned declaration for one operation. Successful parsing does not make
 * caller input authoritative; runtime code must supply a platform declaration or
 * a verified immutable compiled operation.
 */
export const organizationAccessDeclarationSchema = z
  .object({
    operationKey: namespacedKeySchema,
    action: organizationAccessActionSchema,
    target: organizationAccessTargetSchema,
    requiredPermission: organizationAccessExactPermissionSchema,
    recentAuthentication: roleRecentAuthenticationRequirementSchema,
    authority: organizationAccessAuthorityRequirementSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const permission = value.requiredPermission;
    if (value.target.kind === "organization" && permission.ownerKind !== "platform")
      context.addIssue({
        code: "custom",
        path: ["requiredPermission", "ownerKind"],
        message: "An organization operation requires platform permission authority",
      });
    if (value.target.kind === "application") {
      if (permission.ownerKind === "platform")
        context.addIssue({
          code: "custom",
          path: ["requiredPermission", "ownerKind"],
          message: "An application operation requires application or module authority",
        });
      if (
        permission.applicationRootId !== undefined &&
        !representsSameUuid(permission.applicationRootId, value.target.applicationRootId)
      )
        context.addIssue({
          code: "custom",
          path: ["requiredPermission", "applicationRootId"],
          message: "The required permission must match the target application",
        });
    }
  });

/**
 * Server-owned declaration for one record operation. The exact installed
 * binding and permission alternatives are resolved from immutable Definition
 * output; a request may not supply this object as policy input.
 */
export const organizationRecordAccessDeclarationSchema = z
  .object({
    operationKey: namespacedKeySchema,
    action: organizationAccessActionSchema,
    target: z
      .object({
        kind: z.literal("application"),
        applicationRootId: applicationRootIdSchema,
      })
      .strict(),
    requiredPermissions: z.array(organizationAccessExactPermissionSchema).min(1),
    recordBinding: organizationRecordBindingSchema,
    recentAuthentication: roleRecentAuthenticationRequirementSchema,
    authority: z.object({ kind: z.literal("permission") }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = value.requiredPermissions.map(exactPermissionIdentity);
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["requiredPermissions"],
        message: "A record permission alternative may appear only once",
      });
    if (identities.some((identity, index) => index > 0 && identities[index - 1]! >= identity))
      context.addIssue({
        code: "custom",
        path: ["requiredPermissions"],
        message: "Record permission alternatives must use canonical identity order",
      });
    value.requiredPermissions.forEach((permission, index) => {
      if (
        permission.ownerKind === "platform" ||
        permission.applicationRootId === undefined ||
        !representsSameUuid(permission.applicationRootId, value.target.applicationRootId)
      )
        context.addIssue({
          code: "custom",
          path: ["requiredPermissions", index, "applicationRootId"],
          message: "Every record permission must match the target application",
        });
      if (
        permission.ownerKind === "module" &&
        !representsSameUuid(permission.ownerId, value.recordBinding.moduleRootId)
      )
        context.addIssue({
          code: "custom",
          path: ["requiredPermissions", index, "ownerId"],
          message: "A module permission must match the record-owning module",
        });
    });
    if (value.action.actionKind === "named") {
      const expected = value.requiredPermissions[0];
      if (
        expected &&
        value.requiredPermissions.some(
          (permission) =>
            permission.ownerKind !== expected.ownerKind ||
            !representsSameUuid(permission.ownerId, expected.ownerId),
        )
      )
        context.addIssue({
          code: "custom",
          path: ["requiredPermissions"],
          message: "Named action alternatives must share one exact permission owner",
        });
    }
  });

/** Transaction-bound evidence shared by private eligibility and final decisions. */
export const organizationAccessDecisionEvidenceSchema = z
  .object({
    operationKey: namespacedKeySchema,
    target: organizationAccessTargetSchema,
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    accessVersion: javascriptSafeRevisionSchema,
    checkedAt: timestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export const organizationAccessRefusalReasonSchema = z.enum([
  "permission_unavailable",
  "permission_not_effective",
  "authentication_unsatisfied",
  "delegation_insufficient",
  "target_policy_unavailable",
]);

const organizationRecordEligiblePermissionSchema = z
  .object({
    permission: organizationAccessExactPermissionSchema,
    recordScope: permissionRecordScopeSchema,
    source: permissionRegistryDefinitionReleaseSchema,
    validUntil: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.permission.ownerKind !== value.source.kind ||
      !representsSameUuid(value.permission.ownerId, value.source.rootId)
    )
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "Permission eligibility source must match the exact permission owner",
      });
  });

const organizationRecordAccessEvidenceSchema = organizationAccessDecisionEvidenceSchema.safeExtend({
  target: z
    .object({
      kind: z.literal("application"),
      applicationRootId: applicationRootIdSchema,
    })
    .strict(),
  recordBinding: organizationRecordBindingSchema,
});

const organizationRecordPermissionEligibleSchema = organizationRecordAccessEvidenceSchema
  .safeExtend({
    outcome: z.literal("eligible"),
    validUntil: timestampSchema,
    eligiblePermissions: z.array(organizationRecordEligiblePermissionSchema).min(1),
  })
  .superRefine((value, context) => {
    const checkedAt = Date.parse(value.checkedAt);
    const candidateDeadlines = value.eligiblePermissions.map((candidate) =>
      Date.parse(candidate.validUntil),
    );
    if (
      candidateDeadlines.some((deadline) => deadline <= checkedAt) ||
      Date.parse(value.validUntil) !== Math.min(...candidateDeadlines)
    )
      context.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "Record eligibility must use the earliest current candidate deadline",
      });
  });

/**
 * Private permission-only evidence for a record operation. It is not a row
 * visibility decision and cannot authorize a record read or change by itself.
 */
export const organizationRecordPermissionEligibilitySchema = z.discriminatedUnion("outcome", [
  organizationRecordPermissionEligibleSchema,
  organizationRecordAccessEvidenceSchema.safeExtend({
    outcome: z.literal("refused"),
    reasonCode: organizationAccessRefusalReasonSchema,
  }),
]);

const organizationRecordDecisionEvidenceSchema = organizationRecordAccessEvidenceSchema.safeExtend({
  recordId: recordIdSchema,
});

const organizationRecordMatchedRouteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all_records") }).strict(),
  z.object({ kind: z.literal("ownership") }).strict(),
  z
    .object({
      kind: z.literal("direct_share"),
      directShareId: directShareIdSchema,
      directShareRevision: javascriptSafeRevisionSchema,
      readableFieldIds: z.array(fieldIdSchema).min(1),
      changeableFieldIds: z.array(fieldIdSchema),
    })
    .strict()
    .superRefine((value, context) => {
      const readable = value.readableFieldIds.map((fieldId) => fieldId.toLowerCase());
      const changeable = value.changeableFieldIds.map((fieldId) => fieldId.toLowerCase());
      if (
        new Set(readable).size !== readable.length ||
        readable.some((fieldId, index) => index > 0 && readable[index - 1]! >= fieldId)
      )
        context.addIssue({
          code: "custom",
          path: ["readableFieldIds"],
          message: "Matched readable fields must use canonical UUID order",
        });
      if (
        new Set(changeable).size !== changeable.length ||
        changeable.some((fieldId, index) => index > 0 && changeable[index - 1]! >= fieldId) ||
        changeable.some((fieldId) => !readable.includes(fieldId))
      )
        context.addIssue({
          code: "custom",
          path: ["changeableFieldIds"],
          message: "Matched changeable fields must be a canonical readable subset",
        });
    }),
  z
    .object({
      kind: z.literal("relationship"),
      relationshipId: containedComponentIdSchema,
      sourcePermissionId: permissionIdSchema,
      sourceRecordId: recordIdSchema,
    })
    .strict(),
]);

const organizationRecordMatchedContributionSchema = organizationRecordEligiblePermissionSchema
  .safeExtend({
    route: organizationRecordMatchedRouteSchema,
    validUntil: timestampSchema,
  })
  .superRefine((value, context) => {
    const matchedRoute = value.recordScope.routes.some((route) => {
      if (route.kind !== value.route.kind) return false;
      return (
        route.kind !== "relationship" ||
        (value.route.kind === "relationship" &&
          representsSameUuid(route.relationshipId, value.route.relationshipId) &&
          representsSameUuid(route.sourcePermissionId, value.route.sourcePermissionId))
      );
    });
    if (!matchedRoute)
      context.addIssue({
        code: "custom",
        path: ["route"],
        message: "A matched route must belong to that permission record scope",
      });
  });

const organizationRecordAccessAllowedSchema = organizationRecordDecisionEvidenceSchema
  .safeExtend({
    outcome: z.literal("allowed"),
    action: organizationAccessActionSchema,
    validUntil: timestampSchema,
    matchedContributions: z.array(organizationRecordMatchedContributionSchema).min(1),
  })
  .superRefine((value, context) => {
    const checkedAt = Date.parse(value.checkedAt);
    const deadlines = value.matchedContributions.map((contribution) =>
      Date.parse(contribution.validUntil),
    );
    if (
      deadlines.some((deadline) => deadline <= checkedAt) ||
      Date.parse(value.validUntil) !== Math.min(...deadlines)
    )
      context.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "Record access must use the earliest complete contribution deadline",
      });
    if (
      !["read", "update"].includes(value.action.actionKind) &&
      value.matchedContributions.some((contribution) => contribution.route.kind === "direct_share")
    )
      context.addIssue({
        code: "custom",
        path: ["matchedContributions"],
        message: "Direct shares can contribute only to read or update decisions",
      });
  });

/** Private complete permission-and-row evidence consumed by fixed storage adapters. */
export const organizationRecordAccessDecisionSchema = z.discriminatedUnion("outcome", [
  organizationRecordAccessAllowedSchema,
  organizationRecordDecisionEvidenceSchema.safeExtend({
    outcome: z.literal("refused"),
    action: organizationAccessActionSchema,
    reasonCode: z.union([organizationAccessRefusalReasonSchema, z.literal("record_scope_refused")]),
  }),
]);

const boundedDecisionEvidenceSchema = organizationAccessDecisionEvidenceSchema
  .safeExtend({ validUntil: timestampSchema })
  .superRefine((value, context) => {
    if (Date.parse(value.validUntil) <= Date.parse(value.checkedAt))
      context.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "Decision evidence must expire after it was checked",
      });
  });

const organizationAccessPrivateRefusalSchema = organizationAccessDecisionEvidenceSchema.safeExtend({
  outcome: z.literal("refused"),
  reasonCode: organizationAccessRefusalReasonSchema,
});

/** Permission-only eligibility is internal evidence and is never a final allow result. */
export const organizationPermissionEligibilitySchema = z.discriminatedUnion("outcome", [
  boundedDecisionEvidenceSchema.safeExtend({ outcome: z.literal("eligible") }),
  organizationAccessPrivateRefusalSchema,
]);

/** Final private decision after every declared target policy and management check has run. */
export const organizationAccessDecisionSchema = z.discriminatedUnion("outcome", [
  boundedDecisionEvidenceSchema.safeExtend({ outcome: z.literal("allowed") }),
  organizationAccessPrivateRefusalSchema,
]);

/** Safe refusal exposed outside the decision boundary; internal authority evidence is absent. */
export const safeOrganizationAccessRefusalSchema = z
  .object({
    outcome: z.literal("refused"),
    reasonCode: z.enum([
      "access_refused",
      "authentication_required",
      "target_policy_unavailable",
      "caller_unsupported",
    ]),
    correlationId: correlationIdSchema,
  })
  .strict();

export type OrganizationAccessExactPermission = z.infer<
  typeof organizationAccessExactPermissionSchema
>;
export type OrganizationAccessAction = z.infer<typeof organizationAccessActionSchema>;
export type OrganizationAccessTarget = z.infer<typeof organizationAccessTargetSchema>;
export type OrganizationAccessManagementScope = z.infer<
  typeof organizationAccessManagementScopeSchema
>;
export type OrganizationAccessAuthorityRequirement = z.infer<
  typeof organizationAccessAuthorityRequirementSchema
>;
export type OrganizationAccessDeclaration = z.infer<typeof organizationAccessDeclarationSchema>;
export type OrganizationRecordAccessDeclaration = z.infer<
  typeof organizationRecordAccessDeclarationSchema
>;
export type OrganizationAccessDecisionEvidence = z.infer<
  typeof organizationAccessDecisionEvidenceSchema
>;
export type OrganizationPermissionEligibility = z.infer<
  typeof organizationPermissionEligibilitySchema
>;
export type OrganizationRecordPermissionEligibility = z.infer<
  typeof organizationRecordPermissionEligibilitySchema
>;
export type OrganizationRecordAccessDecision = z.infer<
  typeof organizationRecordAccessDecisionSchema
>;
export type OrganizationAccessDecision = z.infer<typeof organizationAccessDecisionSchema>;
export type SafeOrganizationAccessRefusal = z.infer<typeof safeOrganizationAccessRefusalSchema>;
