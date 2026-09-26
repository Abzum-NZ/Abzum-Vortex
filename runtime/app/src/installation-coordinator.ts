import "server-only";

import { randomUUID } from "node:crypto";
import {
  applicationRootIdSchema,
  identitySessionSchema,
  moduleInstallationBindingEvidenceSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  projectLiveApplicationRolePermissions,
  revisionSchema,
  sessionContextSchema,
  type ApplicationInstallationLifecycleResult,
  type ApplicationRootId,
  type IdentitySession,
  type ModuleInstallationBindingEvidence,
  type ModuleInstallationStorageResult,
  type ModuleRootId,
  type OrganizationId,
  type PreparedApplicationRoleTemplates,
  type SelectedOrganizationScope,
  type SessionContext,
  type SystemApplicationBoundReleaseSetResult,
} from "@vortex/contracts";
import {
  BuilderAuthorityError,
  createApplicationRoleTemplateAdapter,
  requireBuilderAuthority,
  type BuilderAuthority,
  type BuilderConferredPermission,
  type BuilderOperation,
  type createHumanOrganizationRequestService,
  type PermissionRegistryDefinitionSetReader,
} from "@vortex/access";
import {
  ApplicationInstallationLifecycleError,
  ModuleInstallationStorageError,
  createApplicationInstallationLifecycleRepository,
  createModuleInstallationStorageRepository,
} from "@vortex/module";
import type { RequestDatabaseTransaction } from "@vortex/db";
import { z } from "zod";

/**
 * The App-owned protected Application lifecycle: prepare, install or deliberately upgrade to one
 * exact published release, begin the uninstall by draining it, or withdraw it.
 *
 * Publication never reaches this module; an installation changes only when an authenticated
 * installer invokes it. Every write runs in that installer's own human request transaction, so the
 * database derives organisation, actor, correlation and the application-management decision from
 * trusted context. Nothing here accepts identity, authority or readiness from the caller.
 *
 * Builder authority is required on top of that. Every installer transaction first passes the
 * installer's own builder authority: `applications.manage`, plus `custom_code.manage` when the
 * exact package contains custom components; uninstalling a system application is always refused.
 * Installing custom components or accepting role templates additionally needs the
 * installer's recent authentication, and accepting role templates is refused unless every
 * permission they confer lies inside the installer's delegated assignment scope.
 *
 * The fixed activation requires the Application permission registration to name the exact release
 * it activates, and pins the organisation Access version that a registration change advances. The
 * Access change therefore commits in its own transaction before the binding switch:
 *
 * 1. Align Access: register, update or reactivate the permission registration for the exact target
 *    release when it does not already name it. Registration assigns nothing to anybody.
 * 2. Switch: detach the previously active release (upgrade only), prepare storage for every pinned
 *    Module release, activate the complete binding set through the fixed operation (which also
 *    gates executable lifecycle policies) and append the lifecycle Activity. Any failure rolls the
 *    whole switch back, so the previously active exact release stays selected, and an upgrade then
 *    restores the registration to that still-active release.
 *
 * A first installation is prepared before it is activated: `prepare` commits the registration and
 * the provisioned (inactive) storage, so the installer can store the initial record-type lifecycle
 * policies the activation gate requires. An upgrade cannot pre-provision a Module its active
 * release still binds, so its storage is prepared inside the atomic switch.
 *
 * Withdrawal is one transaction: detach the active binding set (storage and records are retained),
 * append its Activity, then withdraw the permission registration through the Access coordinator,
 * which refuses a change that would leave the organisation without a permanent steward.
 */

type InstallerRequests = Pick<ReturnType<typeof createHumanOrganizationRequestService>, "runChange">;
type InstallerTransaction = Parameters<typeof createModuleInstallationStorageRepository>[0];

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

export class ApplicationInstallationCoordinatorError extends Error {
  readonly code: ApplicationInstallationCoordinatorErrorCode;

  constructor(code: ApplicationInstallationCoordinatorErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "ApplicationInstallationCoordinatorError";
    this.code = code;
  }
}

const safeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

/** Prepare one exact release for first installation; nothing becomes active. */
export const applicationInstallationPreparationRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: safeRevisionSchema,
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
    applicationReleaseRevision: safeRevisionSchema,
    expectedActiveReleaseRevision: safeRevisionSchema.nullable(),
  })
  .strict();

/** Withdraw exactly the named installed or prepared release. */
export const applicationInstallationWithdrawalRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: safeRevisionSchema,
  })
  .strict();

/** Begin the uninstall of exactly the named active installation by draining it. */
export const applicationInstallationDrainRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: safeRevisionSchema,
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
  | Readonly<{ kind: "available"; value: Value }>
  | Readonly<{ kind: "unavailable" }>;

export type ActiveApplicationInstallationSummary = Readonly<{
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  applicationReleaseRevision: number;
  moduleBindings: readonly ModuleInstallationBindingEvidence[];
}>;

export type ApplicationInstallationPreparationResult = Readonly<{
  outcome: "prepared" | "unchanged";
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  applicationReleaseRevision: number;
  /** The provisioned, inactive bindings the initial lifecycle-policy setup names. */
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
 * context (see #610) supplies this; the protected Definition reads still run through governed
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
}>;

type BindingRow = Readonly<{ bindings: unknown }>;
type AccessRow = Readonly<{ access_change: unknown }>;

const installationBindingsSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    registeredReleaseRevision: safeRevisionSchema.nullable(),
    moduleBindings: z.array(moduleInstallationBindingEvidenceSchema).max(10_000),
  })
  .strict();

