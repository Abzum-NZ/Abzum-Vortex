import "server-only";

import type { RequestDatabaseTransaction } from "../db/request-transaction";
import { randomUUID } from "node:crypto";
import {
  identitySessionSchema,
  sessionContextSchema,
  type IdentitySession,
  type SelectedOrganizationScope,
  type SessionContext,
} from "../access/identity-access";
import {
  projectLiveApplicationRolePermissions,
  type PreparedApplicationRoleTemplates,
} from "../access/organization-access-catalogue";
import type { ApplicationRootId, ModuleRootId, OrganizationId } from "../catalogue/identifiers";
import { sameId, logRefusal } from "../catalogue/runtime-primitives";
import type { SystemApplicationBoundReleaseSetResult } from "./definition-consumer-read";
import type { ModuleContribution } from "./module-contracts";
import {
  createApplicationRoleTemplateAdapter,
  prepareApplicationRoleTemplatesForHumanRequest,
  verifyPreparedApplicationRoleTemplates,
} from "../access/application-role-template-adapter";
import {
  requireBuilderAuthority,
  type BuilderAuthority,
  type BuilderConferredPermission,
  type BuilderOperation,
} from "./builder-authority";
import {
  activateApplicationInstallation,
  detachApplicationInstallation,
} from "./installation-lifecycle";
import { createInstallationRuntimeBundleCleanupRepository } from "./runtime-bundle-cleanup";
import type { ResolvedContributionBinding } from "./storage-provisioning";
import { canonicalJson } from "./canonical-json-definition";
import {
  assertPreparedInstallationRuntimeBundleMatches,
  writePreparedInstallationRuntimeBundle,
} from "./installation-runtime-bundle-app";
import type { DefinitionError } from "./definition-error";
import {
  type ApplicationInstallationCoordinatorErrorCode,
  applicationInstallationPreparationRequestSchema,
  applicationInstallationActivationRequestSchema,
  applicationInstallationWithdrawalRequestSchema,
  type ApplicationInstallationPreparationRequest,
  type ApplicationInstallationActivationRequest,
  type ApplicationInstallationWithdrawalRequest,
  type OptionalInstallationReader,
  type ActiveApplicationInstallationSummary,
  type ApplicationInstallationPreparationResult,
  type ApplicationInstallationActivationResult,
  type ApplicationInstallationWithdrawalResult,
  type ApplicationInstallationCoordinatorDependencies,
} from "./installation-coordinator-contracts";
import {
  type InstallationBindings,
  type ContributionGroup,
  type ExactStorageRelease,
  type ExactRelease,
  type ReleaseTarget,
  canonicalModuleRootId,
  byModuleRoot,
  fail,
  isCoordinatorError,
  toCoordinatorError,
  readInstallationBindings,
  activeRelease,
  expectedBindings,
  currentBindingRevisions,
  changeAccess,
  recordOutcome,
  provisionPins,
  summary,
  requireExactBindings,
  sameUniqueEvidence,
  releaseEvidenceKey,
  samePermissionAuthority,
  changeContributions,
  requireLifecycleResult,
} from "./installation-coordinator-state";

/**
 * The App-owned protected Application lifecycle: prepare, install or deliberately upgrade to one
 * exact published release, or withdraw it.
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
 * Registration and the binding switch share one exclusive Access-change transaction:
 *
 * 1. Align Access: register, update or reactivate the permission registration for the exact target
 *    release when it does not already name it. Registration assigns nothing to anybody.
 * 2. Switch: detach the previously active release and its contributions (upgrade only), prepare
 *    every pinned Module's storage and attach the new contributions, then activate the complete
 *    binding set through the fixed operation (which also gives every record type its lifecycle
 *    policy and gates executable lifecycle policies) and append the lifecycle Activity. Any failure
 *    rolls registration, roles, storage, bindings, runtime bundle and Activity back together, so
 *    the previously active exact release and its permission registration stay selected.
 *
 * The protected Access writer advances only its own established context to its resulting version;
 * subsequent decisions recheck current authority at that version inside the same transaction.
 * A first installation is prepared before it is activated: `prepare` commits the registration,
 * provisioned inactive storage and the complete runtime bundle. An upgrade cannot pre-provision a
 * Module its active release still binds, so its storage is prepared inside the atomic switch.
 *
 * Withdrawal is one transaction: detach the active or prepared binding set and retire its contributions
 * (storage and records are retained), append its Activity, then withdraw the permission registration,
 * which refuses a change that would leave the organisation without a permanent steward.
 */

