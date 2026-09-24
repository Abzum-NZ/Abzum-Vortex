import "server-only";

import {
  activeApplicationInstallationEvidenceSchema,
  sessionContextSchema,
  type ActiveApplicationInstallationEvidence,
  type ApplicationRootId,
  type OrganizationId,
  type PreparedApplicationPermissionRegistration,
  type SessionContext,
  type SystemApplicationBoundReleaseSetResult,
} from "@vortex/contracts";
import {
  prepareApplicationPermissionRegistrationFromReleaseSet,
  type PermissionRegistryDefinitionSetReader,
} from "@vortex/access";

export const installedRuntimeContextErrorCodes = [
  "INVALID_INSTALLED_RUNTIME_CONTEXT_COMMAND",
  "INSTALLED_RUNTIME_CONTEXT_REFUSED",
  "INSTALLED_RUNTIME_CONTEXT_UNAVAILABLE",
  "INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED",
  "INSTALLED_RUNTIME_CONTEXT_TEMPORARILY_UNAVAILABLE",
] as const;

export type InstalledRuntimeContextErrorCode = (typeof installedRuntimeContextErrorCodes)[number];

export class InstalledRuntimeContextError extends Error {
  readonly code: InstalledRuntimeContextErrorCode;

  constructor(code: InstalledRuntimeContextErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "InstalledRuntimeContextError";
    this.code = code;
  }
}

/**
 * One trusted application-service context: the exact organisation, installation and bound
 * Application/Module release set that every installed-application consumer (Page projection,
 * Query and current-person operation adapters) shares.
 *
 * It is assembled only by this loader from a server-minted live system context and the exact
 * protected Definition read. No field is ever taken from client JSON, so a browser cannot supply
 * its own organisation, account, permission, release or binding evidence.
 */
export type InstalledRuntimeContext = Readonly<{
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  applicationReleaseRevision: number;
  correlationId: string;
  /** Exact installed Application release plus its exact bound Module releases. */
  releaseSet: SystemApplicationBoundReleaseSetResult;
  /** Prepared permission registration for that exact release set, for Page projection. */
  permissionRegistration: PreparedApplicationPermissionRegistration;
  /** The resolved active installation whose bindings were verified against the release set. */
  installation: ActiveApplicationInstallationEvidence;
}>;

export type InstalledRuntimeContextDependencies = Readonly<{
  /**
   * Protected Definition read for one exact system-context-bound release set. The concrete
   * implementation is composed outside App, so App never holds database authority itself.
   */
  definitionReader: PermissionRegistryDefinitionSetReader;
  /** Server-minted live system context; the target organisation is proved against it, never assumed. */
  systemContext: () => SessionContext;
}>;

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const isLiveSystemContext = (context: SessionContext): boolean => {
  if (context.callerKind !== "system") return false;
  const issuedAt = Date.parse(context.issuedAt);
  const expiresAt = Date.parse(context.expiresAt);
  const now = Date.now();
  return (
    Number.isFinite(issuedAt) &&
    Number.isFinite(expiresAt) &&
    issuedAt <= now &&
    expiresAt > now &&
    issuedAt < expiresAt
  );
};

const definitionErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

/**
 * Assembles the installed runtime context from the resolved organisation and active installation.
 *
 * The loader accepts only exact persisted installation evidence, then reads the exact bound
 * Application/Module releases under a live system context and rejects any inconsistency between
 * the two: a mismatched organisation, Application root or revision, a missing or extra Module
 * release, a duplicate root, or a correlation that does not match the system context. Callers
 * that resolve the installation from a trusted human request pass its evidence here; browser
 * input may select only an address.
 */