const accessChangeSchema = z
  .object({
    outcome: z.enum(["changed", "unchanged"]),
    operation: z.enum(["register", "update", "reactivate", "withdraw"]),
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    registrationState: z.enum(["active", "withdrawn"]),
    registrationRevision: safeRevisionSchema,
  })
  .strict();

const installationDrainResultSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: safeRevisionSchema,
    state: z.literal("draining"),
    changed: z.boolean(),
    moduleBindings: z.array(moduleInstallationBindingEvidenceSchema).max(10_000),
  })
  .strict();

type InstallationBindings = z.infer<typeof installationBindingsSchema>;
type ExpectedModuleBinding = Readonly<{ moduleRootId: ModuleRootId; bindingRevision: number }>;
type ModulePin = Readonly<{ moduleRootId: ModuleRootId; moduleReleaseRevision: number }>;
type ExactRelease = Readonly<{
  releaseSet: SystemApplicationBoundReleaseSetResult;
  preparedTemplates: PreparedApplicationRoleTemplates;
  pins: readonly ModulePin[];
}>;
type ReleaseTarget = InstallationReleaseTarget;

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const canonicalModuleRootId = (value: string): ModuleRootId =>
  moduleRootIdSchema.parse(value.toLowerCase());

const byModuleRoot = <Value extends { readonly moduleRootId: string }>(values: Value[]): Value[] =>
  values.sort((left, right) =>
    left.moduleRootId < right.moduleRootId ? -1 : left.moduleRootId > right.moduleRootId ? 1 : 0,
  );

const fail = (code: ApplicationInstallationCoordinatorErrorCode, cause?: unknown) =>
  new ApplicationInstallationCoordinatorError(code, cause === undefined ? undefined : { cause });

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const toCoordinatorError = (error: unknown): ApplicationInstallationCoordinatorError => {
  if (error instanceof ApplicationInstallationCoordinatorError) return error;
  if (error instanceof BuilderAuthorityError)
    return fail(
      error.code === "BUILDER_RECENT_AUTHENTICATION_REQUIRED"
        ? "APPLICATION_INSTALLATION_RECENT_AUTHENTICATION_REQUIRED"
        : "APPLICATION_INSTALLATION_PERMISSION_REFUSED",
      error,
    );
  if (error instanceof ModuleInstallationStorageError)
    switch (error.code) {
      case "INVALID_MODULE_INSTALLATION_STORAGE_COMMAND":
        return fail("INVALID_APPLICATION_INSTALLATION_COMMAND", error);
      case "MODULE_INSTALLATION_AUTHORITY_REFUSED":
        return fail("APPLICATION_INSTALLATION_REFUSED", error);
      case "MODULE_INSTALLATION_RELEASE_UNAVAILABLE":
      case "MODULE_INSTALLATION_RELEASE_MISMATCH":
        return fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE", error);
      case "MODULE_INSTALLATION_BINDING_CONFLICT":
        return fail("APPLICATION_INSTALLATION_STALE", error);
      case "RECORD_STORAGE_INCOMPATIBLE":
        return fail("APPLICATION_INSTALLATION_STORAGE_INCOMPATIBLE", error);
      case "RECORD_STORAGE_PROVISIONING_FAILED":
        return fail("APPLICATION_INSTALLATION_FAILED", error);
    }
  if (error instanceof ApplicationInstallationLifecycleError)
    switch (error.code) {
      case "INVALID_APPLICATION_INSTALLATION_LIFECYCLE_COMMAND":
        return fail("INVALID_APPLICATION_INSTALLATION_COMMAND", error);
      case "APPLICATION_INSTALLATION_AUTHORITY_REFUSED":
        return fail("APPLICATION_INSTALLATION_REFUSED", error);
      case "APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE":
        return fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE", error);
      case "APPLICATION_INSTALLATION_BINDING_CONFLICT":
        return fail("APPLICATION_INSTALLATION_STALE", error);
      case "APPLICATION_INSTALLATION_BINDINGS_INCOMPLETE":
        return fail("APPLICATION_INSTALLATION_INCOMPLETE", error);
      case "APPLICATION_INSTALLATION_CHANGE_FAILED":
        return fail("APPLICATION_INSTALLATION_FAILED", error);
    }
  switch (databaseCode(error)) {
    case "22023":
      return fail("INVALID_APPLICATION_INSTALLATION_COMMAND", error);
    case "42501":
      return fail("APPLICATION_INSTALLATION_REFUSED", error);
    case "P0002":
      return fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE", error);
    case "40001":
    case "23503":
    case "23505":
    case "23514":
    case "55000":
      return fail("APPLICATION_INSTALLATION_STALE", error);
    default:
      return fail("APPLICATION_INSTALLATION_FAILED", error);
  }
};

const readInstallationBindings = async (
  transaction: InstallerTransaction,
  organizationId: OrganizationId,
  applicationRootId: ApplicationRootId,
): Promise<InstallationBindings> => {
  const rows = await transaction.query<BindingRow>`
    select vortex_module.read_application_installation_bindings(
      ${applicationRootId}::uuid
    ) as bindings
  `;
  const parsed = rows.length === 1 ? installationBindingsSchema.safeParse(rows[0]?.bindings) : null;
  if (
    parsed === null ||
    !parsed.success ||
    !sameId(parsed.data.applicationRootId, applicationRootId) ||
    parsed.data.moduleBindings.some(
      (binding) =>
        !sameId(binding.organizationId, parsed.data.organizationId) ||
        !sameId(binding.applicationRootId, applicationRootId),
    )
  )
    throw fail("APPLICATION_INSTALLATION_FAILED");
  // The installer's trusted request context selects the organisation; a different one is refused.
  if (!sameId(parsed.data.organizationId, organizationId))
    throw fail("APPLICATION_INSTALLATION_REFUSED");
  return parsed.data;
};