export const createApplicationInstallationCoordinator = <InstalledEvents = never>(
  dependencies: ApplicationInstallationCoordinatorDependencies<InstalledEvents>,
) => {
  const newActivityId = dependencies.activityId ?? randomUUID;
  const humanDefinitionAccess = dependencies.humanDefinitionAccess;
  const roleTemplates =
    humanDefinitionAccess !== undefined || dependencies.definitionReader === undefined
      ? undefined
      : createApplicationRoleTemplateAdapter({ definitionReader: dependencies.definitionReader });

  /**
   * Only registration changes hold Access exclusively. Storage and runtime reads hold it shared.
   * The request runner reports only a coarse outcome, so
   * the typed failure is captured before the transaction rolls back.
   */
  const inInstallerTransaction = async <Result>(
    mode: "runAccessChange" | "runChange",
    session: IdentitySession,
    organizationId: OrganizationId,
    builderOperation: BuilderOperation,
    operation: (
      transaction: RequestDatabaseTransaction,
      authority: BuilderAuthority,
      scope: SelectedOrganizationScope,
    ) => Promise<Result>,
  ): Promise<Result> => {
    const captured: { failure?: DefinitionError<ApplicationInstallationCoordinatorErrorCode> } = {};
    const outcome = await dependencies.installerRequests[mode](
      session,
      { organizationId },
      async (transaction, scope) => {
        try {
          // The builder authority is decided first, from the installer's own request scope, before
          // anything is read or written in this transaction.
          const authority = dependencies.builderAuthority(transaction, scope);
          if (!sameId(authority.organizationId, organizationId))
            throw fail("APPLICATION_INSTALLATION_REFUSED");
          await requireBuilderAuthority(authority, builderOperation);
          return await operation(transaction, authority, scope);
        } catch (error) {
          captured.failure = toCoordinatorError(error);
          throw error;
        }
      },
    ).catch((error: unknown) => {
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
          [
            permission.applicationRootId,
            permission.ownerKind,
            permission.ownerId,
            permission.permissionId,
          ]
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
    purpose: "consume" | "replace_or_remove",
  ): Promise<SystemApplicationBoundReleaseSetResult> => {
    if (humanDefinitionAccess !== undefined) {
      try {
        return await humanDefinitionAccess.readReleaseSet(session, target, purpose);
      } catch (error) {
        throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE", error);
      }
    }
    const context = definitionContext(target);
    if (dependencies.definitionReader === undefined)
      throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
    try {
      return await dependencies.definitionReader.read(
        context,
        {
          applicationRootId: target.applicationRootId,
          applicationReleaseRevision: target.applicationReleaseRevision,
        },
        purpose,
      );
    } catch (error) {
      throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE", error);
    }
  };

  /** Resolve the whole set before mutations; partial resolution is never an empty fallback. */
  const resolveStorageRelease = (
    target: ReleaseTarget,
    candidate: SystemApplicationBoundReleaseSetResult,
  ): ExactStorageRelease => {
    // Every reader returns a release set already parsed against its result schema.
    const releaseSet = candidate;
    const application = releaseSet.application;
    if (
      !sameId(application.organizationId, target.organizationId) ||
      !sameId(application.rootId, target.applicationRootId) ||
      application.releaseRevision !== target.applicationReleaseRevision
    )
      throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
    if (releaseSet.modules.length === 0) throw fail("APPLICATION_INSTALLATION_INCOMPLETE");
    const modules = new Map(
      releaseSet.modules.map((module) => [canonicalModuleRootId(module.rootId), module]),
    );
    if (modules.size !== releaseSet.modules.length)
      throw fail("APPLICATION_INSTALLATION_INCOMPLETE");
    const declared = new Map<
      string,
      { moduleRootId: ModuleRootId; contribution: ModuleContribution }
    >();
    for (const module of releaseSet.modules) {
      for (const contribution of module.content.contributions ?? []) {
        const id = contribution.contributionId.toLowerCase();
        if (declared.has(id)) throw fail("APPLICATION_INSTALLATION_STORAGE_INCOMPATIBLE");
        declared.set(id, {
          moduleRootId: canonicalModuleRootId(module.rootId),
          contribution,
        });
      }
    }
    let resolution: ReturnType<
      ApplicationInstallationCoordinatorDependencies<InstalledEvents>["resolveModuleContributions"]
    >;
    try {
      resolution = dependencies.resolveModuleContributions(
        releaseSet.modules.map((module) => ({
          moduleRootId: module.rootId,
          definitionKey: module.definitionKey,
          releaseVersion: module.releaseVersion,
          content: module.content,
        })),
      );
    } catch (error) {
      throw fail("APPLICATION_INSTALLATION_STORAGE_INCOMPATIBLE", error);
    }
    if (
      resolution.outcome !== "resolved" ||
      resolution.conflicts.length !== 0 ||
      resolution.bindings.length !== declared.size
    )
      throw fail("APPLICATION_INSTALLATION_STORAGE_INCOMPATIBLE");
    const seen = new Set<string>();
    const groups = new Map<ModuleRootId, ResolvedContributionBinding[]>();
    for (const binding of resolution.bindings) {
      const id = binding.contributionId.toLowerCase();
      const source = declared.get(id);
      const contributorRoot = canonicalModuleRootId(binding.contributorModuleRootId);
      const contributor = modules.get(contributorRoot);
      const targetModule = modules.get(canonicalModuleRootId(binding.targetModuleRootId));
      const point = targetModule?.content.extensionPoints.find((candidate) =>
        sameId(candidate.extensionPointId, binding.targetExtensionPointId),
      );
      if (
        seen.has(id) ||
        source === undefined ||
        source.moduleRootId !== contributorRoot ||
        source.contribution.kind !== binding.kind ||
        contributor === undefined ||
        targetModule === undefined ||
        sameId(contributor.rootId, targetModule.rootId) ||
        contributor.releaseVersion !== binding.contributorReleaseVersion ||
        targetModule.releaseVersion !== binding.targetModuleReleaseVersion ||
        !sameId(source.contribution.targetModule.moduleRootId, targetModule.rootId) ||
        source.contribution.targetModule.moduleKey !== targetModule.definitionKey ||
        source.contribution.targetModule.resolvedVersion !== targetModule.releaseVersion ||
        !sameId(source.contribution.targetExtensionPointId, binding.targetExtensionPointId) ||
        point === undefined ||
        !sameId(point.recordTypeId, binding.targetRecordTypeId) ||
        source.contribution.recordTypeId !== binding.recordTypeId ||
        source.contribution.fieldId !== binding.fieldId ||
        source.contribution.actionId !== binding.actionId
      )
        throw fail("APPLICATION_INSTALLATION_STORAGE_INCOMPATIBLE");
      seen.add(id);
      const group = groups.get(contributorRoot) ?? [];
      group.push(binding);
      groups.set(contributorRoot, group);
    }
    const contributionGroups: ContributionGroup[] = [];
    for (const [moduleRootId, contributions] of groups) {
      const module = modules.get(moduleRootId);
      if (module === undefined || contributions.length === 0 || contributions.length > 100)
        throw fail("APPLICATION_INSTALLATION_STORAGE_INCOMPATIBLE");
      contributionGroups.push({
        moduleRootId,
        moduleReleaseRevision: module.releaseRevision,
        contributions: [...contributions].sort((a, b) => {
          const left = a.contributionId.toLowerCase();
          const right = b.contributionId.toLowerCase();
          return left < right ? -1 : left > right ? 1 : 0;
        }),
      });
    }
    return {
      releaseSet,
      pins: byModuleRoot(
        releaseSet.modules.map((module) => ({
          moduleRootId: canonicalModuleRootId(module.rootId),
          moduleReleaseRevision: module.releaseRevision,
        })),
      ),
      contributionGroups: byModuleRoot(contributionGroups),
    };
  };

  const exactStorageRelease = (
    target: ReleaseTarget,
    releaseSet: SystemApplicationBoundReleaseSetResult,
  ): ExactStorageRelease => {
    try {
      return resolveStorageRelease(target, releaseSet);
    } catch (error) {
      if (isCoordinatorError(error)) throw error;
      throw fail("APPLICATION_INSTALLATION_STORAGE_INCOMPATIBLE", error);
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
        releaseSet = await humanDefinitionAccess.readReleaseSet(session, target, "consume");
        preparedTemplates = await humanDefinitionAccess.prepareRegistrationCandidate(
          target,
          releaseSet,
        );
      } else if (roleTemplates !== undefined) {
        const context = definitionContext(target);
        releaseSet = await dependencies.definitionReader!.read(
          context,
          {
            applicationRootId: target.applicationRootId,
            applicationReleaseRevision: target.applicationReleaseRevision,
          },
          "consume",
        );
        preparedTemplates = await roleTemplates.prepareRegistrationCandidate(context, {
          applicationRootId: target.applicationRootId,
          releaseRevision: target.applicationReleaseRevision,
        });
      } else {
        throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
      }
    } catch (error) {
      if (isCoordinatorError(error)) throw error;
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
    return { ...exactStorageRelease(target, releaseSet), preparedTemplates };
  };

  /**
   * Re-derive the full candidate from its own release, rather than trusting self-consistent
   * fingerprints or a candidate prepared from a different release with the same authority.
   */
  const verifiedOwnReleaseTemplates = (exact: ExactRelease): PreparedApplicationRoleTemplates => {
    const application = exact.releaseSet.application;
    const prepared = verifyPreparedApplicationRoleTemplates(exact.preparedTemplates);
    const own = prepareApplicationRoleTemplatesForHumanRequest(
      application.organizationId,
      {
        applicationRootId: application.rootId,
        releaseRevision: application.releaseRevision,
      },
      exact.releaseSet,
    );
    if (
      prepared.preparationBasis.kind !== "registration_candidate" ||
      canonicalJson(prepared) !== canonicalJson(own)
    )
      throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
    return prepared;
  };

  /**
   * Proves only an ordinary active upgrade with unchanged complete authority and exact Modules.
   * The caller has already checked the expected active release under the installation lock.
   * Missing evidence or any difference retains the normal template-acceptance decision.
   */
  const preservesRegisteredAuthority = (
    request: ApplicationInstallationActivationRequest,
    state: InstallationBindings,
    prior: ExactRelease | null,
    target: ExactRelease,
  ): boolean => {
    if (
      prior === null ||
      request.expectedActiveReleaseRevision === null ||
      request.expectedActiveReleaseRevision >= request.applicationReleaseRevision ||
      state.registeredReleaseRevision !== request.expectedActiveReleaseRevision ||
      state.moduleBindings.some(
        (binding) => binding.state !== "active" && binding.state !== "detached",
      )
    )
      return false;
    // Invalid target evidence remains a refusal; only unavailable prior comparison evidence may
    // fall back to the normal acceptance branch. Each full fingerprint binds its own release.
    let newTemplates: PreparedApplicationRoleTemplates;
    try {
      newTemplates = verifiedOwnReleaseTemplates(target);
    } catch (error) {
      throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE", error);
    }
    try {
      const active = activeRelease(state);
      if (active?.releaseRevision !== request.expectedActiveReleaseRevision) return false;
      requireExactBindings(
        {
          ...request,
          applicationReleaseRevision: request.expectedActiveReleaseRevision,
        },
        prior.pins,
        active.bindings,
        "active",
      );
      const oldApplication = prior.releaseSet.application;
      const newApplication = target.releaseSet.application;
      if (
        !sameId(oldApplication.organizationId, request.organizationId) ||
        !sameId(newApplication.organizationId, request.organizationId) ||
        !sameId(oldApplication.rootId, request.applicationRootId) ||
        !sameId(newApplication.rootId, request.applicationRootId) ||
        oldApplication.releaseRevision !== request.expectedActiveReleaseRevision ||
        newApplication.releaseRevision !== request.applicationReleaseRevision ||
        oldApplication.definitionKey !== newApplication.definitionKey ||
        oldApplication.validationContractVersion !== newApplication.validationContractVersion ||
        [...prior.releaseSet.modules, ...target.releaseSet.modules].some(
          (module) => !sameId(module.organizationId, request.organizationId),
        ) ||
        !sameUniqueEvidence(
          prior.releaseSet.modules,
          target.releaseSet.modules,
          (module) => module.rootId,
          releaseEvidenceKey,
        ) ||
        dependencies.containsCustomComponents(prior.releaseSet) !== false ||
        dependencies.containsCustomComponents(target.releaseSet) !== false
      )
        return false;

      // Application revision/version/content/resolution are verified separately before their
      // necessarily changing values can be excluded from cross-release authority comparison.
      const oldTemplates = verifiedOwnReleaseTemplates(prior);
      const oldRegistration = oldTemplates.permissionRegistration;
      const newRegistration = newTemplates.permissionRegistration;
      return (
        oldRegistration.applicationCatalogueFingerprint ===
          newRegistration.applicationCatalogueFingerprint &&
        sameUniqueEvidence(
          oldRegistration.applicationPermissionIds,
          newRegistration.applicationPermissionIds,
          (id) => id,
          (id) => id,
        ) &&
        samePermissionAuthority(oldRegistration.entries, newRegistration.entries) &&
        sameUniqueEvidence(
          oldTemplates.templates,
          newTemplates.templates,
          (prepared) => prepared.template.roleId,
          (prepared) => canonicalJson(prepared.template),
        ) &&
        oldTemplates.templates.every((prepared) => {
          const next = newTemplates.templates.find((candidate) =>
            sameId(candidate.template.roleId, prepared.template.roleId),
          );
          return (
            next !== undefined &&
            samePermissionAuthority(prepared.sourcePermissions, next.sourcePermissions) &&
            samePermissionAuthority(prepared.livePermissions, next.livePermissions)
          );
        })
      );
    } catch (error) {
      // Falls back to the normal template-acceptance decision, never to a silent upgrade.
      logRefusal(
        "installation",
        `authority preservation check (application ${request.applicationRootId})`,
        "prior_release_evidence_unavailable",
        error,
      );
      return false;
    }
  };

  /**
   * Points the permission registration at exactly this release when it names another one or none.
   * Returns the protected change's version for subsequent builder decisions; an already aligned
   * registration costs no Access-version advance.
   */
  const alignAccess = async (
    transaction: RequestDatabaseTransaction,
    authority: BuilderAuthority,
    state: InstallationBindings,
    applicationRootId: ApplicationRootId,
    applicationReleaseRevision: number,
    exact: ExactRelease,
    acceptance: "accept_role_templates" | "preserve_registered_authority",
  ): Promise<Awaited<ReturnType<typeof changeAccess>> | null> => {
    if (state.registeredReleaseRevision === applicationReleaseRevision) return null;
    // Without a proof of unchanged authority, registration follows the role-template acceptance
    // check: recent authentication and every conferred permission inside the installer's delegated
    // assignment scope, whatever any approval workflow says. It is decided in the same
    // transaction and before registration: a permission the current registration does not yet
    // hold lies outside every bounded delegated scope. A proved active upgrade with identical
    // authority only advances registration and grants nothing new. The complete target evidence
    // still goes to the normal SQL
    // continuity/narrowing writer, without changing any acceptance or assignment evidence.
    if (acceptance === "accept_role_templates")
      await requireBuilderAuthority(authority, installOperation(applicationRootId, exact, true));
    return changeAccess(
      transaction,
      newActivityId(),
      applicationRootId,
      "prepare",
      exact.preparedTemplates,
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
    } catch (error) {
      logRefusal(
        "installation",
        `installed events projection (application ${installation.applicationRootId})`,
        "installed_events_projection_failed",
        error,
      );
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
     * Prepares one exact release for first installation: aligns the permission registration,
     * commits provisioned inactive storage for every pinned Module release, and stores the complete
     * immutable runtime bundle. Nothing becomes active, and an installation with an active release
     * is refused as stale.
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
      const preparedRuntimeSource = dependencies.preparedRuntimeSource;
      if (preparedRuntimeSource === undefined) throw fail("APPLICATION_INSTALLATION_FAILED");
      const exact = await readExactRelease(verifiedSession.data, request);
      const { pins } = exact;

      // 1. Access must name the release before its provisioned setup can be administered.
      const accessChanged = await inInstallerTransaction(
        "runAccessChange",
        verifiedSession.data,
        request.organizationId,
        installOperation(request.applicationRootId, exact, false),
        async (transaction, authority) => {
          const state = await readInstallationBindings(
            transaction,
            request.organizationId,
            request.applicationRootId,
          );
          if (activeRelease(state) !== null) throw fail("APPLICATION_INSTALLATION_STALE");
          const access = await alignAccess(
            transaction,
            authority,
            state,
            request.applicationRootId,
            request.applicationReleaseRevision,
            exact,
            "accept_role_templates",
          );
          return access?.outcome === "changed";
        },
      );

      // 2. Commit inactive storage for the complete pin set.
      return inInstallerTransaction(
        "runChange",
        verifiedSession.data,
        request.organizationId,
        installOperation(request.applicationRootId, exact, false),
        async (transaction, authority) => {
          const state = await readInstallationBindings(
            transaction,
            request.organizationId,
            request.applicationRootId,
          );
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
          const contributionsChanged = await changeContributions(
            transaction,
            request,
            exact.contributionGroups,
            provisioned,
            "attach",
          );
          const preparedBindings = provisioned.map((result) => ({
            moduleRootId: result.moduleRootId,
            moduleReleaseRevision: result.moduleReleaseRevision,
            bindingRevision: result.bindingRevision,
            state: "provisioned" as const,
          }));
          const preparedSource = await preparedRuntimeSource(transaction, {
            organizationId: request.organizationId,
            applicationRootId: request.applicationRootId,
            applicationReleaseRevision: request.applicationReleaseRevision,
            moduleBindings: preparedBindings,
          });
          const runtimeBundleIndex = await writePreparedInstallationRuntimeBundle(
            transaction,
            preparedSource,
          );
          await requireBuilderAuthority(
            authority,
            installOperation(request.applicationRootId, exact, false),
          );
          return {
            runtimeBundleIndex,
            outcome:
              accessChanged || contributionsChanged || provisioned.some((result) => result.changed)
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
      const preparedRuntimeSource = dependencies.preparedRuntimeSource;
      const exact = await readExactRelease(verifiedSession.data, request);
      const { releaseSet, pins } = exact;
      // Optional evidence for the equality-only registration decision. Failure never turns the
      // prior release into an empty catalogue or suppresses the normal target authority check.
      const prior =
        request.expectedActiveReleaseRevision === null ||
        request.expectedActiveReleaseRevision >= request.applicationReleaseRevision
          ? null
          : await readExactRelease(verifiedSession.data, {
              organizationId: request.organizationId,
              applicationRootId: request.applicationRootId,
              applicationReleaseRevision: request.expectedActiveReleaseRevision,
            }).catch((error: unknown) => {
              logRefusal("installation", "prior release read", "prior_release_unreadable", error);
              return null;
            });

      // Resolve the old storage set before any write. Registration and every part of the switch
      // then share the exclusive organisation Access lock and the same commit or rollback.
      const oldTarget =
        request.expectedActiveReleaseRevision === null
          ? null
          : {
              organizationId: request.organizationId,
              applicationRootId: request.applicationRootId,
              applicationReleaseRevision: request.expectedActiveReleaseRevision,
            };
      const oldExact =
        oldTarget === null
          ? null
          : exactStorageRelease(
              oldTarget,
              await readReleaseSet(verifiedSession.data, oldTarget, "replace_or_remove"),
            );
      const switched = await inInstallerTransaction(
        "runAccessChange",
        verifiedSession.data,
        request.organizationId,
        installOperation(request.applicationRootId, exact, false),
        async (transaction, authority, scope) => {
          const state = await readInstallationBindings(
            transaction,
            request.organizationId,
            request.applicationRootId,
          );
          const active = activeRelease(state);
          const mode = requireExpectedActive(request, active);
          if (mode === "switch" && preparedRuntimeSource === undefined)
            throw fail("APPLICATION_INSTALLATION_FAILED");
          if (mode === "already_active")
            requireExactBindings(
              request,
              pins,
              activeSummary(request, state).moduleBindings,
              "active",
            );
          const access = await alignAccess(
            transaction,
            authority,
            state,
            request.applicationRootId,
            request.applicationReleaseRevision,
            exact,
            mode === "switch" && preservesRegisteredAuthority(request, state, prior, exact)
              ? "preserve_registered_authority"
              : "accept_role_templates",
          );
          const currentAuthority =
            access === null
              ? authority
              : dependencies.builderAuthority(transaction, {
                  ...scope,
                  accessVersion: access.accessVersion,
                });
          if (mode === "already_active") {
            const installation = activeSummary(request, state);
            requireExactBindings(request, pins, installation.moduleBindings, "active");
            await changeContributions(
              transaction,
              request,
              exact.contributionGroups,
              installation.moduleBindings,
              "attach",
            );
            await requireBuilderAuthority(
              currentAuthority,
              installOperation(request.applicationRootId, exact, false),
            );
            return {
              outcome: "unchanged" as const,
              previousApplicationReleaseRevision: request.applicationReleaseRevision,
              installation,
            };
          }

          const current = currentBindingRevisions(state);
          if (active !== null) {
            if (
              oldTarget === null ||
              oldExact === null ||
              active.releaseRevision !== oldTarget.applicationReleaseRevision
            )
              throw fail("APPLICATION_INSTALLATION_STALE");
            requireExactBindings(oldTarget, oldExact.pins, active.bindings, "active");
            const detached = requireLifecycleResult(
              await detachApplicationInstallation(transaction, {
                applicationRootId: request.applicationRootId,
                applicationReleaseRevision: active.releaseRevision,
                expectedModuleBindings: expectedBindings(active.bindings),
              }),
              request.organizationId,
              request.applicationRootId,
              active.releaseRevision,
              "detached",
            );
            requireExactBindings(oldTarget, oldExact.pins, detached.moduleBindings, "detached");
            await changeContributions(
              transaction,
              oldTarget,
              oldExact.contributionGroups,
              detached.moduleBindings,
              "detach",
            );
            for (const binding of detached.moduleBindings)
              current.set(canonicalModuleRootId(binding.moduleRootId), binding.bindingRevision);
          }

          const provisioned = await provisionPins(transaction, request, pins, current);
          await changeContributions(
            transaction,
            request,
            exact.contributionGroups,
            provisioned,
            "attach",
          );
          if (preparedRuntimeSource === undefined) throw fail("APPLICATION_INSTALLATION_FAILED");
          const preparedBindings = provisioned.map((result) => ({
            moduleRootId: result.moduleRootId,
            moduleReleaseRevision: result.moduleReleaseRevision,
            bindingRevision: result.bindingRevision,
            state: "provisioned" as const,
          }));
          const preparedSource = await preparedRuntimeSource(transaction, {
            organizationId: request.organizationId,
            applicationRootId: request.applicationRootId,
            applicationReleaseRevision: request.applicationReleaseRevision,
            moduleBindings: preparedBindings,
          });
          // A first installation was prepared earlier, so its bundle is only checked. An upgrade
          // has no preparation step: its bundle is written here, inside the switch, so a failed
          // switch keeps the previous release and a committed one always has its bundle.
          if (active === null && request.expectedActiveReleaseRevision === null)
            await assertPreparedInstallationRuntimeBundleMatches(
              transaction,
              preparedSource,
              preparedBindings,
            );
          else await writePreparedInstallationRuntimeBundle(transaction, preparedSource);
          await requireBuilderAuthority(
            currentAuthority,
            installOperation(request.applicationRootId, exact, false),
          );
          const activated = requireLifecycleResult(
            await activateApplicationInstallation(transaction, {
              applicationRootId: request.applicationRootId,
              applicationReleaseRevision: request.applicationReleaseRevision,
              expectedModuleBindings: expectedBindings(provisioned),
            }),
            request.organizationId,
            request.applicationRootId,
            request.applicationReleaseRevision,
            "active",
          );
          requireExactBindings(request, pins, activated.moduleBindings, "active");
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
      return { ...switched, installedEvents: installedEvents(releaseSet, switched.installation) };
    },

    /**
     * Withdraws exactly the named release. Bindings are detached, never deleted, so stored
     * records remain; prepared bindings also become detached without becoming active. The
     * Access coordinator preserves final-steward, supplier and continuity safeguards.
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
      const packageFacts = await readReleaseSet(verifiedSession.data, request, "replace_or_remove");
      const exact = exactStorageRelease(request, packageFacts);

      return inInstallerTransaction(
        "runAccessChange",
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
          if (
            state.moduleBindings.some(
              (binding) =>
                binding.state !== "detached" &&
                binding.applicationReleaseRevision !== request.applicationReleaseRevision,
            )
          )
            throw fail("APPLICATION_INSTALLATION_STALE");
          if (releaseBindings.length === 0 && state.registeredReleaseRevision === null)
            throw fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
          const bindingState = releaseBindings[0]?.state;
          if (
            bindingState !== "active" &&
            bindingState !== "detached" &&
            bindingState !== "provisioned"
          )
            throw fail("APPLICATION_INSTALLATION_STALE");
          requireExactBindings(request, exact.pins, releaseBindings, bindingState);
          // Terminate the complete homogeneous active/provisioned set, or replay a detached set.
          // Retained storage is not evidence that a withdrawn prepared installation is still live.
          const detached = requireLifecycleResult(
            await detachApplicationInstallation(transaction, {
              applicationRootId: request.applicationRootId,
              applicationReleaseRevision: request.applicationReleaseRevision,
              expectedModuleBindings: expectedBindings(releaseBindings),
            }),
            request.organizationId,
            request.applicationRootId,
            request.applicationReleaseRevision,
            "detached",
          );
          requireExactBindings(request, exact.pins, detached.moduleBindings, "detached");
          if (detached.changed)
            await recordOutcome(
              transaction,
              newActivityId(),
              request.applicationRootId,
              request.applicationReleaseRevision,
              "detached",
            );

          // Every group uses the protected terminal transition's returned revisions.
          const contributionsChanged = await changeContributions(
            transaction,
            request,
            exact.contributionGroups,
            detached.moduleBindings,
            "detach",
          );

          // Bundle registrations belong to Module and are removed only after this installation's
          // bindings have left active service. The report keeps the exact bundle keys and counts.
          const runtimeBundles = await createInstallationRuntimeBundleCleanupRepository(
            transaction,
          ).removeInstallation(request.applicationRootId);

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
              detached.changed || contributionsChanged || access.outcome === "changed"
                ? "withdrawn"
                : "unchanged",
            organizationId: state.organizationId,
            applicationRootId: request.applicationRootId,
            applicationReleaseRevision: request.applicationReleaseRevision,
            moduleBindings: detached.moduleBindings,
            runtimeBundles,
          } satisfies ApplicationInstallationWithdrawalResult;
        },
      );
    },
  });
};