export const createInstalledRuntimeContextLoader = (
  dependencies: InstalledRuntimeContextDependencies,
) =>
  Object.freeze({
    async load(installationCandidate: unknown): Promise<InstalledRuntimeContext> {
      const installation = activeApplicationInstallationEvidenceSchema.safeParse(
        installationCandidate,
      );
      if (!installation.success)
        throw new InstalledRuntimeContextError("INVALID_INSTALLED_RUNTIME_CONTEXT_COMMAND");

      const contextCandidate = sessionContextSchema.safeParse(dependencies.systemContext());
      if (!contextCandidate.success || !isLiveSystemContext(contextCandidate.data))
        throw new InstalledRuntimeContextError("INSTALLED_RUNTIME_CONTEXT_REFUSED");
      const systemContext = contextCandidate.data;
      if (
        !sameId(systemContext.organizationId, installation.data.organizationId) ||
        (systemContext.applicationRootId !== undefined &&
          !sameId(systemContext.applicationRootId, installation.data.applicationRootId))
      )
        throw new InstalledRuntimeContextError("INSTALLED_RUNTIME_CONTEXT_REFUSED");

      let releaseSet: SystemApplicationBoundReleaseSetResult;
      try {
        releaseSet = await dependencies.definitionReader.read(systemContext, {
          applicationRootId: installation.data.applicationRootId,
          applicationReleaseRevision: installation.data.applicationReleaseRevision,
        });
      } catch (error) {
        const code = definitionErrorCode(error);
        if (code === "DEFINITION_RELEASE_NOT_FOUND")
          throw new InstalledRuntimeContextError("INSTALLED_RUNTIME_CONTEXT_UNAVAILABLE", {
            cause: error,
          });
        if (code === "DEFINITION_CONTEXT_REFUSED")
          throw new InstalledRuntimeContextError("INSTALLED_RUNTIME_CONTEXT_REFUSED", {
            cause: error,
          });
        throw new InstalledRuntimeContextError(
          "INSTALLED_RUNTIME_CONTEXT_TEMPORARILY_UNAVAILABLE",
          { cause: error },
        );
      }

      const application = releaseSet.application;
      if (
        !sameId(application.organizationId, systemContext.organizationId) ||
        !sameId(application.organizationId, installation.data.organizationId) ||
        !sameId(application.rootId, installation.data.applicationRootId) ||
        application.releaseRevision !== installation.data.applicationReleaseRevision ||
        !sameId(application.correlationId, systemContext.correlationId) ||
        releaseSet.modules.length === 0
      )
        throw new InstalledRuntimeContextError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED");

      // The bound release set must carry exactly one release per active installation binding.
      const releasesByRoot = new Map<string, number>();
      for (const module of releaseSet.modules) {
        const root = module.rootId.toLowerCase();
        if (
          releasesByRoot.has(root) ||
          !sameId(module.organizationId, application.organizationId) ||
          !sameId(module.correlationId, application.correlationId)
        )
          throw new InstalledRuntimeContextError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED");
        releasesByRoot.set(root, module.releaseRevision);
      }
      if (releasesByRoot.size !== installation.data.moduleBindings.length)
        throw new InstalledRuntimeContextError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED");
      for (const binding of installation.data.moduleBindings) {
        const releaseRevision = releasesByRoot.get(binding.moduleRootId.toLowerCase());
        if (releaseRevision === undefined || releaseRevision !== binding.moduleReleaseRevision)
          throw new InstalledRuntimeContextError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED");
      }

      let permissionRegistration: PreparedApplicationPermissionRegistration;
      try {
        permissionRegistration = prepareApplicationPermissionRegistrationFromReleaseSet(
          systemContext,
          {
            applicationRootId: installation.data.applicationRootId,
            releaseRevision: installation.data.applicationReleaseRevision,
          },
          releaseSet,
        );
      } catch (error) {
        throw new InstalledRuntimeContextError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED", {
          cause: error,
        });
      }

      return Object.freeze({
        organizationId: application.organizationId,
        applicationRootId: application.rootId,
        applicationReleaseRevision: application.releaseRevision,
        correlationId: application.correlationId,
        releaseSet,
        permissionRegistration,
        installation: installation.data,
      });
    },
  });

export type InstalledRuntimeContextLoader = ReturnType<typeof createInstalledRuntimeContextLoader>;
