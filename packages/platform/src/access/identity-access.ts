import { organizationInvitationRoleIntentsSchema } from "./organization-invitation-access";
import { z } from "zod";
import {
  builderKeySchema,
  fingerprintSchema,
  groupIdSchema,
  namespacedKeySchema,
  revisionSchema,
  semanticVersionSchema,
  timestampSchema,
} from "../catalogue/identifiers";
import { isLoopbackHostname } from "../identity/loopback-hostname";
import {
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
  membershipIdSchema,
  moduleRootIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  roleActivationIdSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
  sessionIdSchema,
  tenantAdministratorAssignmentIdSchema,
  tenantIdSchema,
} from "../catalogue/identifiers";
import { correlationIdSchema, jsonValueSchema } from "../catalogue/common";
import { permissionDeclarationSchema } from "./permissions";
import { recordScopeSchema } from "../records/records";

const administrativeStateSchema = z.enum(["active", "suspended", "archived", "removal_pending"]);
const accountStateSchema = z.enum(["active", "suspended", "closed"]);

export const tenantSchema = z
  .object({
    tenantId: tenantIdSchema,
    shortName: builderKeySchema,
    displayName: z.string().trim().min(1).max(120),
    state: administrativeStateSchema,
    createdAt: timestampSchema,
    createdBy: actorIdSchema,
    stateChangedAt: timestampSchema,
    revision: revisionSchema,
  })
  .strict()
  .refine((value) => Date.parse(value.stateChangedAt) >= Date.parse(value.createdAt), {
    path: ["stateChangedAt"],
    message: "The tenant state-change time cannot precede its creation time",
  });

/** The single closed tenant permission set. */
export const tenantStructuralCapabilityKeys = [
  "platform.tenant.administrators.manage",
  "platform.tenant.administrators.read",
  "platform.tenant.capability_limits.allocate",
  "platform.tenant.capability_limits.read",
  "platform.tenant.hierarchy.read",
  "platform.tenant.organizations.create",
  "platform.tenant.organizations.lifecycle",
  "platform.tenant.organizations.rename",
  "platform.tenant.organizations.reparent",
] as const;

export const tenantStructuralCapabilitySchema = z.enum(tenantStructuralCapabilityKeys);

/** One stable, deduplicated tenant permission set in canonical order. */
export const tenantStructuralCapabilitySetSchema = z
  .array(tenantStructuralCapabilitySchema)
  .min(1)
  .superRefine((capabilities, context) => {
    for (let index = 1; index < capabilities.length; index += 1)
      if (capabilities[index - 1]! >= capabilities[index]!)
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Tenant permissions must be unique and sorted in canonical order",
        });
  });

export const tenantAdministratorAssignmentSchema = z
  .object({
    assignmentId: tenantAdministratorAssignmentIdSchema,
    tenantId: tenantIdSchema,
    identityId: identityIdSchema,
    capabilities: tenantStructuralCapabilitySetSchema,
    startsAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    revision: revisionSchema,
    grantedAt: timestampSchema,
    grantedByActorId: actorIdSchema,
    grantCorrelationId: correlationIdSchema,
    changedAt: timestampSchema,
    changedByActorId: actorIdSchema,
    changeCorrelationId: correlationIdSchema,
    revokedAt: timestampSchema.optional(),
    revokedByActorId: actorIdSchema.optional(),
    revocationCorrelationId: correlationIdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt !== undefined && Date.parse(value.expiresAt) <= Date.parse(value.startsAt))
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Assignment expiry must be later than its start",
      });

    if (Date.parse(value.changedAt) < Date.parse(value.grantedAt))
      context.addIssue({
        code: "custom",
        path: ["changedAt"],
        message: "Assignment change time cannot precede its grant",
      });

    const hasAnyRevocation =
      value.revokedAt !== undefined ||
      value.revokedByActorId !== undefined ||
      value.revocationCorrelationId !== undefined;
    const hasCompleteRevocation =
      value.revokedAt !== undefined &&
      value.revokedByActorId !== undefined &&
      value.revocationCorrelationId !== undefined;
    if (hasAnyRevocation && !hasCompleteRevocation)
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "Revocation evidence must be all present or all absent",
      });

    if (hasCompleteRevocation) {
      const revokedAt = value.revokedAt!;
      const revokedByActorId = value.revokedByActorId!;
      const revocationCorrelationId = value.revocationCorrelationId!;
      if (
        Date.parse(revokedAt) < Date.parse(value.grantedAt) ||
        Date.parse(value.changedAt) !== Date.parse(revokedAt) ||
        value.changedByActorId !== revokedByActorId ||
        value.changeCorrelationId !== revocationCorrelationId
      )
        context.addIssue({
          code: "custom",
          path: ["revokedAt"],
          message: "A revoked assignment's current change must be its complete revocation evidence",
        });
    }
  });

