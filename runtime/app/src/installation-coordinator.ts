import "server-only";

import { randomUUID } from "node:crypto";
import {
  applicationRootIdSchema,
  identitySessionSchema,
  moduleInstallationBindingEvidenceSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  revisionSchema,
  sessionContextSchema,
  type ApplicationInstallationLifecycleResult,
  type ApplicationRootId,
  type IdentitySession,
  type ModuleInstallationBindingEvidence,
  type ModuleRootId,
  type OrganizationId,
  type PreparedApplicationRoleTemplates,
  type SessionContext,
  type SystemApplicationBoundReleaseSetResult,
} from "@vortex/contracts";
import {
  createApplicationRoleTemplateAdapter,
  type createHumanOrganizationRequestService,
  type PermissionRegistryDefinitionSetReader,
} from "@vortex/access";
import {
  ApplicationInstallationLifecycleError,
  ModuleInstallationStorageError,
  createApplicationInstallationLifecycleRepository,
  createModuleInstallationStorageRepository,
} from "@vortex/module";
import { z } from "zod";

/**
 * The App-owned protected Application lifecycle: install or deliberately upgrade to one exact
 * published release, or withdraw the active one.
 *
 * Publication never reaches this module; an installation changes only when an authenticated
 * installer invokes it. Every write runs in that installer's own human request transaction, so the
 * database derives organisation, actor, correlation and the application-management decision from
 * trusted context. Nothing here accepts identity, authority or readiness from the caller.
 *
 * Activation and upgrade use two transactions because an Access registration change advances the
 * organisation Access version, which the fixed Module lifecycle then requires to be current:
 *
 * 1. Prepare Access: register, update or reactivate the Application permission registration for
 *    the exact target release. Registration assigns nothing to anybody.
 * 2. Switch: detach the previously active release (upgrade only), prepare storage for every pinned
 *    Module release, activate the complete binding set through the fixed operation (which also
 *    gates executable lifecycle policies) and append the lifecycle Activity. Any failure rolls the
 *    whole switch back, so the previously active exact release stays selected.
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

/** Withdraw exactly the named installed release. */
export const applicationInstallationWithdrawalRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: safeRevisionSchema,
  })
  .strict();

export type ApplicationInstallationActivationRequest = z.infer<
  typeof applicationInstallationActivationRequestSchema
>;
export type ApplicationInstallationWithdrawalRequest = z.infer<
  typeof applicationInstallationWithdrawalRequestSchema
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

export type ApplicationInstallationCoordinatorDependencies<InstalledEvents> = Readonly<{
  /** Installer request runner; each call opens one human change transaction. */
  installerRequests: InstallerRequests;
  /**
   * Server-minted live system context and reader for immutable Definition evidence. The target
   * organisation is still proved by the installer's own transaction and the Access coordinator.
   */
  definitionSystemContext: () => SessionContext;
  definitionReader: PermissionRegistryDefinitionSetReader;
  /** Optional installed-event catalogue projector; reported unavailable when not supplied. */
  projectInstalledEvents?: (input: {
    readonly definitions: SystemApplicationBoundReleaseSetResult;
    readonly installation: ActiveApplicationInstallationSummary;
  }) => InstalledEvents;
  activityId?: () => string;
}>;

type BindingRow = Readonly<{ bindings: unknown }>;
type AccessRow = Readonly<{ access_change: unknown }>;

const installationBindingsSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
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

type InstallationBindings = z.infer<typeof installationBindingsSchema>;
type ExpectedModuleBinding = Readonly<{ moduleRootId: ModuleRootId; bindingRevision: number }>;
type ModulePin = Readonly<{ moduleRootId: ModuleRootId; moduleReleaseRevision: number }>;

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

