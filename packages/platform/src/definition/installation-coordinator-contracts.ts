import "server-only";

import {
  applicationRootIdSchema,
  organizationIdSchema,
  revisionSchema,
  type ApplicationRootId,
  type InstallationRuntimeBundleIndex,
  type IdentitySession,
  type ModuleInstallationBindingEvidence,
  type ModuleContent,
  type OrganizationId,
  type PreparedApplicationRoleTemplates,
  type SelectedOrganizationScope,
  type SessionContext,
  type SystemApplicationBoundReleaseSetResult,
} from "../schema";
import type {
  BuilderAuthority,
  createHumanOrganizationRequestService,
  PermissionRegistryDefinitionSetReader,
} from "../access/index";
import type { createModuleInstallationStorageRepository } from "./module-index";
import type {
  InstallationRuntimeBundleRemovalReport,
  ResolvedContributionBinding,
} from "./module-index";
import type { RequestDatabaseTransaction } from "../db/index";
import { z } from "zod";
import type { PreparedInstallationRuntimeSourceReader } from "./installation-runtime-bundle-app";

type InstallerRequests = Pick<
  ReturnType<typeof createHumanOrganizationRequestService>,
  "runAccessChange"
>;
export type InstallerTransaction = Parameters<typeof createModuleInstallationStorageRepository>[0];

export const applicationInstallationCoordinatorErrorCodes = [
  "INVALID_APPLICATION_INSTALLATION_COMMAND",
  "APPLICATION_INSTALLATION_REFUSED",
  "APPLICATION_INSTALLATION_PERMISSION_REFUSED",
  "APPLICATION_INSTALLATION_RECENT_AUTHENTICATION_REQUIRED",
  "APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE",
  "APPLICATION_INSTALLATION_STALE",
  "APPLICATION_INSTALLATION_INCOMPLETE",
  "APPLICATION_INSTALLATION_STORAGE_INCOMPATIBLE",
  "APPLICATION_INSTALLATION_TEMPORARILY_UNAVAILABLE",
  "APPLICATION_INSTALLATION_FAILED",
] as const;

export type ApplicationInstallationCoordinatorErrorCode =
  (typeof applicationInstallationCoordinatorErrorCodes)[number];

/** Prepare one exact release for first installation; nothing becomes active. */
export const applicationInstallationPreparationRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
  })
  .strict();

/**
 * Install (`expectedActiveReleaseRevision: null`) or deliberately upgrade from exactly the named
 * active release. A different active release is stale, never silently replaced.
 */
export const applicationInstallationActivationRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    expectedActiveReleaseRevision: revisionSchema.nullable(),
  })
  .strict();

/** Withdraw exactly the named installed or prepared release. */
export const applicationInstallationWithdrawalRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
  })
  .strict();

/** Begin the uninstall of exactly the named active installation by draining it. */
export const applicationInstallationDrainRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
  })
  .strict();

export type ApplicationInstallationPreparationRequest = z.infer<
  typeof applicationInstallationPreparationRequestSchema
>;
export type ApplicationInstallationActivationRequest = z.infer<
  typeof applicationInstallationActivationRequestSchema
>;
export type ApplicationInstallationWithdrawalRequest = z.infer<
  typeof applicationInstallationWithdrawalRequestSchema
>;
export type ApplicationInstallationDrainRequest = z.infer<
  typeof applicationInstallationDrainRequestSchema
>;

/** An optional reader the deployment may not supply; absence is reported, never assumed. */
export type OptionalInstallationReader<Value> =
  Readonly<{ kind: "available"; value: Value }> | Readonly<{ kind: "unavailable" }>;

export type ActiveApplicationInstallationSummary = Readonly<{
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  applicationReleaseRevision: number;
  moduleBindings: readonly ModuleInstallationBindingEvidence[];
}>;

export type ApplicationInstallationPreparationResult = Readonly<{
  runtimeBundleIndex: InstallationRuntimeBundleIndex;
  outcome: "prepared" | "unchanged";
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  applicationReleaseRevision: number;
  /** The provisioned, inactive bindings the activation will switch on. */
  moduleBindings: readonly ModuleInstallationBindingEvidence[];
}>;