export const tenantAdministratorAssignmentOutcomeSchema = z.enum([
  "scheduled",
  "active",
  "expired",
  "revoked",
]);

export const organizationSchema = z
  .object({
    organizationId: organizationIdSchema,
    tenantId: tenantIdSchema,
    parentOrganizationId: organizationIdSchema.optional(),
    shortName: builderKeySchema,
    displayName: z.string().trim().min(1).max(120),
    state: administrativeStateSchema,
    stateChangedAt: timestampSchema,
    createdAt: timestampSchema,
    createdBy: actorIdSchema,
    revision: revisionSchema,
  })
  .strict()
  .refine((value) => value.parentOrganizationId !== value.organizationId, {
    path: ["parentOrganizationId"],
    message: "An organisation cannot be its own parent",
  })
  .refine((value) => Date.parse(value.stateChangedAt) >= Date.parse(value.createdAt), {
    path: ["stateChangedAt"],
    message: "The organisation state-change time cannot precede its creation time",
  });

export const identityAuthoritySchema = z
  .object({
    authorityId: identityAuthorityIdSchema,
    environment: z.enum(["local", "testing", "production"]),
    issuer: z.url().max(2_000),
    jwksUrl: z.url().max(2_000),
    audience: z.literal("authenticated"),
    signingAlgorithm: z.literal("ES256"),
  })
  .strict()
  .superRefine((value, context) => {
    const issuer = new URL(value.issuer);
    const jwks = new URL(value.jwksUrl);
    const localLoopback =
      value.environment === "local" &&
      issuer.protocol === "http:" &&
      isLoopbackHostname(issuer.hostname);

    if (issuer.pathname !== "/auth/v1")
      context.addIssue({
        code: "custom",
        path: ["issuer"],
        message: "The Supabase identity issuer must use the standard /auth/v1 path",
      });

    if (issuer.protocol !== "https:" && !localLoopback)
      context.addIssue({
        code: "custom",
        path: ["issuer"],
        message: "Identity authorities require HTTPS except for Local loopback development",
      });

    if (jwks.protocol !== issuer.protocol || jwks.origin !== issuer.origin)
      context.addIssue({
        code: "custom",
        path: ["jwksUrl"],
        message: "The identity key set must use the authority issuer origin",
      });

    const expectedJwksPath = `${issuer.pathname.replace(/\/$/, "")}/.well-known/jwks.json`;
    if (
      jwks.pathname !== expectedJwksPath ||
      jwks.search.length > 0 ||
      jwks.hash.length > 0 ||
      issuer.search.length > 0 ||
      issuer.hash.length > 0
    )
      context.addIssue({
        code: "custom",
        path: ["jwksUrl"],
        message: "The identity key set must be the issuer's standard JWKS endpoint",
      });
  });

export const identityProjectionSchema = z
  .object({
    identityId: identityIdSchema,
    state: z.enum(["active", "suspended", "closed"]),
    createdAt: timestampSchema,
    stateChangedAt: timestampSchema,
    stateChangedBy: actorIdSchema,
    stateChangeCorrelationId: correlationIdSchema,
    revision: revisionSchema,
  })
  .strict()
  .refine((value) => Date.parse(value.stateChangedAt) >= Date.parse(value.createdAt), {
    path: ["stateChangedAt"],
    message: "The identity state-change time cannot precede its creation time",
  });

const jwtNumericDateSchema = z.number().int().nonnegative().max(253_402_300_799);

const supabaseAmrEntrySchema = z.union([
  z
    .object({
      method: z.literal("sso/saml"),
      timestamp: jwtNumericDateSchema,
      provider: z.string().min(1).max(120).optional(),
    })
    .strict(),
  z
    .object({
      method: z
        .string()
        .min(1)
        .max(120)
        .refine((method) => method !== "sso/saml"),
      timestamp: jwtNumericDateSchema,
    })
    .strict(),
]);

