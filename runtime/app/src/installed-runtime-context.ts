import "server-only";

import {
  activeApplicationInstallationEvidenceSchema,
  sessionContextSchema,
  systemApplicationBoundReleaseSetResultSchema,
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
 * It is assembled only by this loader from the protected active-installation read, a server-minted
 * live system context and the exact protected Definition read. No field is ever taken from client
 * JSON, so a browser cannot supply its own organisation, account, permission, release or binding
 * evidence. Consumers accept it only through {@link requireInstalledRuntimeContext}.
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

/**
 * Protected Module read of the active installation selected by the trusted human application
 * context, such as `createActiveApplicationInstallationRepository` bound to the resolved request.
 */
export type InstalledRuntimeActiveInstallationReader = Readonly<{
  readCurrent(): Promise<ActiveApplicationInstallationEvidence>;
}>;

export type InstalledRuntimeContextDependencies = Readonly<{
  /** The resolved installation; never caller-authored, so its bindings are persisted evidence. */
  activeInstallationReader: InstalledRuntimeActiveInstallationReader;
  /**
   * Protected Definition read for one exact system-context-bound release set. The concrete
   * implementation is composed outside App, so App never holds database authority itself.
   */
  definitionReader: PermissionRegistryDefinitionSetReader;
  /** Server-minted live system context; the target organisation is proved against it, never assumed. */
  systemContext: () => SessionContext;
}>;

/** Contexts this loader assembled; a structurally identical object from anywhere else is refused. */
const assembledContexts = new WeakSet<object>();

/** Returns the context only when this loader assembled it, so a consumer cannot be handed a forgery. */
export const requireInstalledRuntimeContext = (candidate: unknown): InstalledRuntimeContext => {
  if (typeof candidate !== "object" || candidate === null || !assembledContexts.has(candidate))
    throw new InstalledRuntimeContextError("INSTALLED_RUNTIME_CONTEXT_REFUSED");
  return candidate as InstalledRuntimeContext;
};

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

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const failure = (code: InstalledRuntimeContextErrorCode, cause: unknown) =>
  new InstalledRuntimeContextError(code, { cause });

const installationFailure = (error: unknown): InstalledRuntimeContextError => {
  switch (errorCode(error)) {
    case "ACTIVE_APPLICATION_CONTEXT_REFUSED":
      return failure("INSTALLED_RUNTIME_CONTEXT_REFUSED", error);
    case "ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE":
      return failure("INSTALLED_RUNTIME_CONTEXT_UNAVAILABLE", error);
    case "ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE":
      return failure("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED", error);
    default:
      return failure("INSTALLED_RUNTIME_CONTEXT_TEMPORARILY_UNAVAILABLE", error);
  }
};

const definitionFailure = (error: unknown): InstalledRuntimeContextError => {
  switch (errorCode(error)) {
    case "DEFINITION_RELEASE_NOT_FOUND":
      return failure("INSTALLED_RUNTIME_CONTEXT_UNAVAILABLE", error);
    case "DEFINITION_CONTEXT_REFUSED":
      return failure("INSTALLED_RUNTIME_CONTEXT_REFUSED", error);
    case "DEFINITION_RELEASE_INTEGRITY_FAILED":
      return failure("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED", error);
    default:
      return failure("INSTALLED_RUNTIME_CONTEXT_TEMPORARILY_UNAVAILABLE", error);
  }
};

/**
 * Assembles the installed runtime context for the resolved organisation and active installation.
 *
 * The installation comes only from the protected active-installation read, never from the caller.
 * The loader then reads the exact bound Application/Module releases under a live system context and
 * rejects any inconsistency between the two: a mismatched organisation, Application root or
 * revision, a missing, extra or different Module release, a duplicate root, or a correlation that
 * does not match the system context. Browser input may select only an address; the route resolves
 * the human request from it before composing these readers.
 */
export const createInstalledRuntimeContextLoader = (
  dependencies: InstalledRuntimeContextDependencies,
) =>
  Object.freeze({
    async load(): Promise<InstalledRuntimeContext> {
      let installationCandidate: unknown;
      try {
        installationCandidate = await dependencies.activeInstallationReader.readCurrent();
      } catch (error) {
        throw installationFailure(error);
      }
      const installation = activeApplicationInstallationEvidenceSchema.safeParse(
        installationCandidate,
      );
      if (!installation.success)
        throw new InstalledRuntimeContextError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED");

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

      let releaseSetCandidate: unknown;
      try {
        releaseSetCandidate = await dependencies.definitionReader.read(systemContext, {
          applicationRootId: installation.data.applicationRootId,
          applicationReleaseRevision: installation.data.applicationReleaseRevision,
        });
      } catch (error) {
        throw definitionFailure(error);
      }
      // Parsed into a fresh value so the context never aliases the reader's own result.
      const parsedReleaseSet =
        systemApplicationBoundReleaseSetResultSchema.safeParse(releaseSetCandidate);
      if (!parsedReleaseSet.success)
        throw new InstalledRuntimeContextError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED");
      const releaseSet = parsedReleaseSet.data;

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
        throw failure("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED", error);
      }

      const context: InstalledRuntimeContext = Object.freeze({
        organizationId: application.organizationId,
        applicationRootId: application.rootId,
        applicationReleaseRevision: application.releaseRevision,
        correlationId: application.correlationId,
        releaseSet,
        permissionRegistration,
        installation: installation.data,
      });
      assembledContexts.add(context);
      return context;
    },
  });

export type InstalledRuntimeContextLoader = ReturnType<typeof createInstalledRuntimeContextLoader>;
