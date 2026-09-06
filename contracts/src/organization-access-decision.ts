import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  applicationRootIdSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  revisionSchema,
  timestampSchema,
} from "./identifiers";
import {
  rolePermissionEntrySchema,
  roleRecentAuthenticationRequirementSchema,
} from "./organization-access-catalogue";
import { permissionDeclarationSchema } from "./permissions";

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

export const organizationAccessAuthorityRequirementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("permission") }).strict(),
  z
    .object({
      kind: z.literal("delegated_management"),
      before: organizationAccessManagementScopeSchema,
      after: organizationAccessManagementScopeSchema,
    })
    .strict(),
]);

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

export const organizationAccessRefusalReasonSchema = z.enum([
  "permission_unavailable",
  "permission_not_effective",
  "authentication_unsatisfied",
  "delegation_insufficient",
  "target_policy_unavailable",
]);

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
export type OrganizationAccessDecisionEvidence = z.infer<
  typeof organizationAccessDecisionEvidenceSchema
>;
export type OrganizationPermissionEligibility = z.infer<
  typeof organizationPermissionEligibilitySchema
>;
export type OrganizationAccessDecision = z.infer<typeof organizationAccessDecisionSchema>;
export type SafeOrganizationAccessRefusal = z.infer<typeof safeOrganizationAccessRefusalSchema>;
