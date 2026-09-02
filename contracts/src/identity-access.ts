import { z } from "zod";
import {
  builderKeySchema,
  fingerprintSchema,
  namespacedKeySchema,
  revisionSchema,
  semanticVersionSchema,
  timestampSchema,
} from "./identifiers";
import {
  activityIdSchema,
  actorIdSchema,
  applicationRootIdSchema,
  grantConsentDecisionIdSchema,
  grantConsentRequestIdSchema,
  clusterIdSchema,
  containedComponentIdSchema,
  directShareIdSchema,
  fieldIdSchema,
  grantIdSchema,
  identityAuthorityIdSchema,
  identityIdSchema,
  invitationIdSchema,
  moduleRootIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  permissionIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
  sessionIdSchema,
  teamIdSchema,
  tenantIdSchema,
} from "./identifiers";
import {
  correlationIdSchema,
  descriptionSchema,
  jsonValueSchema,
  labelSchema,
  safeHttpsUrlSchema,
} from "./common";
import { permissionDeclarationSchema } from "./permissions";

const administrativeStateSchema = z.enum(["active", "suspended", "archived", "removal_pending"]);
const accountStateSchema = z.enum(["invited", "active", "suspended", "closed"]);

export const tenantSchema = z
  .object({
    tenantId: tenantIdSchema,
    shortName: builderKeySchema,
    displayName: z.string().min(1).max(120),
    state: administrativeStateSchema,
    createdAt: timestampSchema,
    stateChangedAt: timestampSchema,
  })
  .strict();

export const tenantAdministratorAssignmentSchema = z
  .object({
    assignmentId: platformIdSchema,
    tenantId: tenantIdSchema,
    identityId: identityIdSchema,
    state: z.enum(["active", "revoked", "expired"]),
    permissionKeys: z.array(namespacedKeySchema).min(1),
    createdByIdentityId: identityIdSchema,
    startsAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    revokedAt: timestampSchema.optional(),
    revokedByIdentityId: identityIdSchema.optional(),
    activityId: activityIdSchema,
  })
  .strict();

export const organizationSchema = z
  .object({
    organizationId: organizationIdSchema,
    tenantId: tenantIdSchema,
    parentOrganizationId: organizationIdSchema.optional(),
    shortName: builderKeySchema,
    displayName: z.string().min(1).max(120),
    state: administrativeStateSchema,
    stateChangedAt: timestampSchema,
    createdAt: timestampSchema,
    createdBy: actorIdSchema,
  })
  .strict()
  .refine((value) => value.parentOrganizationId !== value.organizationId, {
    path: ["parentOrganizationId"],
    message: "An organisation cannot be its own parent",
  });

export const identityAuthoritySchema = z
  .object({
    authorityId: identityAuthorityIdSchema,
    environment: z.enum(["local", "testing", "production"]),
    issuer: safeHttpsUrlSchema,
    audiences: z.array(z.string().min(1).max(200)).min(1),
    currentKey: z
      .object({
        keyId: z.string().min(1).max(120),
        algorithm: z.enum(["ed25519", "rsa_pss_sha256"]),
        publicKey: z.string().min(32).max(10_000),
        activatesAt: timestampSchema,
        retiresAt: timestampSchema.optional(),
      })
      .strict(),
    nextKey: z
      .object({
        keyId: z.string().min(1).max(120),
        algorithm: z.enum(["ed25519", "rsa_pss_sha256"]),
        publicKey: z.string().min(32).max(10_000),
        activatesAt: timestampSchema,
      })
      .strict()
      .optional(),
    supportedTokenContractVersions: z.array(semanticVersionSchema).min(1),
  })
  .strict();

export const globalIdentitySchema = z
  .object({
    identityId: identityIdSchema,
    verifiedPrimaryEmail: z.email(),
    state: z.enum(["active", "suspended", "closed"]),
    secondFactorState: z.enum(["not_enrolled", "enrolled", "required"]),
    createdAt: timestampSchema,
    lastSuccessfulSignInAt: timestampSchema.optional(),
  })
  .strict();

export const identityTokenClaimSchema = z
  .object({
    identityId: identityIdSchema,
    issuer: safeHttpsUrlSchema,
    audience: z.string().min(1).max(200),
    sessionId: sessionIdSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    authenticationStrength: z.enum(["single_factor", "multi_factor", "recent_multi_factor"]),
  })
  .strict();

