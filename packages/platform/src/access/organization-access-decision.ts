import { z } from "zod";
import { correlationIdSchema } from "../catalogue/common";
import {
  applicationRootIdSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  storageContractIdSchema,
  timestampSchema,
} from "../catalogue/identifiers";
import {
  rolePermissionEntrySchema,
  roleRecentAuthenticationRequirementSchema,
} from "./organization-access-catalogue";
import { permissionDeclarationSchema, permissionRecordScopeSchema } from "./permissions";
import { permissionRegistrySourceRevisionSchema } from "./permission-registry";

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

const organizationAccessTargetSchema = z.discriminatedUnion("kind", [
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

const managedPermissionSchema = z
  .object({
    applicationRootId: rolePermissionEntrySchema.shape.applicationRootId,
    ownerKind: rolePermissionEntrySchema.shape.ownerKind,
    ownerId: rolePermissionEntrySchema.shape.ownerId,
    permissionId: rolePermissionEntrySchema.shape.permissionId,
    acceptedRegistrationRevision:
      rolePermissionEntrySchema.shape.acceptedRegistrationRevision.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    addExactPermissionScopeIssue(value, context);
  });

const boundedManagementScopeSchema = z
  .object({
    kind: z.literal("bounded"),
    permissions: z.array(managedPermissionSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = value.permissions.map(
      (permission) =>
        `${exactPermissionIdentity(permission)}:${permission.acceptedRegistrationRevision ?? "current"}`,
    );
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["permissions"],
        message: "A managed permission identity may appear only once",
      });
  });

/** A current management request names its meaning; retained role revisions carry accepted meaning. */
const organizationAccessManagementScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("organization_catalogue") }).strict(),
  boundedManagementScopeSchema,
]);

const organizationAccessAuthorityRequirementSchema = z
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
const organizationAccessDecisionEvidenceSchema = z
  .object({
    operationKey: namespacedKeySchema,
    target: organizationAccessTargetSchema,
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    accessVersion: revisionSchema,
    checkedAt: timestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

const organizationAccessRefusalReasonSchema = z.enum([
  "permission_unavailable",
  "permission_not_effective",
  "authentication_unsatisfied",
  "multi_factor_unsatisfied",
  "delegation_insufficient",
  "target_policy_unavailable",
]);

const organizationRecordEligiblePermissionSchema = z
  .object({
    permission: organizationAccessExactPermissionSchema,
    registrationRevision: revisionSchema,
    recordScope: permissionRecordScopeSchema,
    source: permissionRegistrySourceRevisionSchema,
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
const safeOrganizationAccessRefusalSchema = z
  .object({
    outcome: z.literal("refused"),
    reasonCode: z.enum([
      "access_refused",
      "authentication_required",
      "multi_factor_required",
      "target_policy_unavailable",
      "caller_unsupported",
    ]),
    correlationId: correlationIdSchema,
  })
  .strict();
export type OrganizationAccessDeclaration = z.infer<typeof organizationAccessDeclarationSchema>;
export type OrganizationRecordAccessDeclaration = z.infer<
  typeof organizationRecordAccessDeclarationSchema
>;
export type OrganizationPermissionEligibility = z.infer<
  typeof organizationPermissionEligibilitySchema
>;
export type OrganizationRecordPermissionEligibility = z.infer<
  typeof organizationRecordPermissionEligibilitySchema
>;
export type OrganizationAccessDecision = z.infer<typeof organizationAccessDecisionSchema>;
export type SafeOrganizationAccessRefusal = z.infer<typeof safeOrganizationAccessRefusalSchema>;

/** Project private access refusals to the same safe public reason vocabulary. */
export const safeOrganizationAccessRefusal = (
  refusal: Readonly<{
    reasonCode: string;
    correlationId: string;
  }>,
): SafeOrganizationAccessRefusal =>
  safeOrganizationAccessRefusalSchema.parse({
    outcome: "refused",
    reasonCode:
      refusal.reasonCode === "multi_factor_unsatisfied"
        ? "multi_factor_required"
        : refusal.reasonCode === "authentication_unsatisfied"
          ? "authentication_required"
          : refusal.reasonCode === "target_policy_unavailable"
            ? "target_policy_unavailable"
            : "access_refused",
    correlationId: refusal.correlationId,
  });