/** The single active release, if any. Mixed active releases are never guessed between. */
const activeRelease = (
  state: InstallationBindings,
): Readonly<{ releaseRevision: number; bindings: ModuleInstallationBindingEvidence[] }> | null => {
  const active = state.moduleBindings.filter((binding) => binding.state === "active");
  if (active.length === 0) return null;
  const releaseRevision = active[0]!.applicationReleaseRevision;
  if (active.some((binding) => binding.applicationReleaseRevision !== releaseRevision))
    throw fail("APPLICATION_INSTALLATION_STALE");
  return { releaseRevision, bindings: active };
};

/**
 * A draining installation is being uninstalled: it is never prepared, activated, upgraded or
 * withdrawn until the uninstall completes, so no step returns it to service or removes the access
 * that work still running relies on.
 */
const requireNotDraining = (state: InstallationBindings): void => {
  if (state.moduleBindings.some((binding) => binding.state === "draining"))
    throw fail("APPLICATION_INSTALLATION_STALE");
};

const expectedBindings = (
  bindings: readonly Pick<ModuleInstallationBindingEvidence, "moduleRootId" | "bindingRevision">[],
): ExpectedModuleBinding[] =>
  byModuleRoot(
    bindings.map((binding) => ({
      moduleRootId: canonicalModuleRootId(binding.moduleRootId),
      bindingRevision: binding.bindingRevision,
    })),
  );

const currentBindingRevisions = (state: InstallationBindings): Map<ModuleRootId, number> =>
  new Map(
    state.moduleBindings.map((binding) => [
      canonicalModuleRootId(binding.moduleRootId),
      binding.bindingRevision,
    ]),
  );

const changeAccess = async (
  transaction: InstallerTransaction,
  activityId: string,
  applicationRootId: ApplicationRootId,
  change: "prepare" | "withdraw",
  preparedTemplates: PreparedApplicationRoleTemplates | null,
): Promise<z.infer<typeof accessChangeSchema>> => {
  const rows = await transaction.query<AccessRow>`
    select vortex_access.change_application_installation_access(
      ${activityId}::uuid,
      ${applicationRootId}::uuid,
      ${change}::text,
      ${preparedTemplates === null ? null : JSON.stringify(preparedTemplates)}::text::jsonb
    ) as access_change
  `;
  const parsed = rows.length === 1 ? accessChangeSchema.safeParse(rows[0]?.access_change) : null;
  if (
    parsed === null ||
    !parsed.success ||
    !sameId(parsed.data.applicationRootId, applicationRootId) ||
    (change === "prepare"
      ? parsed.data.registrationState !== "active" || parsed.data.operation === "withdraw"
      : parsed.data.registrationState !== "withdrawn" || parsed.data.operation !== "withdraw")
  )
    throw fail("APPLICATION_INSTALLATION_FAILED");
  return parsed.data;
};

const recordOutcome = async (
  transaction: InstallerTransaction,
  activityId: string,
  applicationRootId: ApplicationRootId,
  applicationReleaseRevision: number,
  state: "active" | "detached",
): Promise<void> => {
  await transaction.query`
    select vortex_module.record_application_installation_outcome(
      ${activityId}::uuid,
      ${applicationRootId}::uuid,
      ${applicationReleaseRevision}::bigint,
      ${state}::text
    )
  `;
};

type DrainRow = Readonly<{ drain_result: unknown }>;

/** Moves one exact active installation to draining through the fixed protected operation. */
const drainInstallation = async (
  transaction: InstallerTransaction,
  activityId: string,
  applicationRootId: ApplicationRootId,
  applicationReleaseRevision: number,
  expectedModuleBindings: readonly ExpectedModuleBinding[],
): Promise<z.infer<typeof installationDrainResultSchema>> => {
  const rows = await transaction.query<DrainRow>`
    select vortex_module.drain_installation(
      ${activityId}::uuid,
      ${applicationRootId}::uuid,
      ${applicationReleaseRevision}::bigint,
      ${JSON.stringify(expectedModuleBindings)}::jsonb
    ) as drain_result
  `;
  const parsed =
    rows.length === 1 ? installationDrainResultSchema.safeParse(rows[0]?.drain_result) : null;
  if (
    parsed === null ||
    !parsed.success ||
    !sameId(parsed.data.applicationRootId, applicationRootId) ||
    parsed.data.applicationReleaseRevision !== applicationReleaseRevision ||
    parsed.data.moduleBindings.length !== expectedModuleBindings.length ||
    parsed.data.moduleBindings.some(
      (binding) =>
        binding.state !== "draining" ||
        !sameId(binding.organizationId, parsed.data.organizationId) ||
        !sameId(binding.applicationRootId, applicationRootId) ||
        binding.applicationReleaseRevision !== applicationReleaseRevision,
    )
  )
    throw fail("APPLICATION_INSTALLATION_FAILED");
  return parsed.data;
};

