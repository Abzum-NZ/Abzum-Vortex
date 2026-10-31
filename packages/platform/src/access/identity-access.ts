import { organizationInvitationRoleIntentsSchema } from "./organization-invitation-access";
import { z } from "zod";
import { builderKeySchema, revisionSchema, timestampSchema } from "../catalogue/identifiers";
import { isLoopbackHostname } from "../identity/loopback-hostname";
import {
  actorIdSchema,
  applicationRootIdSchema,
  identityAuthorityIdSchema,
  identityIdSchema,
  invitationIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  platformIdSchema,
  sessionIdSchema,
  tenantIdSchema,
} from "../catalogue/identifiers";
import { correlationIdSchema, jsonValueSchema } from "../catalogue/common";
import { permissionDeclarationSchema } from "./permissions";
const accountStateSchema = z.enum(["active", "suspended", "closed"]);

/** The single closed tenant permission set. */
const tenantStructuralCapabilityKeys = [
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
  authenticationStrength: z.enum(["single_factor", "multi_factor"]),
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
      value.authenticationStrength !== "multi_factor"
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
export type IdentityAuthority = z.infer<typeof identityAuthoritySchema>;
export type IdentityProjection = z.infer<typeof identityProjectionSchema>;
export type VerifiedIdentity = z.infer<typeof verifiedIdentitySchema>;
export type IdentitySession = z.infer<typeof identitySessionSchema>;
export type IdentitySessionResolution = z.infer<typeof identitySessionResolutionSchema>;
export type OrganizationLauncherEntry = z.infer<typeof organizationLauncherEntrySchema>;
export type OrganizationLauncherResolution = z.infer<typeof organizationLauncherResolutionSchema>;
export type OrganizationSelectionCandidate = z.infer<typeof organizationSelectionCandidateSchema>;
export type SelectedOrganizationScope = z.infer<typeof selectedOrganizationScopeSchema>;
export type OrganizationAccount = z.infer<typeof organizationAccountSchema>;
export type InvitationAcceptanceWithAccessVersion = z.infer<
  typeof invitationAcceptanceWithAccessVersionSchema
>;
export type EnsureIdentityProjectionCommand = z.infer<typeof ensureIdentityProjectionCommandSchema>;
export type AcceptOrganizationInvitationCommand = z.infer<
  typeof acceptOrganizationInvitationCommandSchema
>;
export type SessionContext = z.infer<typeof sessionContextSchema>;
export type Permission = z.infer<typeof permissionSchema>;