export const organizationAccountSchema = z
  .object({
    organizationAccountId: organizationAccountIdSchema,
    organizationId: organizationIdSchema,
    identityId: identityIdSchema,
    displayName: z.string().min(1).max(120),
    state: accountStateSchema,
    language: z.string().min(2).max(35).optional(),
    timeZone: z.string().min(1).max(100).optional(),
    invitationId: invitationIdSchema.optional(),
    activatedAt: timestampSchema.optional(),
    suspendedAt: timestampSchema.optional(),
    closedAt: timestampSchema.optional(),
    accessVersionContribution: revisionSchema,
  })
  .strict();

export const organizationAccountSetSchema = z
  .array(organizationAccountSchema)
  .superRefine((accounts, context) => {
    const pairs = new Set<string>();
    for (const [index, account] of accounts.entries()) {
      const pair = `${account.organizationId}:${account.identityId}`;
      if (pairs.has(pair))
        context.addIssue({
          code: "custom",
          path: [index, "organizationId"],
          message: "One identity may have only one account in an organisation",
        });
      pairs.add(pair);
    }
  });

export const organizationRuntimeSettingsSchema = z
  .object({
    organizationId: organizationIdSchema,
    language: z.string().min(2).max(35),
    timeZone: z.string().min(1).max(100),
    currency: z.string().length(3),
    dateFormat: z.string().min(1).max(50),
    numberFormat: z.string().min(1).max(50),
    revision: revisionSchema,
  })
  .strict();

export const teamSchema = z
  .object({
    teamId: teamIdSchema,
    organizationId: organizationIdSchema,
    key: builderKeySchema,
    label: labelSchema,
    state: z.enum(["active", "inactive"]),
    createdBy: organizationAccountIdSchema,
    createdAt: timestampSchema,
    changedAt: timestampSchema,
  })
  .strict();

export const teamMembershipSchema = z
  .object({
    organizationId: organizationIdSchema,
    teamId: teamIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    state: z.enum(["active", "revoked", "expired"]),
    startsAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    grantedBy: organizationAccountIdSchema,
    activityId: activityIdSchema,
  })
  .strict();

export const invitationSchema = z
  .object({
    invitationId: invitationIdSchema,
    organizationId: organizationIdSchema,
    invitedEmail: z.email(),
    proposedRoleIds: z.array(roleIdSchema),
    tokenFingerprint: fingerprintSchema,
    invitedBy: organizationAccountIdSchema,
    createdAt: timestampSchema,
    invitedAt: timestampSchema,
    expiresAt: timestampSchema,
    revokedAt: timestampSchema.optional(),
    acceptedAt: timestampSchema.optional(),
    acceptedOrganizationAccountId: organizationAccountIdSchema.optional(),
  })
  .strict();

const sessionContextCommon = {
  tenantId: tenantIdSchema,
  organizationId: organizationIdSchema,
  applicationRootId: applicationRootIdSchema.optional(),
  sessionId: sessionIdSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  accessVersion: revisionSchema,
  correlationId: correlationIdSchema,
};
const delegatedContextSchema = z
  .object({
    delegatedByOrganizationAccountId: organizationAccountIdSchema,
    reason: z.string().min(1).max(500),
    expiresAt: timestampSchema,
  })
  .strict();
const supportContextSchema = z
  .object({
    supportActorId: actorIdSchema,
    approvedByOrganizationAccountId: organizationAccountIdSchema,
    reason: z.string().min(1).max(500),
    expiresAt: timestampSchema,
  })
  .strict();
const authenticatedHumanContext = {
  identityId: identityIdSchema,
  organizationAccountId: organizationAccountIdSchema,
  authenticationStrength: z.enum(["single_factor", "multi_factor", "recent_multi_factor"]),
};
export const sessionContextSchema = z.discriminatedUnion("callerKind", [
  z
    .object({
      ...sessionContextCommon,
      ...authenticatedHumanContext,
      callerKind: z.literal("human"),
      delegatedContext: delegatedContextSchema.optional(),
      supportContext: supportContextSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...sessionContextCommon,
      callerKind: z.literal("system"),
      systemActorId: actorIdSchema,
      authenticationStrength: z.literal("service"),
      supportContext: supportContextSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...sessionContextCommon,
      callerKind: z.literal("public"),
      authenticationStrength: z.literal("anonymous"),
    })
    .strict(),
  z
    .object({
      ...sessionContextCommon,
      ...authenticatedHumanContext,
      callerKind: z.literal("federated"),
    })
    .strict(),
]);