/** Storage for every pinned Module release; commits only inactive, idempotent bindings. */
const provisionPins = async (
  transaction: InstallerTransaction,
  target: ReleaseTarget,
  pins: readonly ModulePin[],
  current: ReadonlyMap<ModuleRootId, number>,
): Promise<ModuleInstallationStorageResult[]> => {
  const storage = createModuleInstallationStorageRepository(transaction);
  const provisioned: ModuleInstallationStorageResult[] = [];
  for (const pin of pins) {
    const result = await storage.provision({
      applicationRootId: target.applicationRootId,
      applicationReleaseRevision: target.applicationReleaseRevision,
      moduleRootId: pin.moduleRootId,
      moduleReleaseRevision: pin.moduleReleaseRevision,
      expectedBindingRevision: current.get(pin.moduleRootId) ?? null,
    });
    if (
      !sameId(result.applicationRootId, target.applicationRootId) ||
      !sameId(result.moduleRootId, pin.moduleRootId) ||
      result.moduleReleaseRevision !== pin.moduleReleaseRevision ||
      result.applicationReleaseRevision !== target.applicationReleaseRevision
    )
      throw fail("APPLICATION_INSTALLATION_FAILED");
    provisioned.push(result);
  }
  return provisioned;
};

const summary = (
  result: ApplicationInstallationLifecycleResult,
): ActiveApplicationInstallationSummary => ({
  organizationId: result.organizationId,
  applicationRootId: result.applicationRootId,
  applicationReleaseRevision: result.applicationReleaseRevision,
  moduleBindings: result.moduleBindings,
});

const requireLifecycleResult = (
  result: ApplicationInstallationLifecycleResult,
  applicationRootId: ApplicationRootId,
  applicationReleaseRevision: number,
  state: "active" | "detached",
): ApplicationInstallationLifecycleResult => {
  if (
    !sameId(result.applicationRootId, applicationRootId) ||
    result.applicationReleaseRevision !== applicationReleaseRevision ||
    result.state !== state
  )
    throw fail("APPLICATION_INSTALLATION_FAILED");
  return result;
};

