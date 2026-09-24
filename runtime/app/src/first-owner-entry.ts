import "server-only";

import {
  administrationReceiptIdSchema,
  actorIdSchema,
  applicationRootIdSchema,
  correlationIdSchema,
  identitySessionSchema,
  initialOperatingRoleGrantManifestSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  revisionSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
  type ApplicationRootId,
  type IdentitySession,
  type InitialOperatingRoleGrantResult,
  type OrganizationId,
  type PreparedOrganizationRoleChange,
  type RoleId,
} from "@vortex/contracts";
import type { InitialOperatingRoleGrant } from "@vortex/access";
import { z } from "zod";
import {
  createApplicationInstallationCoordinator,
  type ApplicationInstallationActivationResult,
  type ApplicationInstallationCoordinatorDependencies,
} from "./installation-coordinator";

/**
 * The App-owned first-owner server composition. It coordinates the protected
 * Application installation (prepare then activate) for the exact management
 * release named by the frozen manifest, then invokes Access's own first-owner
 * setup operation. Access never imports App or Page: this composition, not the
 * Access operation, owns application prepare/activate.
 *
 * The manifest is server-owned and frozen: the operating-role evidence and every
 * identifier are supplied by the trusted setup caller, never by a browser. An
 * exact retry must reuse the same identifiers and manifest so Access replays the
 * original result instead of granting again.
 */

export const firstOwnerApplicationEntryErrorCodes = [
  "INVALID_FIRST_OWNER_APPLICATION_ENTRY_REQUEST",
  "FIRST_OWNER_APPLICATION_ENTRY_MANIFEST_INVALID",
  "FIRST_OWNER_APPLICATION_ENTRY_INSTALLATION_FAILED",
] as const;

export type FirstOwnerApplicationEntryErrorCode =
  (typeof firstOwnerApplicationEntryErrorCodes)[number];

export class FirstOwnerApplicationEntryError extends Error {
  readonly code: FirstOwnerApplicationEntryErrorCode;

  constructor(code: FirstOwnerApplicationEntryErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "FirstOwnerApplicationEntryError";
    this.code = code;
  }
}

const safeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

export const firstOwnerApplicationEntryRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: safeRevisionSchema,
    stewardOrganizationAccountId: organizationAccountIdSchema,
    provisioningReceiptId: administrationReceiptIdSchema,
    setupRevision: safeRevisionSchema,
    setupActorId: actorIdSchema,
    correlationId: correlationIdSchema,
    operatingRoleId: roleIdSchema,
    operatingRoleSourceId: roleIdSchema,
    roleAssignmentId: roleAssignmentIdSchema,
  })
  .strict();

export type FirstOwnerApplicationEntryRequest = z.infer<
  typeof firstOwnerApplicationEntryRequestSchema
>;

export type FirstOwnerApplicationEntryCompositionDependencies<InstalledEvents> = Readonly<{
  /** The existing protected Application lifecycle dependencies. */
  installation: ApplicationInstallationCoordinatorDependencies<InstalledEvents>;
  /** The Access-owned setup operation this composition invokes. */
  initialOperatingRoleGrant: InitialOperatingRoleGrant;
  /**
   * Server-owned preparation of the exact operating application-role acceptance
   * against the already active registration. It is supplied by the trusted
   * deployment, which alone holds the current continuity evidence.
   */
  prepareOperatingRoleEvidence: (input: {
    readonly session: IdentitySession;
    readonly organizationId: OrganizationId;
    readonly applicationRootId: ApplicationRootId;
    readonly applicationReleaseRevision: number;
    readonly operatingRoleId: RoleId;
    readonly operatingRoleSourceId: RoleId;
  }) => Promise<PreparedOrganizationRoleChange>;
}>;

export type FirstOwnerApplicationEntryResult<InstalledEvents> = Readonly<{
  installation: ApplicationInstallationActivationResult<InstalledEvents>;
  rights: InitialOperatingRoleGrantResult;
}>;

/**
 * Builds the App composition that installs the exact management release and
 * applies the Access first-owner setup from the same frozen manifest.
 */
export const createFirstOwnerApplicationEntryComposition = <InstalledEvents = never>(
  dependencies: FirstOwnerApplicationEntryCompositionDependencies<InstalledEvents>,
) => {
  const installation = createApplicationInstallationCoordinator<InstalledEvents>(
    dependencies.installation,
  );

  return Object.freeze({
    async establish(
      session: IdentitySession,
      requestCandidate: FirstOwnerApplicationEntryRequest,
    ): Promise<FirstOwnerApplicationEntryResult<InstalledEvents>> {
      const verifiedSession = identitySessionSchema.safeParse(session);
      const request = firstOwnerApplicationEntryRequestSchema.safeParse(requestCandidate);
      if (!verifiedSession.success || !request.success)
        throw new FirstOwnerApplicationEntryError(
          "INVALID_FIRST_OWNER_APPLICATION_ENTRY_REQUEST",
        );
      const value = request.data;

      // 1. Prepare and activate exactly the named management-application release.
      //    Both steps are idempotent, so an interrupted setup resumes safely.
      let activation: ApplicationInstallationActivationResult<InstalledEvents>;
      try {
        await installation.prepare(verifiedSession.data, {
          organizationId: value.organizationId,
          applicationRootId: value.applicationRootId,
          applicationReleaseRevision: value.applicationReleaseRevision,
        });
        activation = await installation.activate(verifiedSession.data, {
          organizationId: value.organizationId,
          applicationRootId: value.applicationRootId,
          applicationReleaseRevision: value.applicationReleaseRevision,
          expectedActiveReleaseRevision: null,
        });
      } catch (error) {
        throw new FirstOwnerApplicationEntryError(
          "FIRST_OWNER_APPLICATION_ENTRY_INSTALLATION_FAILED",
          { cause: error },
        );
      }

      // 2. Freeze the operating-role acceptance only after the registration is active.
      const operatingRoleChangeEvidence = await dependencies.prepareOperatingRoleEvidence({
        session: verifiedSession.data,
        organizationId: value.organizationId,
        applicationRootId: value.applicationRootId,
        applicationReleaseRevision: value.applicationReleaseRevision,
        operatingRoleId: value.operatingRoleId,
        operatingRoleSourceId: value.operatingRoleSourceId,
      });

      // 3. Freeze the manifest and let Access establish the exact operating rights once.
      const manifest = initialOperatingRoleGrantManifestSchema.safeParse({
        manifestVersion: "1.0.0",
        organizationId: value.organizationId,
        stewardOrganizationAccountId: value.stewardOrganizationAccountId,
        applicationRootId: value.applicationRootId,
        applicationReleaseRevision: value.applicationReleaseRevision,
        provisioningReceiptId: value.provisioningReceiptId,
        setupRevision: value.setupRevision,
        setupActorId: value.setupActorId,
        correlationId: value.correlationId,
        roleAssignmentId: value.roleAssignmentId,
        operatingRoleChangeEvidence,
      });
      if (!manifest.success)
        throw new FirstOwnerApplicationEntryError(
          "FIRST_OWNER_APPLICATION_ENTRY_MANIFEST_INVALID",
        );

      const rights = await dependencies.initialOperatingRoleGrant.establish(manifest.data);
      return { installation: activation, rights };
    },
  });
};

export type FirstOwnerApplicationEntryComposition<InstalledEvents = never> = ReturnType<
  typeof createFirstOwnerApplicationEntryComposition<InstalledEvents>
>;
