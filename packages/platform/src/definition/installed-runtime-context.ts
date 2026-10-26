import "server-only";

import type { PreparedApplicationPermissionRegistration } from "../access/permission-registry";
import type { ApplicationRootId, OrganizationId } from "../catalogue/identifiers";
import { sameId } from "../catalogue/runtime-primitives";
import {
  activeApplicationInstallationEvidenceSchema,
  type ActiveApplicationInstallationEvidence,
} from "../files/storage";
import type { SystemApplicationBoundReleaseSetResult } from "./definition-consumer-read";
import { prepareApplicationPermissionRegistrationForHumanRequest } from "../access/permission-registry-definition-adapter";
import {
  DefinitionError,
  databaseErrorCode,
  unexpectedDefinitionFailure,
} from "./definition-error";
import {
  noInstalledRecordContributions,
  withInstalledRecordContributions,
  type InstalledRecordContributions,
  type InstalledRecordTypeContributions,
} from "./installed-record-contributions";

type InstalledRuntimeContextErrorCode =
  | "INSTALLED_RUNTIME_CONTEXT_REFUSED"
  | "INSTALLED_RUNTIME_CONTEXT_UNAVAILABLE"
  | "INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED"
  | "INSTALLED_RUNTIME_CONTEXT_TEMPORARILY_UNAVAILABLE";

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
  /**
   * The fields other installed Modules of the organisation contributed to the record types of
   * `releaseSet`, whose record types already list them after their own fields. Pages and flows read
   * the contributed identities here; the database serves the same set to every record read and write.
   */
  recordContributions: readonly InstalledRecordTypeContributions[];
  /**
   * The organisation account of the person a human request runs for, from the verified request
   * scope; absent for a system context. The directory projects this account as its person record.
   */
  viewerOrganizationAccountId?: string;
}>;

/** Contexts this loader assembled; a structurally identical object from anywhere else is refused. */
const assembledContexts = new WeakSet<object>();

/** Returns the context only when this loader assembled it, so a consumer cannot be handed a forgery. */
export const requireInstalledRuntimeContext = (candidate: unknown): InstalledRuntimeContext => {
  if (typeof candidate !== "object" || candidate === null || !assembledContexts.has(candidate))
    throw new DefinitionError("INSTALLED_RUNTIME_CONTEXT_REFUSED");
  return candidate as InstalledRuntimeContext;
};

const failure = (code: InstalledRuntimeContextErrorCode, cause: unknown) =>
  new DefinitionError(code, { cause });

const installationFailure = (error: unknown): DefinitionError<InstalledRuntimeContextErrorCode> => {
  switch (databaseErrorCode(error)) {
    case "ACTIVE_APPLICATION_CONTEXT_REFUSED":
      return failure("INSTALLED_RUNTIME_CONTEXT_REFUSED", error);
    case "ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE":
      return failure("INSTALLED_RUNTIME_CONTEXT_UNAVAILABLE", error);
    case "ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE":
      return failure("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED", error);
    default:
      return unexpectedDefinitionFailure(
        "INSTALLED_RUNTIME_CONTEXT_TEMPORARILY_UNAVAILABLE",
        error,
        "installed runtime context",
      );
  }
};

/**
 * The scope of a human-request context: the organisation and application the human request scope
 * resolved for this person, and the preview of that application the request runs instead of its
 * installation, if any. The installation comes from the protected active-installation read under
 * that one already-resolved human request transaction. It mints no system context or actor and
 * widens no grant: the assembled context only names the exact installed release, and every page,
 * navigation and data decision still runs through Access for that person.
 */
export type HumanInstalledRuntimeScope = Readonly<{
  organizationId: string;
  organizationAccountId: string;
  applicationRootId: string;
  previewInstallationId?: string;
}>;

/**
 * Waits for the protected active-installation read and proves the installation belongs to the
 * organisation and application the request resolved.
 */
export const readHumanActiveInstallation = async (
  currentInstallation: Promise<ActiveApplicationInstallationEvidence>,
  scope: HumanInstalledRuntimeScope,
): Promise<ActiveApplicationInstallationEvidence> => {
  let installationCandidate: unknown;
  try {
    installationCandidate = await currentInstallation;
  } catch (error) {
    throw installationFailure(error);
  }
  const installation = activeApplicationInstallationEvidenceSchema.safeParse(installationCandidate);
  if (!installation.success)
    throw new DefinitionError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED");
  if (
    !sameId(installation.data.organizationId, scope.organizationId) ||
    !sameId(installation.data.applicationRootId, scope.applicationRootId)
  )
    throw new DefinitionError("INSTALLED_RUNTIME_CONTEXT_REFUSED");
  return installation.data;
};