export const supabaseIdentityClaimsSchema = z
  .object({
    iss: z.url().max(2_000),
    aud: z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1)]),
    exp: jwtNumericDateSchema,
    iat: jwtNumericDateSchema,
    sub: identityIdSchema,
    role: z.literal("authenticated"),
    aal: z.enum(["aal1", "aal2"]),
    session_id: sessionIdSchema,
    email: z.email(),
    phone: z.string(),
    is_anonymous: z.literal(false),
    jti: z.string().min(1).max(200).optional(),
    nbf: jwtNumericDateSchema.optional(),
    app_metadata: z.record(z.string(), jsonValueSchema).optional(),
    user_metadata: z.record(z.string(), jsonValueSchema).optional(),
    amr: z.union([z.array(z.string().min(1).max(120)), z.array(supabaseAmrEntrySchema)]).optional(),
  })
  .loose()
  .superRefine((value, context) => {
    if (value.exp <= value.iat)
      context.addIssue({
        code: "custom",
        path: ["exp"],
        message: "Token expiry must be later than token issue time",
      });
    if (value.nbf !== undefined && value.nbf >= value.exp)
      context.addIssue({
        code: "custom",
        path: ["nbf"],
        message: "Token not-before time must be earlier than token expiry",
      });
  });

export const verifiedIdentitySchema = z
  .object({
    identityId: identityIdSchema,
    verifiedPrimaryEmail: z.email(),
    issuer: z.url().max(2_000),
    audience: z.literal("authenticated"),
    sessionId: sessionIdSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    authenticationStrength: z.enum(["single_factor", "multi_factor"]),
    primaryAuthenticatedAt: timestampSchema.optional(),
    multiFactorAuthenticatedAt: timestampSchema.optional(),
    keyId: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim().length > 0, "Verified JWT key identifier cannot be blank"),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt))
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Verified identity expiry must be later than issue time",
      });
    for (const property of ["primaryAuthenticatedAt", "multiFactorAuthenticatedAt"] as const)
      if (value[property] !== undefined && Date.parse(value[property]) > Date.parse(value.issuedAt))
        context.addIssue({
          code: "custom",
          path: [property],
          message: "Authentication evidence cannot postdate access-token issuance",
        });
    if (
      value.multiFactorAuthenticatedAt !== undefined &&
      value.authenticationStrength !== "multi_factor"
    )
      context.addIssue({
        code: "custom",
        path: ["multiFactorAuthenticatedAt"],
        message: "Multi-factor evidence requires verified multi-factor strength",
      });
  });

export const identitySessionSchema = z
  .object({
    identityId: identityIdSchema,
    sessionId: sessionIdSchema,
    authenticationStrength: z.enum(["single_factor", "multi_factor"]),
    accessTokenIssuedAt: timestampSchema,
    accessTokenExpiresAt: timestampSchema,
    primaryAuthenticatedAt: timestampSchema.optional(),
    multiFactorAuthenticatedAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.accessTokenExpiresAt) <= Date.parse(value.accessTokenIssuedAt))
      context.addIssue({
        code: "custom",
        path: ["accessTokenExpiresAt"],
        message: "The access-token expiry must be later than its issue time",
      });
    for (const property of ["primaryAuthenticatedAt", "multiFactorAuthenticatedAt"] as const)
      if (
        value[property] !== undefined &&
        Date.parse(value[property]) > Date.parse(value.accessTokenIssuedAt)
      )
        context.addIssue({
          code: "custom",
          path: [property],
          message: "Authentication evidence cannot postdate access-token issuance",
        });
    if (
      value.multiFactorAuthenticatedAt !== undefined &&
      value.authenticationStrength !== "multi_factor"
    )
      context.addIssue({
        code: "custom",
        path: ["multiFactorAuthenticatedAt"],
        message: "Multi-factor evidence requires verified multi-factor strength",
      });
  });

export const identitySessionResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("active"), session: identitySessionSchema }).strict(),
  z.object({ kind: z.literal("missing") }).strict(),
  z.object({ kind: z.literal("expired_or_revoked") }).strict(),
  z.object({ kind: z.literal("cluster_identity_inactive") }).strict(),
  z.object({ kind: z.literal("temporarily_unavailable") }).strict(),
  z.object({ kind: z.literal("invalid_session_state") }).strict(),
]);