export const permissionSchema = permissionDeclarationSchema.safeExtend({
  ownerKind: z.enum(["platform", "tenant", "organization", "module", "application"]),
  ownerId: platformIdSchema,
});

const exactPermissionEntrySchema = z
  .object({ kind: z.literal("exact"), permissionId: permissionIdSchema })
  .strict();
const wildcardPermissionEntrySchema = z
  .object({
    kind: z.literal("trailing_wildcard"),
    ownerKind: z.enum(["module", "application"]),
    ownerId: platformIdSchema,
    prefix: namespacedKeySchema,
    catalogueFingerprint: fingerprintSchema,
    expandedPermissionIds: z.array(permissionIdSchema).min(1),
  })
  .strict();
export const permissionEntrySchema = z.discriminatedUnion("kind", [
  exactPermissionEntrySchema,
  wildcardPermissionEntrySchema,
]);

export const roleSchema = z
  .object({
    roleId: roleIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema.optional(),
    key: builderKeySchema,
    label: labelSchema,
    description: descriptionSchema,
    kind: z.enum(["organization", "application"]),
    liveRevision: revisionSchema,
    permissions: z.array(permissionEntrySchema),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.kind === "application") !== (value.applicationRootId !== undefined))
      context.addIssue({
        code: "custom",
        path: ["applicationRootId"],
        message: "Only application roles carry an application root",
      });
  });

export const roleAssignmentSchema = z
  .object({
    roleAssignmentId: roleAssignmentIdSchema,
    organizationId: organizationIdSchema,
    roleId: roleIdSchema,
    assignee: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("organization_account"),
          organizationAccountId: organizationAccountIdSchema,
        })
        .strict(),
      z.object({ kind: z.literal("team"), teamId: teamIdSchema }).strict(),
    ]),
    applicationRootId: applicationRootIdSchema.optional(),
    startsAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    state: z.enum(["active", "revoked", "expired"]),
    grantedBy: organizationAccountIdSchema,
    activityId: activityIdSchema,
  })
  .strict();

export const accessRequestSchema = z
  .object({
    requestId: platformIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema.optional(),
    organizationAccountId: organizationAccountIdSchema.optional(),
    systemActorId: actorIdSchema.optional(),
    actionKey: namespacedKeySchema,
    recordTypeId: recordTypeIdSchema.optional(),
    recordId: recordIdSchema.optional(),
    requestedFieldIds: z.array(fieldIdSchema),
    candidateGrantIds: z.array(grantIdSchema),
    accessVersion: revisionSchema,
    correlationId: correlationIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.organizationAccountId === undefined) === (value.systemActorId === undefined))
      context.addIssue({
        code: "custom",
        path: ["organizationAccountId"],
        message: "Exactly one organisation account or system actor is required",
      });
    if ((value.recordTypeId === undefined) !== (value.recordId === undefined))
      context.addIssue({
        code: "custom",
        path: ["recordId"],
        message: "Record type and record identifier are supplied together",
      });
  });

export const accessDecisionSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("allowed"),
      decisionId: platformIdSchema,
      organizationId: organizationIdSchema,
      action: namespacedKeySchema,
      reliedOnGrantIds: z.array(grantIdSchema),
      accessVersion: revisionSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      decisionId: platformIdSchema,
      organizationId: organizationIdSchema,
      action: namespacedKeySchema,
      reasonCode: builderKeySchema,
      accessVersion: revisionSchema,
    })
    .strict(),
]);

const readableAndChangeable = {
  readableFieldIds: z.array(fieldIdSchema).min(1),
  changeableFieldIds: z.array(fieldIdSchema),
};
const fieldsAreSubset = <
  T extends { readableFieldIds: readonly string[]; changeableFieldIds: readonly string[] },
>(
  value: T,
) => value.changeableFieldIds.every((field) => value.readableFieldIds.includes(field));

export const fieldRestrictionSchema = z
  .object(readableAndChangeable)
  .strict()
  .refine(fieldsAreSubset, {
    path: ["changeableFieldIds"],
    message: "Changeable fields must also be readable",
  });