/** Assembles the human-request context from an installation and an already validated release set. */
export const assembleHumanInstalledRuntimeContext = (
  installation: ActiveApplicationInstallationEvidence,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  scope: HumanInstalledRuntimeScope,
  /**
   * Prepares the registration for the validated release set. A caller holding an immutable,
   * already validated release may reuse the registration it prepared for that same release; the
   * default prepares it from this release set.
   */
  prepareRegistration: (
    validated: SystemApplicationBoundReleaseSetResult,
    prepare: (
      validated: SystemApplicationBoundReleaseSetResult,
    ) => PreparedApplicationPermissionRegistration,
  ) => PreparedApplicationPermissionRegistration = (validated, prepare) => prepare(validated),
  /** The installed contributions on the release set's record types; a preview receives none. */
  contributions: InstalledRecordContributions = noInstalledRecordContributions,
): InstalledRuntimeContext =>
  assembleContext(
    installation,
    releaseSet,
    scope.organizationId,
    undefined,
    scope.organizationAccountId,
    contributions,
    (validated) =>
      prepareRegistration(validated, (candidate) =>
        prepareApplicationPermissionRegistrationForHumanRequest(
          scope.organizationId,
          {
            applicationRootId: installation.applicationRootId,
            releaseRevision: installation.applicationReleaseRevision,
          },
          candidate,
        ),
      ),
  );

/**
 * Verifies that the validated release set matches the installation and assembles the one trusted context.
 * `expectedCorrelationId` is the system correlation when one exists; a human request has none and
 * relies on the release set's own single correlation being shared by every release in it.
 */
const assembleContext = (
  installation: ActiveApplicationInstallationEvidence,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  organizationId: string,
  expectedCorrelationId: string | undefined,
  viewerOrganizationAccountId: string | undefined,
  contributions: InstalledRecordContributions,
  prepareRegistration: (
    releaseSet: SystemApplicationBoundReleaseSetResult,
  ) => PreparedApplicationPermissionRegistration,
): InstalledRuntimeContext => {
  const application = releaseSet.application;
  if (
    !sameId(application.organizationId, organizationId) ||
    !sameId(application.organizationId, installation.organizationId) ||
    !sameId(application.rootId, installation.applicationRootId) ||
    application.releaseRevision !== installation.applicationReleaseRevision ||
    (expectedCorrelationId !== undefined &&
      !sameId(application.correlationId, expectedCorrelationId)) ||
    releaseSet.modules.length === 0
  )
    throw new DefinitionError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED");

  // The bound release set must carry exactly one release per active installation binding.
  const releasesByRoot = new Map<string, number>();
  for (const module of releaseSet.modules) {
    const root = module.rootId.toLowerCase();
    if (
      releasesByRoot.has(root) ||
      !sameId(module.organizationId, application.organizationId) ||
      !sameId(module.correlationId, application.correlationId)
    )
      throw new DefinitionError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED");
    releasesByRoot.set(root, module.releaseRevision);
  }
  if (releasesByRoot.size !== installation.moduleBindings.length)
    throw new DefinitionError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED");
  for (const binding of installation.moduleBindings) {
    const releaseRevision = releasesByRoot.get(binding.moduleRootId.toLowerCase());
    if (releaseRevision === undefined || releaseRevision !== binding.moduleReleaseRevision)
      throw new DefinitionError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED");
  }

  let permissionRegistration: PreparedApplicationPermissionRegistration;
  try {
    permissionRegistration = prepareRegistration(releaseSet);
  } catch (error) {
    throw failure("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED", error);
  }

  const context: InstalledRuntimeContext = Object.freeze({
    organizationId: application.organizationId,
    applicationRootId: application.rootId,
    applicationReleaseRevision: application.releaseRevision,
    correlationId: application.correlationId,
    // The registration above is prepared from the exact release set; the context then serves the
    // same release set with the contributed fields listed on their owner record types.
    releaseSet: withInstalledRecordContributions(releaseSet, contributions),
    permissionRegistration,
    installation,
    recordContributions: contributions.recordTypes,
    ...(viewerOrganizationAccountId === undefined ? {} : { viewerOrganizationAccountId }),
  });
  assembledContexts.add(context);
  return context;
};

export type InstalledRuntimeContextLoader = Readonly<{ load(): Promise<InstalledRuntimeContext> }>;