export const organizationLauncherEntrySchema = z
  .object({
    organizationId: organizationIdSchema,
    tenantShortName: builderKeySchema,
    tenantDisplayName: z.string().trim().min(1).max(120),
    organizationShortName: builderKeySchema,
    organizationDisplayName: z.string().trim().min(1).max(120),
    accountDisplayName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const organizationLauncherResolutionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("available"),
      entries: z.array(organizationLauncherEntrySchema),
    })
    .strict(),
  z.object({ kind: z.literal("temporarily_unavailable") }).strict(),
  z.object({ kind: z.literal("invalid_session_state") }).strict(),
]);

/** A preview of an Application draft, which a request of that Application may run instead of its installation. */
const selectedPreviewInstallationIdSchema = z
  .uuid()
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000");

export const organizationSelectionCandidateSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema.optional(),
    previewInstallationId: selectedPreviewInstallationIdSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.previewInstallationId === undefined || value.applicationRootId !== undefined,
    { path: ["previewInstallationId"], message: "A preview is selected only with its Application" },
  );

export const selectedOrganizationScopeSchema = z
  .object({
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    applicationRootId: applicationRootIdSchema.optional(),
    previewInstallationId: selectedPreviewInstallationIdSchema.optional(),
    accessVersion: revisionSchema,
  })
  .strict();

export const organizationAccountSchema = z
  .object({
    organizationAccountId: organizationAccountIdSchema,
    organizationId: organizationIdSchema,
    identityId: identityIdSchema,
    displayName: z.string().trim().min(1).max(120).optional(),
    state: accountStateSchema,
    language: z.string().min(2).max(35).optional(),
    timeZone: z.string().min(1).max(100).optional(),
    invitationId: invitationIdSchema.optional(),
    activatedAt: timestampSchema,
    suspendedAt: timestampSchema.optional(),
    closedAt: timestampSchema.optional(),
    changedAt: timestampSchema,
    stateChangedAt: timestampSchema,
    stateChangedBy: actorIdSchema,
    stateChangeCorrelationId: correlationIdSchema,
    revision: revisionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const created = Date.parse(value.activatedAt);
    if (Date.parse(value.changedAt) < created)
      context.addIssue({
        code: "custom",
        path: ["changedAt"],
        message: "The account change time cannot precede activation",
      });
    if (Date.parse(value.stateChangedAt) < created)
      context.addIssue({
        code: "custom",
        path: ["stateChangedAt"],
        message: "The account state-change time cannot precede activation",
      });
    if (value.suspendedAt !== undefined && Date.parse(value.suspendedAt) < created)
      context.addIssue({
        code: "custom",
        path: ["suspendedAt"],
        message: "The account suspension time cannot precede activation",
      });
    if (value.closedAt !== undefined && Date.parse(value.closedAt) < created)
      context.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "The account closure time cannot precede activation",
      });
    if (value.state === "suspended" && value.suspendedAt === undefined)
      context.addIssue({
        code: "custom",
        path: ["suspendedAt"],
        message: "A suspended account requires suspension evidence",
      });
    if (value.state === "closed" && value.closedAt === undefined)
      context.addIssue({
        code: "custom",
        path: ["closedAt"],
        message: "A closed account requires closure evidence",
      });
  });

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

export const accessVersionChangeReasonKeys = [
  "organization_initialized",
  "organization_account_activated",
  "organization_account_reactivated",
  "organization_account_suspended",
  "organization_account_closed",
  "role_assignment_changed",
  "role_activation_changed",
  "delegation_changed",
  "stewardship_changed",
  "invitation_access_accepted",
  "role_catalogue_changed",
  "group_membership_changed",
  "application_access_changed",
  "direct_share_changed",
  "record_ownership_changed",
  "access_grant_changed",
  "public_policy_changed",
  "federation_mirror_changed",
  "mcp_authorization_changed",
] as const;

export const accessVersionChangeReasonSchema = z.enum(accessVersionChangeReasonKeys);

const organizationAccessVersionFields = {
  organizationId: organizationIdSchema,
  currentVersion: revisionSchema,
  changedAt: timestampSchema,
  changedBy: actorIdSchema,
  changeCorrelationId: correlationIdSchema,
};

export const organizationAccessVersionSchema = z
  .object({ ...organizationAccessVersionFields, changeReason: accessVersionChangeReasonSchema })
  .strict();

export const currentOrganizationAccessVersionSchema = organizationAccessVersionSchema.pick({
  organizationId: true,
  currentVersion: true,
});