export const directRecordShareSchema = z
  .object({
    directShareId: directShareIdSchema,
    organizationId: organizationIdSchema,
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema,
    recipient: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("organization_account"),
          organizationAccountId: organizationAccountIdSchema,
        })
        .strict(),
      z.object({ kind: z.literal("team"), teamId: teamIdSchema }).strict(),
    ]),
    ...readableAndChangeable,
    startsAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    status: z.enum(["active", "revoked", "expired"]),
    grantedBy: organizationAccountIdSchema,
    grantedAt: timestampSchema,
    reason: z.string().min(1).max(500),
    revokedBy: organizationAccountIdSchema.optional(),
    revokedAt: timestampSchema.optional(),
    revocationReason: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const revoked = value.status === "revoked";
    if (
      revoked !==
      (value.revokedBy !== undefined &&
        value.revokedAt !== undefined &&
        value.revocationReason !== undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "Revocation evidence is present exactly when the share is revoked",
      });
  })
  .refine(fieldsAreSubset, {
    path: ["changeableFieldIds"],
    message: "Changeable fields must also be readable",
  });

const grantCommon = {
  grantId: grantIdSchema,
  sourceClusterId: clusterIdSchema,
  sourceOrganizationId: organizationIdSchema,
  sourceApplicationRootId: applicationRootIdSchema.optional(),
  recipientClusterId: clusterIdSchema,
  recipientOrganizationId: organizationIdSchema,
  recipientApplicationRootId: applicationRootIdSchema,
  recipientRoleIds: z.array(roleIdSchema).min(1),
  moduleRootId: moduleRootIdSchema,
  allowedActionKeys: z.array(namespacedKeySchema),
  ...readableAndChangeable,
  exportAllowed: z.boolean(),
  approvedRecipientRegion: z.string().min(2).max(100),
  startsAt: timestampSchema,
  expiresAt: timestampSchema.optional(),
  status: z.enum(["draft", "pending_consent", "active", "suspended", "revoked", "expired"]),
  createdByOrganizationAccountId: organizationAccountIdSchema,
  consentRequestId: grantConsentRequestIdSchema.optional(),
  contractVersion: semanticVersionSchema,
  contractFingerprint: fingerprintSchema,
  recipientBindingId: containedComponentIdSchema,
  definitionMappingFingerprint: fingerprintSchema,
  activatedAt: timestampSchema.optional(),
  revokedAt: timestampSchema.optional(),
  revokedByOrganizationAccountId: organizationAccountIdSchema.optional(),
  revocationReason: z.string().min(1).max(500).optional(),
};
const moduleGrantSchema = z.object({ scopeKind: z.literal("module"), ...grantCommon }).strict();
const recordTypeGrantSchema = z
  .object({ scopeKind: z.literal("record_type"), ...grantCommon, recordTypeId: recordTypeIdSchema })
  .strict();
const savedConditionGrantSchema = z
  .object({
    scopeKind: z.literal("saved_condition"),
    ...grantCommon,
    recordTypeId: recordTypeIdSchema,
    savedConditionId: containedComponentIdSchema,
    savedConditionRevision: revisionSchema,
    savedConditionFingerprint: fingerprintSchema,
    parameters: z.record(builderKeySchema, jsonValueSchema),
  })
  .strict();
const recordGrantSchema = z
  .object({
    scopeKind: z.literal("record"),
    ...grantCommon,
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema,
  })
  .strict();
export const accessGrantSchema = z
  .discriminatedUnion("scopeKind", [
    moduleGrantSchema,
    recordTypeGrantSchema,
    savedConditionGrantSchema,
    recordGrantSchema,
  ])
  .superRefine((value, context) => {
    if (!fieldsAreSubset(value))
      context.addIssue({
        code: "custom",
        path: ["changeableFieldIds"],
        message: "Changeable fields must also be readable",
      });
    const crossOrganization = value.sourceOrganizationId !== value.recipientOrganizationId;
    if (!crossOrganization && value.consentRequestId !== undefined)
      context.addIssue({
        code: "custom",
        path: ["consentRequestId"],
        message: "A grant inside one organisation does not use cross-organisation consent",
      });
    if (
      crossOrganization &&
      (value.consentRequestId === undefined || value.expiresAt === undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["consentRequestId"],
        message: "Cross-organisation grants require consent and expiry",
      });
    const beforeActivation = value.status === "draft" || value.status === "pending_consent";
    if (
      (value.status === "active" && value.activatedAt === undefined) ||
      (beforeActivation && value.activatedAt !== undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["activatedAt"],
        message:
          "An active grant requires activation evidence; a draft or pending grant forbids it",
      });
    const revoked = value.status === "revoked";
    if (
      revoked !==
      (value.revokedAt !== undefined &&
        value.revokedByOrganizationAccountId !== undefined &&
        value.revocationReason !== undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "Revocation evidence is present exactly when the grant is revoked",
      });
  });