export type ApplicationInstallationActivationResult<InstalledEvents> = Readonly<{
  outcome: "activated" | "unchanged";
  previousApplicationReleaseRevision: number | null;
  installation: ActiveApplicationInstallationSummary;
  installedEvents: OptionalInstallationReader<InstalledEvents>;
}>;

export type ApplicationInstallationWithdrawalResult = Readonly<{
  outcome: "withdrawn" | "unchanged";
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  applicationReleaseRevision: number;
  moduleBindings: readonly ModuleInstallationBindingEvidence[];
  runtimeBundles: InstallationRuntimeBundleRemovalReport;
}>;

export type ApplicationInstallationDrainResult = Readonly<{
  outcome: "draining" | "unchanged";
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  applicationReleaseRevision: number;
  moduleBindings: readonly ModuleInstallationBindingEvidence[];
}>;

/** The exact organisation, application and release an installation operation targets. */
export type InstallationReleaseTarget = Readonly<{
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  applicationReleaseRevision: number;
}>;

/**
 * The Definition evidence for one installation operation, read under the installer's own verified
 * human request instead of a server-minted system context. A deployment that cannot mint a system
 * context supplies this; the protected Definition reads still run through governed
 * database functions under the human's own authority. When supplied it replaces the system-context
 * reader for every release read.
 */
export type HumanInstallationDefinitionAccess = Readonly<{
  readReleaseSet(
    session: IdentitySession,
    target: InstallationReleaseTarget,
  ): Promise<SystemApplicationBoundReleaseSetResult>;
  prepareRegistrationCandidate(
    target: InstallationReleaseTarget,
    releaseSet: SystemApplicationBoundReleaseSetResult,
  ): Promise<PreparedApplicationRoleTemplates>;
}>;

export type ApplicationInstallationCoordinatorDependencies<InstalledEvents> = Readonly<{
  /** Installer request runner; each call opens one human change transaction. */
  installerRequests: InstallerRequests;
  /** Pure Definition resolver over the complete immutable Module release set. */
  resolveModuleContributions: (
    releases: readonly Readonly<{
      moduleRootId: string;
      definitionKey: string;
      releaseVersion: string;
      content: ModuleContent;
    }>[],
  ) => Readonly<{
    outcome: "resolved" | "conflicted";
    bindings: readonly ResolvedContributionBinding[];
    conflicts: readonly unknown[];
  }>;
  /**
   * Server-minted live system context and reader for immutable Definition evidence. The target
   * organisation is still proved by the installer's own transaction and the Access coordinator.
   * Required unless {@link humanDefinitionAccess} supplies the same evidence.
   */
  definitionSystemContext?: () => SessionContext;
  definitionReader?: PermissionRegistryDefinitionSetReader;
  /**
   * Definition evidence read under the installer's own human request. When supplied it is used
   * for every release read instead of the system-context reader.
   */
  humanDefinitionAccess?: HumanInstallationDefinitionAccess;
  /**
   * Optional installed-event catalogue projector, run after the installation change commits. It
   * is reported unavailable when not supplied or when it cannot project the committed release.
   */
  projectInstalledEvents?: (input: {
    readonly definitions: SystemApplicationBoundReleaseSetResult;
    readonly installation: ActiveApplicationInstallationSummary;
  }) => InstalledEvents;
  activityId?: () => string;
  /**
   * Builds the installer's builder authority over the installer's own transaction and selected
   * organisation scope. It is required: no installation operation runs without the check.
   */
  builderAuthority: (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
  ) => BuilderAuthority;
  /**
   * Whether the exact package contains custom components or scripts, from immutable release
   * evidence. It is required so a package form that can carry custom code must be recognised by
   * the deployment rather than assumed absent.
   */
  containsCustomComponents: (releaseSet: SystemApplicationBoundReleaseSetResult) => boolean;
  /** Prepared immutable source through the caller current human transaction. */
  preparedRuntimeSource?: PreparedInstallationRuntimeSourceReader;
}>;