export const readOrganizationAccessVersionCommandSchema = z
  .object({
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema,
  })
  .strict();

export const invitationAcceptanceWithAccessVersionSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("accepted"),
      account: organizationAccountSchema,
      accessVersion: revisionSchema,
    })
    .strict(),
  z.object({ outcome: z.literal("unavailable") }).strict(),
  z.object({ outcome: z.literal("identity_inactive") }).strict(),
  z.object({ outcome: z.literal("wrong_address") }).strict(),
  z.object({ outcome: z.literal("expired") }).strict(),
  z.object({ outcome: z.literal("inviter_not_allowed") }).strict(),
  z.object({ outcome: z.literal("role_changed") }).strict(),
]);

export const invitationSchema = z
  .object({
    invitationId: invitationIdSchema,
    organizationId: organizationIdSchema,
    invitedEmail: z.email(),
    invitedBy: organizationAccountIdSchema,
    roleIntents: organizationInvitationRoleIntentsSchema,
    createdAt: timestampSchema,
    invitedAt: timestampSchema,
    expiresAt: timestampSchema,
    revokedAt: timestampSchema.optional(),
    revokedBy: organizationAccountIdSchema.optional(),
    acceptedAt: timestampSchema.optional(),
    acceptedOrganizationAccountId: organizationAccountIdSchema.optional(),
    changedAt: timestampSchema,
    revision: revisionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.invitedAt) < Date.parse(value.createdAt))
      context.addIssue({
        code: "custom",
        path: ["invitedAt"],
        message: "Invitation time cannot precede creation",
      });
    if (Date.parse(value.expiresAt) <= Date.parse(value.invitedAt))
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Invitation expiry must be later than invitation time",
      });
    if (Date.parse(value.changedAt) < Date.parse(value.createdAt))
      context.addIssue({
        code: "custom",
        path: ["changedAt"],
        message: "Invitation change time cannot precede creation",
      });
    if (value.revokedAt !== undefined && Date.parse(value.revokedAt) < Date.parse(value.invitedAt))
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "Invitation revocation cannot precede invitation",
      });
    if (
      value.acceptedAt !== undefined &&
      Date.parse(value.acceptedAt) < Date.parse(value.invitedAt)
    )
      context.addIssue({
        code: "custom",
        path: ["acceptedAt"],
        message: "Invitation acceptance cannot precede invitation",
      });
    if ((value.revokedAt === undefined) !== (value.revokedBy === undefined))
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "Invitation revocation evidence must be complete",
      });
    if ((value.acceptedAt === undefined) !== (value.acceptedOrganizationAccountId === undefined))
      context.addIssue({
        code: "custom",
        path: ["acceptedAt"],
        message: "Invitation acceptance evidence must be complete",
      });
    if (value.revokedAt !== undefined && value.acceptedAt !== undefined)
      context.addIssue({
        code: "custom",
        path: ["acceptedAt"],
        message: "An invitation cannot be both revoked and accepted",
      });
  });

export const ensureIdentityProjectionCommandSchema = z
  .object({
    correlationId: correlationIdSchema,
  })
  .strict();

export const acceptOrganizationInvitationCommandSchema = z
  .object({
    invitationId: invitationIdSchema,
    displayName: z.string().trim().min(1).max(120).optional(),
    correlationId: correlationIdSchema,
  })
  .strict();

