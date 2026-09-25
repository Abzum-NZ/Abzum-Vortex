import "server-only";

/**
 * Builder authority: the one server-side gate every builder operation passes through, whether the
 * designer, the API or MCP reaches it. Draft changes, publication, installation, upgrade,
 * uninstallation and system-application changes each require exact platform permissions, and
 * installing custom components or accepting role templates additionally requires the person's
 * recent authentication.
 *
 * The Definition package owns the vocabulary and the derivation of which permissions an
 * operation needs. It cannot evaluate Access itself, so the live decision is the `BuilderAuthority`
 * port that Access implements over the caller's own request transaction and selected organisation
 * scope. Every gate takes an authority as a required argument: there is no way to construct a
 * builder service that skips the check, and nothing here accepts a permission, a role or an
 * identity from a caller.
 */

export const builderPermissionKeys = {
  definitionDraftsManage: "platform.organization.definition_drafts.manage",
  definitionReleasesManage: "platform.organization.definition_releases.manage",
  applicationsManage: "platform.organization.applications.manage",
  customCodeManage: "platform.organization.custom_code.manage",
  systemApplicationsManage: "platform.organization.system_applications.manage",
} as const;

export type BuilderPermissionKey = (typeof builderPermissionKeys)[keyof typeof builderPermissionKeys];

/**
 * One exact permission a role template would confer. It is derived from the immutable prepared
 * template evidence, never supplied by a caller.
 */
export type BuilderConferredPermission = Readonly<{
  applicationRootId: string;
  ownerKind: "application" | "module";
  ownerId: string;
  permissionId: string;
}>;

/**
 * One builder operation. `rootId` is the Definition root (module or application) the operation
 * changes; it is absent only when the operation creates a new root, which cannot be a system
 * application.
 */
export type BuilderOperation =
  | Readonly<{ kind: "draft_change"; rootId?: string }>
  | Readonly<{ kind: "publication"; rootId: string }>
  | Readonly<{
      kind: "installation";
      applicationRootId: string;
      change: "install_or_upgrade" | "uninstall";
      /** True when the exact package contains custom components or scripts. */
      containsCustomComponents: boolean;
      /**
       * Every permission the role templates being accepted would confer. Empty when no role
       * template is being accepted.
       */
      acceptedPermissions: readonly BuilderConferredPermission[];
    }>;

/** The recent-authentication requirement, when the operation has one. */
export const builderRecentAuthentication = { kind: "primary", maximumAgeSeconds: 900 } as const;

/** Facts about the operation's target that only trusted server evidence can supply. */
export type BuilderTargetFacts = Readonly<{
  /** Whether the root is a platform-supplied system application in this organisation. */
  isSystemApplication: boolean;
}>;

export type BuilderRequirements = Readonly<{
  /** Every one of these permissions must be held. */
  permissionKeys: readonly BuilderPermissionKey[];
  recentAuthentication: boolean;
  /** Every one of these must lie inside the actor's delegated assignment scope. */
  delegatedPermissions: readonly BuilderConferredPermission[];
}>;

const unique = <Value>(values: readonly Value[]): readonly Value[] => [...new Set(values)];

/**
 * The permissions an operation needs, given its trusted target facts.
 *
 * - Draft changes need `definition_drafts.manage`; publication needs `definition_releases.manage`.
 * - Installation, upgrade and uninstallation need `applications.manage`, plus `custom_code.manage`
 *   when the package contains custom components.
 * - Changing a system application additionally needs `system_applications.manage`.
 * - Installing or upgrading custom components, or accepting role templates, needs recent
 *   authentication, and accepted role templates must lie inside the actor's delegated scope.
 */
export const deriveBuilderRequirements = (
  operation: BuilderOperation,
  facts: BuilderTargetFacts,
): BuilderRequirements => {
  const system = facts.isSystemApplication
    ? ([builderPermissionKeys.systemApplicationsManage] as const)
    : ([] as const);
  switch (operation.kind) {
    case "draft_change":
      return {
        permissionKeys: unique([builderPermissionKeys.definitionDraftsManage, ...system]),
        recentAuthentication: false,
        delegatedPermissions: [],
      };
    case "publication":
      return {
        permissionKeys: unique([builderPermissionKeys.definitionReleasesManage, ...system]),
        recentAuthentication: false,
        delegatedPermissions: [],
      };
    case "installation": {
      const installs = operation.change === "install_or_upgrade";
      return {
        permissionKeys: unique([
          builderPermissionKeys.applicationsManage,
          ...(operation.containsCustomComponents ? [builderPermissionKeys.customCodeManage] : []),
          ...system,
        ]),
        recentAuthentication:
          installs &&
          (operation.containsCustomComponents || operation.acceptedPermissions.length > 0),
        delegatedPermissions: installs ? operation.acceptedPermissions : [],
      };
    }
  }
};

export type BuilderAuthorityDecision =
  | Readonly<{ outcome: "allowed" }>
  | Readonly<{
      outcome: "refused";
      reason: "permission_refused" | "authentication_required";
      correlationId: string;
    }>;

/**
 * The live decision, made by Access over the caller's request transaction and selected
 * organisation scope. A refusal is returned; anything that prevents a decision (an unavailable
 * evaluator, an unknown permission) throws, so a builder operation never proceeds on doubt.
 */
export interface BuilderAuthority {
  /** The organisation the decision is bound to. */
  readonly organizationId: string;
  require(operation: BuilderOperation): Promise<BuilderAuthorityDecision>;
}

export const builderAuthorityErrorCodes = [
  "BUILDER_PERMISSION_REFUSED",
  "BUILDER_RECENT_AUTHENTICATION_REQUIRED",
] as const;

export type BuilderAuthorityErrorCode = (typeof builderAuthorityErrorCodes)[number];

/**
 * A builder operation was refused before any write. It carries only its code and the correlation
 * the refusal belongs to: never a permission key, a role name or another person's authority.
 */
export class BuilderAuthorityError extends Error {
  readonly code: BuilderAuthorityErrorCode;
  readonly correlationId: string;

  constructor(code: BuilderAuthorityErrorCode, correlationId: string) {
    super(code);
    this.name = "BuilderAuthorityError";
    this.code = code;
    this.correlationId = correlationId;
  }
}

/** Requires the authority to allow the operation, or throws the safe refusal. */
export const requireBuilderAuthority = async (
  authority: BuilderAuthority,
  operation: BuilderOperation,
): Promise<void> => {
  const decision = await authority.require(operation);
  if (decision.outcome === "allowed") return;
  throw new BuilderAuthorityError(
    decision.reason === "authentication_required"
      ? "BUILDER_RECENT_AUTHENTICATION_REQUIRED"
      : "BUILDER_PERMISSION_REFUSED",
    decision.correlationId,
  );
};