export const createApplicationInstallationCoordinator = <InstalledEvents = never>(
  dependencies: ApplicationInstallationCoordinatorDependencies<InstalledEvents>,
) => {
  const newActivityId = dependencies.activityId ?? randomUUID;
  const humanDefinitionAccess = dependencies.humanDefinitionAccess;
  const roleTemplates =
    humanDefinitionAccess !== undefined || dependencies.definitionReader === undefined
      ? undefined
      : createApplicationRoleTemplateAdapter({
          definitionReader: dependencies.definitionReader,
          // Registration-candidate preparation reads only immutable Definition evidence; the live
          // registry is read and locked by the Access coordinator inside the installer's transaction.
          permissionRegistryFacts: {
            lookup: () => Promise.reject(fail("APPLICATION_INSTALLATION_FAILED")),
            readApplicationSnapshot: () => Promise.reject(fail("APPLICATION_INSTALLATION_FAILED")),
          },
        });

  /**
   * Runs one installer change transaction. The request runner reports only a coarse outcome, so
   * the typed failure is captured before the transaction rolls back.
   */
  const inInstallerTransaction = async <Result>(
    session: IdentitySession,
    organizationId: OrganizationId,
    builderOperation: BuilderOperation,
    operation: (transaction: InstallerTransaction, authority: BuilderAuthority) => Promise<Result>,
  ): Promise<Result> => {
    const captured: { failure?: ApplicationInstallationCoordinatorError } = {};
    const outcome = await dependencies.installerRequests
      .runChange(session, { organizationId }, async (transaction, scope) => {
        try {
          // The builder authority is decided first, from the installer's own request scope, before
          // anything is read or written in this transaction.
          const authority = dependencies.builderAuthority(transaction, scope);
          if (!sameId(authority.organizationId, organizationId))
            throw fail("APPLICATION_INSTALLATION_REFUSED");
          await requireBuilderAuthority(authority, builderOperation);
          return await operation(transaction, authority);
        } catch (error) {
          captured.failure = toCoordinatorError(error);
          throw error;
        }
      })
      .catch((error: unknown) => {
        throw captured.failure ?? toCoordinatorError(error);
      });
    if (outcome.kind === "available") return outcome.value;
    if (captured.failure !== undefined) throw captured.failure;
    throw fail(
      outcome.kind === "unavailable"
        ? "APPLICATION_INSTALLATION_REFUSED"
        : "APPLICATION_INSTALLATION_TEMPORARILY_UNAVAILABLE",
    );
  };

  /** Every permission the prepared role templates would confer on a live role. */
  const conferredPermissions = (
    preparedTemplates: PreparedApplicationRoleTemplates,
  ): BuilderConferredPermission[] => {
    const permissions = new Map<string, BuilderConferredPermission>();
    for (const prepared of preparedTemplates.templates)
      for (const entry of [
        ...projectLiveApplicationRolePermissions(
          prepared.template.permissionSelection,
          preparedTemplates.permissionRegistration.applicationRootId,
          prepared.sourcePermissions,
        ),
        ...prepared.livePermissions,
      ]) {
        const permission: BuilderConferredPermission = {
          applicationRootId: String(entry.applicationRootId),
          ownerKind: entry.ownerKind,
          ownerId: String(entry.ownerId),
          permissionId: String(entry.permission.permissionId),
        };
        permissions.set(
          [permission.applicationRootId, permission.ownerKind, permission.ownerId, permission.permissionId]
            .join(":")
            .toLowerCase(),
          permission,
        );
      }
    return [...permissions.values()];
  };

  /** The builder operation for installing or upgrading to one exact release. */
  const installOperation = (
    applicationRootId: ApplicationRootId,
    exact: ExactRelease,
    accepting: boolean,
  ): BuilderOperation => ({
    kind: "installation",
    applicationRootId,
    change: "install_or_upgrade",
    containsCustomComponents: dependencies.containsCustomComponents(exact.releaseSet),
    acceptedPermissions: accepting ? conferredPermissions(exact.preparedTemplates) : [],
  });

  /** The live system context for the target organisation, or a refusal. */
  const definitionContext = (target: ReleaseTarget): SessionContext => {
    const context = sessionContextSchema.safeParse(
      dependencies.definitionSystemContext === undefined
        ? undefined
        : dependencies.definitionSystemContext(),
    );
    if (
      !context.success ||
      context.data.callerKind !== "system" ||
      !sameId(context.data.organizationId, target.organizationId)
    )
      throw fail("APPLICATION_INSTALLATION_REFUSED");
    return context.data;
  };

  /** Reads only the exact release set, the evidence the builder authority derives its facts from. */
  const readReleaseSet = async (
    session: IdentitySession,
    target: ReleaseTarget,
  ): Promise<SystemApplicationBoundReleaseSetResult> => {
    if (humanDefinitionAccess !== undefined) {
      try {
        return await humanDefinitionAccess.readReleaseSet(session, target);
      } catch (error) {
        throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE", error);
      }
    }
    const context = definitionContext(target);
    if (dependencies.definitionReader === undefined)
      throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
    try {
      return await dependencies.definitionReader.read(context, {
        applicationRootId: target.applicationRootId,
        applicationReleaseRevision: target.applicationReleaseRevision,
      });
    } catch (error) {
      throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE", error);
    }
  };

  /** Loads the exact Application and its resolved Module pin set, never the latest release. */
  const readExactRelease = async (
    session: IdentitySession,
    target: ReleaseTarget,
  ): Promise<ExactRelease> => {
    let releaseSet: SystemApplicationBoundReleaseSetResult;
    let preparedTemplates: PreparedApplicationRoleTemplates;
    try {
      if (humanDefinitionAccess !== undefined) {
        releaseSet = await humanDefinitionAccess.readReleaseSet(session, target);
        preparedTemplates = await humanDefinitionAccess.prepareRegistrationCandidate(target, releaseSet);
      } else if (roleTemplates !== undefined) {
        const context = definitionContext(target);
        releaseSet = await dependencies.definitionReader!.read(context, {
          applicationRootId: target.applicationRootId,
          applicationReleaseRevision: target.applicationReleaseRevision,
        });
        preparedTemplates = await roleTemplates.prepareRegistrationCandidate(context, {
          applicationRootId: target.applicationRootId,
          releaseRevision: target.applicationReleaseRevision,
        });
      } else {
        throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
      }
    } catch (error) {
      if (error instanceof ApplicationInstallationCoordinatorError) throw error;
      throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE", error);
    }
    const application = releaseSet.application;
    if (
      application.kind !== "application" ||
      !sameId(application.organizationId, target.organizationId) ||
      !sameId(application.rootId, target.applicationRootId) ||
      application.releaseRevision !== target.applicationReleaseRevision ||
      !sameId(preparedTemplates.permissionRegistration.organizationId, target.organizationId) ||
      !sameId(
        preparedTemplates.permissionRegistration.applicationRootId,
        target.applicationRootId,
      ) ||
      preparedTemplates.permissionRegistration.applicationRelease.releaseRevision !==
        target.applicationReleaseRevision
    )
      throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
    // The fixed activation requires at least one pinned Module binding.
    if (releaseSet.modules.length === 0) throw fail("APPLICATION_INSTALLATION_INCOMPLETE");
    const pins: ModulePin[] = byModuleRoot(
      releaseSet.modules.map((module) => ({
        moduleRootId: canonicalModuleRootId(module.rootId),
        moduleReleaseRevision: module.releaseRevision,
      })),
    );
    return { releaseSet, preparedTemplates, pins };
  };

  /**
   * Points the permission registration at exactly this release when it names another one or none.
   * Returns whether Access changed; an unchanged registration costs no Access-version advance.
   */
  const alignAccess = async (
    transaction: InstallerTransaction,
    authority: BuilderAuthority,
    state: InstallationBindings,
    applicationRootId: ApplicationRootId,
    applicationReleaseRevision: number,
    exact: ExactRelease,
    acceptance: "accept_role_templates" | "restore_accepted_role_templates",
  ): Promise<boolean> => {
    if (state.registeredReleaseRevision === applicationReleaseRevision) return false;
    // Registering the release accepts its role templates. That needs the installer's recent
    // authentication and every permission the templates confer inside the installer's delegated
    // assignment scope, whatever any approval workflow says. It is decided in the same
    // transaction and before registration: registering advances the Access version the request
    // context is pinned to, so no decision can be made after it, and a permission the current
    // registration does not yet hold lies outside every bounded delegated scope. Restoring the
    // registration of a release that was already accepted grants nothing new and is not a fresh
    // acceptance.
    if (acceptance === "accept_role_templates")
      await requireBuilderAuthority(authority, installOperation(applicationRootId, exact, true));
    const access = await changeAccess(
      transaction,
      newActivityId(),
      applicationRootId,
      "prepare",
      exact.preparedTemplates,
    );
    return access.outcome === "changed";
  };

  /**
   * After a failed upgrade switch, points the registration back at the release that is still
   * active. It acts only on the state it re-reads, so a switch that did commit is never undone. If
   * this restoration cannot complete, activating the still-active release again realigns Access.
   */
  const restoreAccessToActiveRelease = async (
    session: IdentitySession,
    request: ApplicationInstallationActivationRequest,
    activeReleaseRevision: number,
  ): Promise<void> => {
    const prior = await readExactRelease(session, {
      organizationId: request.organizationId,
      applicationRootId: request.applicationRootId,
      applicationReleaseRevision: activeReleaseRevision,
    });
    await inInstallerTransaction(
      session,
      request.organizationId,
      installOperation(request.applicationRootId, prior, false),
      async (transaction, authority) => {
        const state = await readInstallationBindings(
          transaction,
          request.organizationId,
          request.applicationRootId,
        );
        if (activeRelease(state)?.releaseRevision !== activeReleaseRevision) return;
        await alignAccess(
          transaction,
          authority,
          state,
          request.applicationRootId,
          activeReleaseRevision,
          prior,
          "restore_accepted_role_templates",
        );
      },
    );
  };

  /** Projected after commit; a missing or failing optional reader never undoes the change. */
  const installedEvents = (
    releaseSet: SystemApplicationBoundReleaseSetResult,
    installation: ActiveApplicationInstallationSummary,
  ): OptionalInstallationReader<InstalledEvents> => {
    if (dependencies.projectInstalledEvents === undefined) return { kind: "unavailable" };
    try {
      return {
        kind: "available",
        value: dependencies.projectInstalledEvents({ definitions: releaseSet, installation }),
      };
    } catch {
      return { kind: "unavailable" };
    }
  };

  const activeSummary = (
    request: ApplicationInstallationActivationRequest,
    state: InstallationBindings,
  ): ActiveApplicationInstallationSummary => ({
    organizationId: state.organizationId,
    applicationRootId: request.applicationRootId,
    applicationReleaseRevision: request.applicationReleaseRevision,
    moduleBindings: byModuleRoot(
      state.moduleBindings.filter((binding) => binding.state === "active"),
    ),
  });

  /** The prior release (or none) must be exactly what the installer expected. */
  const requireExpectedActive = (
    request: ApplicationInstallationActivationRequest,
    active: ReturnType<typeof activeRelease>,
  ): "already_active" | "switch" => {
    if (active?.releaseRevision === request.applicationReleaseRevision) return "already_active";
    if ((active?.releaseRevision ?? null) !== request.expectedActiveReleaseRevision)
      throw fail("APPLICATION_INSTALLATION_STALE");
    return "switch";
  };

  return Object.freeze({
    /**
     * Prepares one exact release for first installation: aligns the permission registration and
     * commits provisioned, inactive storage for every pinned Module release. Nothing becomes
     * active, and an installation with an active release is refused as stale.
     */
    async prepare(
      session: IdentitySession,
      requestCandidate: ApplicationInstallationPreparationRequest,
    ): Promise<ApplicationInstallationPreparationResult> {
      const verifiedSession = identitySessionSchema.safeParse(session);
      const parsed = applicationInstallationPreparationRequestSchema.safeParse(requestCandidate);
      if (!verifiedSession.success || !parsed.success)
        throw fail("INVALID_APPLICATION_INSTALLATION_COMMAND");
      const request = parsed.data;
      const exact = await readExactRelease(verifiedSession.data, request);
      const { pins } = exact;

      // 1. Access must name the release before its provisioned setup can be administered.
      const accessChanged = await inInstallerTransaction(
        verifiedSession.data,
        request.organizationId,
        installOperation(request.applicationRootId, exact, false),
        async (transaction, authority) => {
          const state = await readInstallationBindings(
            transaction,
            request.organizationId,
            request.applicationRootId,
          );
          requireNotDraining(state);
          if (activeRelease(state) !== null) throw fail("APPLICATION_INSTALLATION_STALE");
          return alignAccess(
            transaction,
            authority,
            state,
            request.applicationRootId,
            request.applicationReleaseRevision,
            exact,
            "accept_role_templates",
          );
        },
      );

      // 2. Commit inactive storage for the complete pin set.
      return inInstallerTransaction(
        verifiedSession.data,
        request.organizationId,
        installOperation(request.applicationRootId, exact, false),
        async (transaction) => {
          const state = await readInstallationBindings(
            transaction,
            request.organizationId,
            request.applicationRootId,
          );
          requireNotDraining(state);
          if (activeRelease(state) !== null) throw fail("APPLICATION_INSTALLATION_STALE");
          // A still-provisioned binding outside this pin set would block its activation, and the
          // fixed operations cannot detach an inactive binding.
          const pinned = new Set(pins.map((pin) => pin.moduleRootId));
          if (
            state.moduleBindings.some(
              (binding) =>
                binding.state !== "detached" &&
                !pinned.has(canonicalModuleRootId(binding.moduleRootId)),
            )
          )
            throw fail("APPLICATION_INSTALLATION_INCOMPLETE");

          const provisioned = await provisionPins(
            transaction,
            request,
            pins,
            currentBindingRevisions(state),
          );
          return {
            outcome:
              accessChanged || provisioned.some((result) => result.changed)
                ? "prepared"
                : "unchanged",
            organizationId: state.organizationId,
            applicationRootId: request.applicationRootId,
            applicationReleaseRevision: request.applicationReleaseRevision,
            moduleBindings: provisioned.map((result) => ({
              organizationId: state.organizationId,
              applicationRootId: request.applicationRootId,
              moduleRootId: result.moduleRootId,
              bindingRevision: result.bindingRevision,
              applicationReleaseRevision: result.applicationReleaseRevision,
              moduleReleaseRevision: result.moduleReleaseRevision,
              state: "provisioned" as const,
            })),
          } satisfies ApplicationInstallationPreparationResult;
        },
      );
    },

    /**
     * Installs, or deliberately upgrades to, one exact published Application release. On any
     * failure of the switch transaction the previously active exact release remains selected.
     */
    async activate(
      session: IdentitySession,
      requestCandidate: ApplicationInstallationActivationRequest,
    ): Promise<ApplicationInstallationActivationResult<InstalledEvents>> {
      const verifiedSession = identitySessionSchema.safeParse(session);
      const parsed = applicationInstallationActivationRequestSchema.safeParse(requestCandidate);
      if (!verifiedSession.success || !parsed.success)
        throw fail("INVALID_APPLICATION_INSTALLATION_COMMAND");
      const request = parsed.data;
      const exact = await readExactRelease(verifiedSession.data, request);
      const { releaseSet, pins } = exact;

      // 1. Align Access with the exact target release. This must commit before the switch: it
      //    advances the Access version that the fixed lifecycle operations pin to. An already
      //    active target is only realigned, which repairs a registration left by a failed upgrade.
      const alreadyActive = await inInstallerTransaction(
        verifiedSession.data,
        request.organizationId,
        installOperation(request.applicationRootId, exact, false),
        async (transaction, authority) => {
          const state = await readInstallationBindings(
            transaction,
            request.organizationId,
            request.applicationRootId,
          );
          requireNotDraining(state);
          const mode = requireExpectedActive(request, activeRelease(state));
          await alignAccess(
            transaction,
            authority,
            state,
            request.applicationRootId,
            request.applicationReleaseRevision,
            exact,
            "accept_role_templates",
          );
          return mode === "already_active" ? activeSummary(request, state) : null;
        },
      );
      if (alreadyActive !== null)
        return {
          outcome: "unchanged",
          previousApplicationReleaseRevision: request.applicationReleaseRevision,
          installation: alreadyActive,
          installedEvents: installedEvents(releaseSet, alreadyActive),
        };

      // 2. Switch atomically: detach the prior release, prepare storage, activate, record Activity.
      let switched: Omit<
        ApplicationInstallationActivationResult<InstalledEvents>,
        "installedEvents"
      >;
      try {
        switched = await inInstallerTransaction(
          verifiedSession.data,
          request.organizationId,
          installOperation(request.applicationRootId, exact, false),
          async (transaction) => {
            const state = await readInstallationBindings(
              transaction,
              request.organizationId,
              request.applicationRootId,
            );
            requireNotDraining(state);
            const active = activeRelease(state);
            if (requireExpectedActive(request, active) === "already_active")
              return {
                outcome: "unchanged" as const,
                previousApplicationReleaseRevision: request.applicationReleaseRevision,
                installation: activeSummary(request, state),
              };

            const lifecycle = createApplicationInstallationLifecycleRepository(transaction);
            const current = currentBindingRevisions(state);
            if (active !== null) {
              const detached = requireLifecycleResult(
                await lifecycle.detach({
                  applicationRootId: request.applicationRootId,
                  applicationReleaseRevision: active.releaseRevision,
                  expectedModuleBindings: expectedBindings(active.bindings),
                }),
                request.applicationRootId,
                active.releaseRevision,
                "detached",
              );
              for (const binding of detached.moduleBindings)
                current.set(canonicalModuleRootId(binding.moduleRootId), binding.bindingRevision);
            }

            const provisioned = await provisionPins(transaction, request, pins, current);
            const activated = requireLifecycleResult(
              await lifecycle.activate({
                applicationRootId: request.applicationRootId,
                applicationReleaseRevision: request.applicationReleaseRevision,
                expectedModuleBindings: expectedBindings(provisioned),
              }),
              request.applicationRootId,
              request.applicationReleaseRevision,
              "active",
            );
            if (activated.changed)
              await recordOutcome(
                transaction,
                newActivityId(),
                request.applicationRootId,
                request.applicationReleaseRevision,
                "active",
              );

            return {
              outcome: activated.changed ? ("activated" as const) : ("unchanged" as const),
              previousApplicationReleaseRevision: active?.releaseRevision ?? null,
              installation: summary(activated),
            };
          },
        );
      } catch (error) {
        // The prior exact release is still selected; point Access back at it. A failed first
        // installation keeps its registration, which grants nobody access and is needed for the
        // provisioned lifecycle-policy setup.
        if (request.expectedActiveReleaseRevision !== null)
          await restoreAccessToActiveRelease(
            verifiedSession.data,
            request,
            request.expectedActiveReleaseRevision,
          ).catch(() => undefined);
        throw error;
      }
      return { ...switched, installedEvents: installedEvents(releaseSet, switched.installation) };
    },

    /**
     * Withdraws exactly the named release. Bindings are detached, never deleted, so stored
     * records remain; a prepared release that never became active keeps its inactive storage. The
     * Access coordinator preserves final-steward, supplier and continuity safeguards. A draining
     * installation is refused: its uninstall owns what happens to it next.
     */
    async withdraw(
      session: IdentitySession,
      requestCandidate: ApplicationInstallationWithdrawalRequest,
    ): Promise<ApplicationInstallationWithdrawalResult> {
      const verifiedSession = identitySessionSchema.safeParse(session);
      const parsed = applicationInstallationWithdrawalRequestSchema.safeParse(requestCandidate);
      if (!verifiedSession.success || !parsed.success)
        throw fail("INVALID_APPLICATION_INSTALLATION_COMMAND");
      const request = parsed.data;
      const packageFacts = await readReleaseSet(verifiedSession.data, request);

      return inInstallerTransaction(
        verifiedSession.data,
        request.organizationId,
        {
          kind: "installation",
          applicationRootId: request.applicationRootId,
          change: "uninstall",
          containsCustomComponents: dependencies.containsCustomComponents(packageFacts),
          acceptedPermissions: [],
        },
        async (transaction) => {
          const state = await readInstallationBindings(
            transaction,
            request.organizationId,
            request.applicationRootId,
          );
          requireNotDraining(state);
          const active = activeRelease(state);
          if (
            active !== null
              ? active.releaseRevision !== request.applicationReleaseRevision
              : state.registeredReleaseRevision !== null &&
                state.registeredReleaseRevision !== request.applicationReleaseRevision
          )
            throw fail("APPLICATION_INSTALLATION_STALE");
          const releaseBindings = byModuleRoot(
            state.moduleBindings.filter(
              (binding) =>
                binding.applicationReleaseRevision === request.applicationReleaseRevision,
            ),
          );
          // The active set, or a retried withdrawal's already detached set. A prepared release
          // was never active, so only its registration is withdrawn; a retry finds it withdrawn.
          const detachable =
            active?.bindings ?? releaseBindings.filter((binding) => binding.state === "detached");
          if (releaseBindings.length === 0 && state.registeredReleaseRevision === null)
            throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");

          let detached: ApplicationInstallationLifecycleResult | null = null;
          if (detachable.length > 0) {
            detached = requireLifecycleResult(
              await createApplicationInstallationLifecycleRepository(transaction).detach({
                applicationRootId: request.applicationRootId,
                applicationReleaseRevision: request.applicationReleaseRevision,
                expectedModuleBindings: expectedBindings(detachable),
              }),
              request.applicationRootId,
              request.applicationReleaseRevision,
              "detached",
            );
            if (detached.changed)
              await recordOutcome(
                transaction,
                newActivityId(),
                request.applicationRootId,
                request.applicationReleaseRevision,
                "detached",
              );
          }

          // Last: withdrawing the registration advances the Access version.
          const access = await changeAccess(
            transaction,
            newActivityId(),
            request.applicationRootId,
            "withdraw",
            null,
          );

          return {
            outcome:
              detached?.changed === true || access.outcome === "changed"
                ? "withdrawn"
                : "unchanged",
            organizationId: state.organizationId,
            applicationRootId: request.applicationRootId,
            applicationReleaseRevision: request.applicationReleaseRevision,
            moduleBindings: detached?.moduleBindings ?? releaseBindings,
          } satisfies ApplicationInstallationWithdrawalResult;
        },
      );
    },

    /**
     * Drains exactly the named active installation: the uninstall command's first step. No new
     * flow, tool call or navigation load resolves a draining installation, while callbacks for
     * work already running keep the exact revision they were started against. A system
     * application is refused by builder authority; the Access-management application and a
     * Module an installed application depends on are refused by the protected operation.
     */
    async drain(
      session: IdentitySession,
      requestCandidate: ApplicationInstallationDrainRequest,
    ): Promise<ApplicationInstallationDrainResult> {
      const verifiedSession = identitySessionSchema.safeParse(session);
      const parsed = applicationInstallationDrainRequestSchema.safeParse(requestCandidate);
      if (!verifiedSession.success || !parsed.success)
        throw fail("INVALID_APPLICATION_INSTALLATION_COMMAND");
      const request = parsed.data;
      const packageFacts = await readReleaseSet(verifiedSession.data, request);

      return inInstallerTransaction(
        verifiedSession.data,
        request.organizationId,
        {
          kind: "installation",
          applicationRootId: request.applicationRootId,
          change: "uninstall",
          containsCustomComponents: dependencies.containsCustomComponents(packageFacts),
          acceptedPermissions: [],
        },
        async (transaction) => {
          const state = await readInstallationBindings(
            transaction,
            request.organizationId,
            request.applicationRootId,
          );
          const active = activeRelease(state);
          if (
            active !== null
              ? active.releaseRevision !== request.applicationReleaseRevision
              : state.registeredReleaseRevision !== null &&
                state.registeredReleaseRevision !== request.applicationReleaseRevision
          )
            throw fail("APPLICATION_INSTALLATION_STALE");
          const releaseBindings = byModuleRoot(
            state.moduleBindings.filter(
              (binding) =>
                binding.applicationReleaseRevision === request.applicationReleaseRevision,
            ),
          );
          // The active set, or a retried drain's already draining set. Only an active release can
          // drain; a detached one is unavailable.
          const drainable =
            active?.bindings ?? releaseBindings.filter((binding) => binding.state === "draining");
          if (drainable.length === 0)
            throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");

          const drained = await drainInstallation(
            transaction,
            newActivityId(),
            request.applicationRootId,
            request.applicationReleaseRevision,
            expectedBindings(drainable),
          );
          if (!sameId(drained.organizationId, state.organizationId))
            throw fail("APPLICATION_INSTALLATION_FAILED");

          return {
            outcome: drained.changed ? "draining" : "unchanged",
            organizationId: state.organizationId,
            applicationRootId: request.applicationRootId,
            applicationReleaseRevision: request.applicationReleaseRevision,
            moduleBindings: drained.moduleBindings,
          } satisfies ApplicationInstallationDrainResult;
        },
      );
    },
  });
};

export type ApplicationInstallationCoordinator<InstalledEvents = never> = ReturnType<
  typeof createApplicationInstallationCoordinator<InstalledEvents>
>;