export const changeOrganizationAccountStateCommandSchema = z
  .object({
    organizationAccountId: organizationAccountIdSchema,
    expectedRevision: revisionSchema,
    state: accountStateSchema,
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
  /** The request channel recorded by the database context (for example `web`). */
  channel: z.string().min(1).max(64).optional(),
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
  identityAuthorityId: identityAuthorityIdSchema,
  identityId: identityIdSchema,
  organizationAccountId: organizationAccountIdSchema,
  authenticationStrength: z.enum(["single_factor", "multi_factor", "recent_multi_factor"]),
};
const humanSessionContextSchema = z
  .object({
    ...sessionContextCommon,
    ...authenticatedHumanContext,
    callerKind: z.literal("human"),
    accessTokenIssuedAt: timestampSchema.optional(),
    primaryAuthenticatedAt: timestampSchema.optional(),
    multiFactorAuthenticatedAt: timestampSchema.optional(),
    delegatedContext: delegatedContextSchema.optional(),
    supportContext: supportContextSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasEvidence =
      value.primaryAuthenticatedAt !== undefined || value.multiFactorAuthenticatedAt !== undefined;
    if (hasEvidence !== (value.accessTokenIssuedAt !== undefined))
      context.addIssue({
        code: "custom",
        path: ["accessTokenIssuedAt"],
        message: "Authentication evidence and its access-token issue time must travel together",
      });
    if (
      value.multiFactorAuthenticatedAt !== undefined &&
      value.authenticationStrength !== "multi_factor" &&
      value.authenticationStrength !== "recent_multi_factor"
    )
      context.addIssue({
        code: "custom",
        path: ["multiFactorAuthenticatedAt"],
        message: "Multi-factor evidence requires multi-factor authentication strength",
      });
    if (value.accessTokenIssuedAt === undefined) return;

    const accessTokenIssuedAt = Date.parse(value.accessTokenIssuedAt);
    if (accessTokenIssuedAt >= Date.parse(value.expiresAt))
      context.addIssue({
        code: "custom",
        path: ["accessTokenIssuedAt"],
        message: "Access-token issuance must precede request-context expiry",
      });
    if (accessTokenIssuedAt > Date.parse(value.issuedAt) + 60_000)
      context.addIssue({
        code: "custom",
        path: ["accessTokenIssuedAt"],
        message: "Access-token issuance exceeds the verified clock-skew boundary",
      });
    for (const property of ["primaryAuthenticatedAt", "multiFactorAuthenticatedAt"] as const)
      if (value[property] !== undefined && Date.parse(value[property]) > accessTokenIssuedAt)
        context.addIssue({
          code: "custom",
          path: [property],
          message: "Authentication evidence cannot postdate access-token issuance",
        });
  });
export const sessionContextSchema = z.discriminatedUnion("callerKind", [
  humanSessionContextSchema,
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
    recordScope: recordScopeSchema,
    recipient: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("organization_account"),
          organizationAccountId: organizationAccountIdSchema,
        })
        .strict(),
      z.object({ kind: z.literal("group"), groupId: groupIdSchema }).strict(),
    ]),
    ...readableAndChangeable,
    startsAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    state: z.enum(["active", "revoked"]),
    revision: revisionSchema,
    grantedBy: organizationAccountIdSchema,
    grantedAt: timestampSchema,
    grantCorrelationId: correlationIdSchema,
    reason: z.string().min(1).max(500),
    revokedBy: organizationAccountIdSchema.optional(),
    revokedAt: timestampSchema.optional(),
    revocationCorrelationId: correlationIdSchema.optional(),
    revocationReason: z.string().min(1).max(500).optional(),
    changedAt: timestampSchema,
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
        message: "Readable fields must be unique and canonically ordered",
      });
    if (
      new Set(changeable).size !== changeable.length ||
      changeable.some((fieldId, index) => index > 0 && changeable[index - 1]! >= fieldId)
    )
      context.addIssue({
        code: "custom",
        path: ["changeableFieldIds"],
        message: "Changeable fields must be unique and canonically ordered",
      });
    if (value.expiresAt !== undefined && Date.parse(value.expiresAt) <= Date.parse(value.startsAt))
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "A direct share must expire after it starts",
      });
    if (Date.parse(value.changedAt) < Date.parse(value.grantedAt))
      context.addIssue({
        code: "custom",
        path: ["changedAt"],
        message: "A direct share cannot change before it is granted",
      });
    const revoked = value.state === "revoked";
    const revocationEvidenceCount = [
      value.revokedBy,
      value.revokedAt,
      value.revocationCorrelationId,
      value.revocationReason,
    ].filter((entry) => entry !== undefined).length;
    if ((!revoked && revocationEvidenceCount !== 0) || (revoked && revocationEvidenceCount !== 4))
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "Revocation evidence is present exactly when the share is revoked",
      });
    if (
      value.revokedAt !== undefined &&
      Date.parse(value.revokedAt) !== Date.parse(value.changedAt)
    )
      context.addIssue({
        code: "custom",
        path: ["changedAt"],
        message: "A revoked share's change time must equal its revocation time",
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
  // A grant's field lists name one record type's fields, which the module contract bounds at 500.
  readableFieldIds: z.array(fieldIdSchema).min(1).max(500),
  changeableFieldIds: z.array(fieldIdSchema).max(500),
  recipientRoleIds: z.array(roleIdSchema).min(1).max(100),
  moduleRootId: moduleRootIdSchema,
  allowedActionKeys: z.array(namespacedKeySchema).max(100),
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

const grantInstantParts = (value: string) => {
  // Date.parse keeps milliseconds only; grants can name finer ISO timestamp fractions.
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (match === null) return undefined;
  const wholeSecondMilliseconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(wholeSecondMilliseconds)) return undefined;
  return { wholeSecondMilliseconds, fraction: match[2] ?? "" };
};

const grantExpiresAfterStart = (startsAt: string, expiresAt: string): boolean => {
  const start = grantInstantParts(startsAt);
  const expiry = grantInstantParts(expiresAt);
  if (start === undefined || expiry === undefined) return false;
  if (start.wholeSecondMilliseconds !== expiry.wholeSecondMilliseconds)
    return expiry.wholeSecondMilliseconds > start.wholeSecondMilliseconds;
  const precision = Math.max(start.fraction.length, expiry.fraction.length);
  return expiry.fraction.padEnd(precision, "0") > start.fraction.padEnd(precision, "0");
};

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
    if (value.expiresAt !== undefined && !grantExpiresAfterStart(value.startsAt, value.expiresAt))
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "A grant must expire after it starts",
      });
    if (value.status === "expired" && value.expiresAt === undefined)
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "An expired grant requires its expiry time",
      });
    const canonicalRoleIds = value.recipientRoleIds.map((roleId) => roleId.toLowerCase());
    if (new Set(canonicalRoleIds).size !== canonicalRoleIds.length)
      context.addIssue({
        code: "custom",
        path: ["recipientRoleIds"],
        message: "Recipient roles must be unique",
      });
    if (new Set(value.allowedActionKeys).size !== value.allowedActionKeys.length)
      context.addIssue({
        code: "custom",
        path: ["allowedActionKeys"],
        message: "Allowed actions must be unique",
      });
    const readable = value.readableFieldIds.map((fieldId) => fieldId.toLowerCase());
    if (new Set(readable).size !== readable.length)
      context.addIssue({
        code: "custom",
        path: ["readableFieldIds"],
        message: "Readable fields must be unique",
      });
    const changeable = value.changeableFieldIds.map((fieldId) => fieldId.toLowerCase());
    if (new Set(changeable).size !== changeable.length)
      context.addIssue({
        code: "custom",
        path: ["changeableFieldIds"],
        message: "Changeable fields must be unique",
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

export const grantConsentDecisionAuthorizationPathSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("direct"),
      roleId: roleIdSchema,
      roleAssignmentId: roleAssignmentIdSchema,
      validUntil: timestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("group"),
      roleId: roleIdSchema,
      roleAssignmentId: roleAssignmentIdSchema,
      membershipId: membershipIdSchema,
      validUntil: timestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("activated_pim_direct"),
      roleId: roleIdSchema,
      roleAssignmentId: roleAssignmentIdSchema,
      roleActivationId: roleActivationIdSchema,
      validUntil: timestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("activated_pim_group"),
      roleId: roleIdSchema,
      roleAssignmentId: roleAssignmentIdSchema,
      membershipId: membershipIdSchema,
      roleActivationId: roleActivationIdSchema,
      validUntil: timestampSchema,
    })
    .strict(),
]);