export const grantConsentRequestSchema = z
  .object({
    requestId: grantConsentRequestIdSchema,
    sourceOrganizationId: organizationIdSchema,
    sourceClusterId: clusterIdSchema,
    recipientOrganizationId: organizationIdSchema,
    recipientClusterId: clusterIdSchema,
    proposedGrantFingerprint: fingerprintSchema,
    status: z.enum([
      "draft",
      "pending",
      "consented",
      "refused",
      "withdrawn",
      "expired",
      "activated",
    ]),
    requestedByOrganizationAccountId: organizationAccountIdSchema,
    requestedAt: timestampSchema,
    requiredDecisions: z
      .array(
        z
          .object({
            side: z.enum(["source_authorization", "recipient_acceptance"]),
            authorizedRoleIds: z.array(roleIdSchema).min(1),
          })
          .strict(),
      )
      .min(1),
    expiresAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceOrganizationId === value.recipientOrganizationId)
      context.addIssue({
        code: "custom",
        path: ["recipientOrganizationId"],
        message: "Grant consent is only used between different organisations",
      });
    if (
      value.requiredDecisions.length !== 2 ||
      new Set(value.requiredDecisions.map((decision) => decision.side)).size !== 2
    )
      context.addIssue({
        code: "custom",
        path: ["requiredDecisions"],
        message: "Grant consent requires source authorization and recipient acceptance",
      });
  });

export const grantConsentDecisionSchema = z
  .object({
    decisionId: grantConsentDecisionIdSchema,
    requestId: grantConsentRequestIdSchema,
    side: z.enum(["source_authorization", "recipient_acceptance"]),
    proposedGrantFingerprint: fingerprintSchema,
    approverOrganizationId: organizationIdSchema,
    approverOrganizationAccountId: organizationAccountIdSchema,
    decision: z.enum(["consented", "refused"]),
    decidedAt: timestampSchema,
    note: z.string().max(500).optional(),
    authenticationStrength: z.enum(["single_factor", "multi_factor", "recent_multi_factor"]),
    correlationId: correlationIdSchema,
  })
  .strict();

export type Tenant = z.infer<typeof tenantSchema>;
export type TenantAdministratorAssignment = z.infer<typeof tenantAdministratorAssignmentSchema>;
export type Organization = z.infer<typeof organizationSchema>;
export type IdentityAuthority = z.infer<typeof identityAuthoritySchema>;
export type GlobalIdentity = z.infer<typeof globalIdentitySchema>;
export type IdentityTokenClaim = z.infer<typeof identityTokenClaimSchema>;
export type OrganizationAccount = z.infer<typeof organizationAccountSchema>;
export type OrganizationAccountSet = z.infer<typeof organizationAccountSetSchema>;
export type OrganizationRuntimeSettings = z.infer<typeof organizationRuntimeSettingsSchema>;
export type Team = z.infer<typeof teamSchema>;
export type TeamMembership = z.infer<typeof teamMembershipSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
export type SessionContext = z.infer<typeof sessionContextSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type PermissionEntry = z.infer<typeof permissionEntrySchema>;
export type Role = z.infer<typeof roleSchema>;
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;
export type AccessRequest = z.infer<typeof accessRequestSchema>;
export type AccessDecision = z.infer<typeof accessDecisionSchema>;
export type FieldRestriction = z.infer<typeof fieldRestrictionSchema>;
export type DirectRecordShare = z.infer<typeof directRecordShareSchema>;
export type AccessGrant = z.infer<typeof accessGrantSchema>;
export type GrantConsentRequest = z.infer<typeof grantConsentRequestSchema>;
export type GrantConsentDecision = z.infer<typeof grantConsentDecisionSchema>;