const expectedBindings = (
  bindings: readonly Pick<ModuleInstallationBindingEvidence, "moduleRootId" | "bindingRevision">[],
): ExpectedModuleBinding[] =>
  byModuleRoot(
    bindings.map((binding) => ({
      moduleRootId: canonicalModuleRootId(binding.moduleRootId),
      bindingRevision: binding.bindingRevision,
    })),
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
  const roleTemplates = createApplicationRoleTemplateAdapter({
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
    operation: (transaction: InstallerTransaction) => Promise<Result>,
  ): Promise<Result> => {
    const captured: { failure?: ApplicationInstallationCoordinatorError } = {};
    const outcome = await dependencies.installerRequests
      .runChange(session, { organizationId }, async (transaction) => {
        try {
          return await operation(transaction);
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

  /** Loads the exact Application and its resolved Module pin set, never the latest release. */
  const readExactRelease = async (request: ApplicationInstallationActivationRequest) => {
    const context = sessionContextSchema.safeParse(dependencies.definitionSystemContext());
    if (
      !context.success ||
      context.data.callerKind !== "system" ||
      !sameId(context.data.organizationId, request.organizationId)
    )
      throw fail("APPLICATION_INSTALLATION_REFUSED");
    let releaseSet: SystemApplicationBoundReleaseSetResult;
    let preparedTemplates: PreparedApplicationRoleTemplates;
    try {
      releaseSet = await dependencies.definitionReader.read(context.data, {
        applicationRootId: request.applicationRootId,
        applicationReleaseRevision: request.applicationReleaseRevision,
      });
      preparedTemplates = await roleTemplates.prepareRegistrationCandidate(context.data, {
        applicationRootId: request.applicationRootId,
        releaseRevision: request.applicationReleaseRevision,
      });
    } catch (error) {
      throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE", error);
    }
    const application = releaseSet.application;
    if (
      application.kind !== "application" ||
      !sameId(application.organizationId, request.organizationId) ||
      !sameId(application.rootId, request.applicationRootId) ||
      application.releaseRevision !== request.applicationReleaseRevision ||
      !sameId(preparedTemplates.permissionRegistration.organizationId, request.organizationId) ||
      !sameId(preparedTemplates.permissionRegistration.applicationRootId, request.applicationRootId) ||
      preparedTemplates.permissionRegistration.applicationRelease.releaseRevision !==
        request.applicationReleaseRevision
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
    } catch (error) {
      throw fail("APPLICATION_INSTALLATION_INCOMPLETE", error);
    }
  };

  const unchangedActivation = (
    request: ApplicationInstallationActivationRequest,
    state: InstallationBindings,
    releaseSet: SystemApplicationBoundReleaseSetResult,
  ): ApplicationInstallationActivationResult<InstalledEvents> => {
    const installation: ActiveApplicationInstallationSummary = {
      organizationId: state.organizationId,
      applicationRootId: request.applicationRootId,
      applicationReleaseRevision: request.applicationReleaseRevision,
      moduleBindings: byModuleRoot(
        state.moduleBindings.filter((binding) => binding.state === "active"),
      ),
    };
    return {
      outcome: "unchanged",
      previousApplicationReleaseRevision: request.applicationReleaseRevision,
      installation,
      installedEvents: installedEvents(releaseSet, installation),
    };
  };

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
      const { releaseSet, preparedTemplates, pins } = await readExactRelease(request);

      // 1. Prepare Access for the exact target release. This must commit before the switch: it
      //    advances the Access version that the fixed lifecycle operations pin to.
      const prepared = await inInstallerTransaction(
        verifiedSession.data,
        request.organizationId,
        async (transaction) => {
          const state = await readInstallationBindings(
            transaction,
            request.organizationId,
            request.applicationRootId,
          );
          if (requireExpectedActive(request, activeRelease(state)) === "already_active")
            return unchangedActivation(request, state, releaseSet);
          await changeAccess(
            transaction,
            newActivityId(),
            request.applicationRootId,
            "prepare",
            preparedTemplates,
          );
          return undefined;
        },
      );
      if (prepared !== undefined) return prepared;

      // 2. Switch atomically: detach the prior release, prepare storage, activate, record Activity.
      return inInstallerTransaction(
        verifiedSession.data,
        request.organizationId,
        async (transaction) => {
          const state = await readInstallationBindings(
            transaction,
            request.organizationId,
            request.applicationRootId,
          );
          const active = activeRelease(state);
          if (requireExpectedActive(request, active) === "already_active")
            return unchangedActivation(request, state, releaseSet);

          const lifecycle = createApplicationInstallationLifecycleRepository(transaction);
          const storage = createModuleInstallationStorageRepository(transaction);
          const current = new Map(
            state.moduleBindings.map((binding) => [
              canonicalModuleRootId(binding.moduleRootId),
              binding.bindingRevision,
            ]),
          );

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

          // Storage for every pinned Module release is prepared before activation. Provisioning
          // commits only inactive bindings and is idempotent for an already prepared release.
          const provisioned: ExpectedModuleBinding[] = [];
          for (const pin of pins) {
            const result = await storage.provision({
              applicationRootId: request.applicationRootId,
              applicationReleaseRevision: request.applicationReleaseRevision,
              moduleRootId: pin.moduleRootId,
              moduleReleaseRevision: pin.moduleReleaseRevision,
              expectedBindingRevision: current.get(pin.moduleRootId) ?? null,
            });
            if (
              !sameId(result.moduleRootId, pin.moduleRootId) ||
              result.moduleReleaseRevision !== pin.moduleReleaseRevision ||
              result.applicationReleaseRevision !== request.applicationReleaseRevision
            )
              throw fail("APPLICATION_INSTALLATION_FAILED");
            provisioned.push({
              moduleRootId: pin.moduleRootId,
              bindingRevision: result.bindingRevision,
            });
          }

          const activated = requireLifecycleResult(
            await lifecycle.activate({
              applicationRootId: request.applicationRootId,
              applicationReleaseRevision: request.applicationReleaseRevision,
              expectedModuleBindings: byModuleRoot(provisioned),
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

          const installation = summary(activated);
          return {
            outcome: activated.changed ? "activated" : "unchanged",
            previousApplicationReleaseRevision: active?.releaseRevision ?? null,
            installation,
            installedEvents: installedEvents(releaseSet, installation),
          } satisfies ApplicationInstallationActivationResult<InstalledEvents>;
        },
      );
    },

    /**
     * Withdraws exactly the named release. Bindings are detached, never deleted, so stored
     * records remain; the Access coordinator preserves final-steward and continuity safeguards.
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

      return inInstallerTransaction(
        verifiedSession.data,
        request.organizationId,
        async (transaction) => {
          const state = await readInstallationBindings(
            transaction,
            request.organizationId,
            request.applicationRootId,
          );
          const active = activeRelease(state);
          if (active !== null && active.releaseRevision !== request.applicationReleaseRevision)
            throw fail("APPLICATION_INSTALLATION_STALE");
          // Retrying a completed withdrawal presents the same, now detached, binding set.
          const target =
            active?.bindings ??
            state.moduleBindings.filter(
              (binding) =>
                binding.state === "detached" &&
                binding.applicationReleaseRevision === request.applicationReleaseRevision,
            );
          if (target.length === 0) throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");

          const detached = requireLifecycleResult(
            await createApplicationInstallationLifecycleRepository(transaction).detach({
              applicationRootId: request.applicationRootId,
              applicationReleaseRevision: request.applicationReleaseRevision,
              expectedModuleBindings: expectedBindings(target),
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

          // Last: withdrawing the registration advances the Access version.
          const access = await changeAccess(
            transaction,
            newActivityId(),
            request.applicationRootId,
            "withdraw",
            null,
          );

          return {
            outcome: detached.changed || access.outcome === "changed" ? "withdrawn" : "unchanged",
            organizationId: detached.organizationId,
            applicationRootId: detached.applicationRootId,
            applicationReleaseRevision: detached.applicationReleaseRevision,
            moduleBindings: detached.moduleBindings,
          } satisfies ApplicationInstallationWithdrawalResult;
        },
      );
    },
  });
};

export type ApplicationInstallationCoordinator<InstalledEvents = never> = ReturnType<
  typeof createApplicationInstallationCoordinator<InstalledEvents>
>;