export const grantConsentDecisionSchema = z
  .object({
    decisionId: grantConsentDecisionIdSchema,
    requestId: grantConsentRequestIdSchema,
    side: z.enum(["source_authorization", "recipient_acceptance"]),
    proposedGrantFingerprint: fingerprintSchema,
    proposalRevision: revisionSchema,
    approverOrganizationId: organizationIdSchema,
    approverOrganizationAccountId: organizationAccountIdSchema,
    approverApplicationRootId: applicationRootIdSchema,
    accessVersion: revisionSchema,
    proposalExpiresAt: timestampSchema,
    decision: z.enum(["consented", "refused"]),
    decidedAt: timestampSchema,
    note: z.string().max(500).optional(),
    authorizationPath: grantConsentDecisionAuthorizationPathSchema,
    authenticationStrength: z.literal("recent_multi_factor"),
    multiFactorAuthenticatedAt: timestampSchema,
    multiFactorAuthenticationExpiresAt: timestampSchema,
    expiresAt: timestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict()
  .refine(
    (value) => {
      const decidedAt = Date.parse(value.decidedAt);
      const multiFactorAt = Date.parse(value.multiFactorAuthenticatedAt);
      const multiFactorExpiresAt = Date.parse(value.multiFactorAuthenticationExpiresAt);
      const pathValidUntil = Date.parse(value.authorizationPath.validUntil);
      const proposalExpiresAt = Date.parse(value.proposalExpiresAt);
      const decisionExpiresAt = Date.parse(value.expiresAt);
      return (
        [
          decidedAt,
          multiFactorAt,
          multiFactorExpiresAt,
          pathValidUntil,
          proposalExpiresAt,
          decisionExpiresAt,
        ].every(Number.isFinite) &&
        multiFactorAt <= decidedAt &&
        decidedAt - multiFactorAt <= 300_000 &&
        multiFactorExpiresAt >= decidedAt &&
        multiFactorExpiresAt <= multiFactorAt + 300_000 &&
        pathValidUntil > decidedAt &&
        proposalExpiresAt > decidedAt &&
        decisionExpiresAt >= decidedAt &&
        decisionExpiresAt <= multiFactorExpiresAt &&
        decisionExpiresAt <= pathValidUntil &&
        decisionExpiresAt <= proposalExpiresAt
      );
    },
    {
      path: ["expiresAt"],
      message:
        "Consent decision evidence must remain current within its MFA, role-path, and proposal windows",
    },
  );

export type Tenant = z.infer<typeof tenantSchema>;
export type TenantAdministratorAssignment = z.infer<typeof tenantAdministratorAssignmentSchema>;
export type TenantAdministratorAssignmentOutcome = z.infer<
  typeof tenantAdministratorAssignmentOutcomeSchema
>;
export type Organization = z.infer<typeof organizationSchema>;
export type IdentityAuthority = z.infer<typeof identityAuthoritySchema>;
export type IdentityProjection = z.infer<typeof identityProjectionSchema>;
export type SupabaseIdentityClaims = z.infer<typeof supabaseIdentityClaimsSchema>;
export type VerifiedIdentity = z.infer<typeof verifiedIdentitySchema>;
export type IdentitySession = z.infer<typeof identitySessionSchema>;
export type IdentitySessionResolution = z.infer<typeof identitySessionResolutionSchema>;
export type OrganizationLauncherEntry = z.infer<typeof organizationLauncherEntrySchema>;
export type OrganizationLauncherResolution = z.infer<typeof organizationLauncherResolutionSchema>;
export type OrganizationSelectionCandidate = z.infer<typeof organizationSelectionCandidateSchema>;
export type SelectedOrganizationScope = z.infer<typeof selectedOrganizationScopeSchema>;
export type OrganizationAccount = z.infer<typeof organizationAccountSchema>;
export type OrganizationAccountSet = z.infer<typeof organizationAccountSetSchema>;
export type AccessVersionChangeReason = z.infer<typeof accessVersionChangeReasonSchema>;
export type OrganizationAccessVersion = z.infer<typeof organizationAccessVersionSchema>;
export type CurrentOrganizationAccessVersion = z.infer<
  typeof currentOrganizationAccessVersionSchema
>;
export type ReadOrganizationAccessVersionCommand = z.infer<
  typeof readOrganizationAccessVersionCommandSchema
>;
export type InvitationAcceptanceWithAccessVersion = z.infer<
  typeof invitationAcceptanceWithAccessVersionSchema
>;
export type Invitation = z.infer<typeof invitationSchema>;
export type EnsureIdentityProjectionCommand = z.infer<typeof ensureIdentityProjectionCommandSchema>;
export type AcceptOrganizationInvitationCommand = z.infer<
  typeof acceptOrganizationInvitationCommandSchema
>;
export type ChangeOrganizationAccountStateCommand = z.infer<
  typeof changeOrganizationAccountStateCommandSchema
>;
export type SessionContext = z.infer<typeof sessionContextSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type FieldRestriction = z.infer<typeof fieldRestrictionSchema>;
export type DirectRecordShare = z.infer<typeof directRecordShareSchema>;
export type AccessGrant = z.infer<typeof accessGrantSchema>;
export type GrantConsentRequest = z.infer<typeof grantConsentRequestSchema>;
export type GrantConsentDecisionAuthorizationPath = z.infer<
  typeof grantConsentDecisionAuthorizationPathSchema
>;
export type GrantConsentDecision = z.infer<typeof grantConsentDecisionSchema>;
