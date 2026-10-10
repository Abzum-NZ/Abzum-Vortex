import "server-only";

import { createHash } from "node:crypto";
import {
  createBuilderAuthority,
  prepareApplicationRoleTemplatesForHumanRequest,
  requireBuilderAuthority,
  runOrganizationAccessOperation,
  type BuilderOperation,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import {
  ApplicationInstallationCoordinatorError,
  createApplicationInstallationCoordinator,
  type ApplicationInstallationActivationResult,
  type HumanInstallationDefinitionAccess,
} from "@vortex/app";
import {
  canonicalJson,
  databaseTimestamp,
  moduleInstallationBindingEvidenceSchema,
  organizationAccessDeclarationSchema,
  organizationIdSchema,
  organizationPermissionEligibilitySchema,
  sameId,
  sessionContextSchema,
  systemApplicationBoundReleaseSetResultSchema,
  timestampSchema,
  type ActiveApplicationInstallationEvidence,
  type IdentitySession,
  type ModuleInstallationBindingEvidence,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
  type SessionContext,
  type SystemApplicationBoundReleaseSetResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  DefinitionConsumerReadError,
  createDatabaseApplicationReleaseAdoptionReleaseSetService,
  resolveModuleContributions,
} from "@vortex/definition";
import { createActiveApplicationInstallationRepository } from "@vortex/module";
import { platformPermissionDeclarations, platformPermissionOwnerId } from "@vortex/modules";
import { z } from "zod";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { installedReleaseCatalogue, releaseSetContainsCustomComponents } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import {
  studioApplicationInstallationCommandResultSchema,
  studioApplicationInstallationCommandSchema,
  studioApplicationInstallationLoadResultSchema,
  studioApplicationInstallationReleaseIdentitySchema,
  studioApplicationInstallationSelectorSchema,
  studioApplicationInstallationSnapshotSchema,
  type StudioApplicationInstallationCommandResult,
  type StudioApplicationInstallationReleaseIdentity,
  type StudioApplicationInstallationSelector,
  type StudioApplicationInstallationSnapshot,
} from "./studio-application-installation-contracts";

type HumanContext = Extract<SessionContext, { callerKind: "human" }>;
type ReleaseIdentityInput = Readonly<{
  releaseRevision: number;
  releaseVersion: string;
  validationContractVersion: string;
  contentFingerprint: string;
  resolutionFingerprint: string;
}>;

const installationBindingsSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: studioApplicationInstallationSelectorSchema.shape.rootId,
    registeredReleaseRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    moduleBindings: z.array(moduleInstallationBindingEvidenceSchema).max(10_000),
  })
  .strict();

type InstallationBindings = z.infer<typeof installationBindingsSchema>;
type ReadState = Readonly<{
  active: ActiveApplicationInstallationEvidence;
  activeReleaseSet: SystemApplicationBoundReleaseSetResult;
  selectedReleaseSet: SystemApplicationBoundReleaseSetResult;
  bindings: InstallationBindings;
}>;
type AuthorizedState = Readonly<{
  snapshot: StudioApplicationInstallationSnapshot;
  state: ReadState;
  checkedAt: string;
}>;

type Problem = Readonly<{
  kind: "conflict" | "refused" | "authentication_required" | "temporarily_unavailable" | "failed";
  unavailableReason?: "not_installed" | "not_newer" | "module_set_changed" |
    "installation_incomplete" | "registration_misaligned" | "unsupported_root";
}>;

class InstallationProblem extends Error {
  constructor(readonly problem: Problem) {
    super(problem.kind);
    this.name = "InstallationProblem";
  }
}

const problem = (kind: Problem["kind"], unavailableReason?: Problem["unavailableReason"]): never => {
  throw new InstallationProblem({ kind, ...(unavailableReason === undefined ? {} : { unavailableReason }) });
};

const safeFailure = (error: unknown): Problem => {
  if (error instanceof InstallationProblem) return error.problem;
  if (error instanceof ApplicationInstallationCoordinatorError) {
    switch (error.code) {
      case "APPLICATION_INSTALLATION_STALE":
        return { kind: "conflict" };
      case "APPLICATION_INSTALLATION_PERMISSION_REFUSED":
      case "APPLICATION_INSTALLATION_REFUSED":
        return { kind: "refused" };
      case "APPLICATION_INSTALLATION_RECENT_AUTHENTICATION_REQUIRED":
        return { kind: "authentication_required" };
      case "APPLICATION_INSTALLATION_TEMPORARILY_UNAVAILABLE":
        return { kind: "temporarily_unavailable" };
      default:
        return { kind: "failed" };
    }
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { readonly code?: unknown }).code);
    if (code === "42501") return { kind: "refused" };
    if (code === "40001" || code === "23514" || code === "55000")
      return { kind: "conflict" };
  }
  return { kind: "temporarily_unavailable" };
};

const unavailable = (reason: NonNullable<Problem["unavailableReason"]>) =>
  studioApplicationInstallationLoadResultSchema.parse({ kind: "unavailable", reason });

const toLoadFailure = (failure: Problem) => {
  if (failure.unavailableReason !== undefined) return unavailable(failure.unavailableReason);
  if (failure.kind === "refused" || failure.kind === "authentication_required")
    return studioApplicationInstallationLoadResultSchema.parse({ kind: "refused" });
  return studioApplicationInstallationLoadResultSchema.parse({ kind: "temporarily_unavailable" });
};

const toCommandFailure = (
  failure: Problem,
  registrationMayHaveChanged: boolean | "unknown",
): StudioApplicationInstallationCommandResult =>
  studioApplicationInstallationCommandResultSchema.parse({
    kind: failure.kind,
    registrationMayHaveChanged,
  });

const exactSession = async (): Promise<IdentitySession | undefined> => {
  const resolved = await resolveIdentitySession();
  if (resolved.kind === "temporarily_unavailable") problem("temporarily_unavailable");
  return resolved.kind === "active" ? resolved.session : undefined;
};

const sameUuid = (left: string, right: string): boolean => sameId(left, right);

const databaseNow = async (transaction: RequestDatabaseTransaction): Promise<string> => {
  const rows = await transaction.query<DatabaseRow>`
    select pg_catalog.clock_timestamp() as checked_at
  `;
  const parsed = timestampSchema.safeParse(databaseTimestamp(rows[0]?.checked_at));
  if (rows.length !== 1 || !parsed.success) problem("temporarily_unavailable");
  return parsed.data;
};

const readHumanContext = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  expected: Readonly<{ organizationId: string; applicationRootId?: string }>,
): Promise<HumanContext> => {
  const rows = await transaction.query<DatabaseRow>`
    select vortex_access.validated_human_request_context() as request_context,
      pg_catalog.clock_timestamp() as checked_at
  `;
  const row = rows[0];
  const transport = z.record(z.string(), z.unknown()).safeParse(row?.request_context);
  if (rows.length !== 1 || !transport.success) problem("refused");
  // The trusted server composition fixes this request service to its default `web` channel.
  // validated_human_request_context() returns identity/scope context, not that channel.
  const parsed = sessionContextSchema.safeParse(transport.data);
  const clock = timestampSchema.safeParse(databaseTimestamp(row?.checked_at));
  if (!parsed.success || parsed.data.callerKind !== "human" || !clock.success) problem("refused");
  const context = parsed.data;
  const now = Date.parse(clock.data);
  const appScopeMatches = expected.applicationRootId === undefined
    ? scope.applicationRootId === undefined && context.applicationRootId === undefined
    : scope.applicationRootId !== undefined && context.applicationRootId !== undefined &&
      sameUuid(scope.applicationRootId, expected.applicationRootId) &&
      sameUuid(context.applicationRootId, expected.applicationRootId);
  if (!appScopeMatches ||
    !sameUuid(scope.organizationId, expected.organizationId) ||
    !sameUuid(context.tenantId, scope.tenantId) ||
    !sameUuid(context.organizationId, scope.organizationId) ||
    !sameUuid(context.organizationAccountId, scope.organizationAccountId) ||
    context.accessVersion !== scope.accessVersion ||
    !sameUuid(context.identityId, session.identityId) ||
    !sameUuid(context.sessionId, session.sessionId) ||
    context.authenticationStrength !== session.authenticationStrength ||
    context.issuedAt !== issuedAt || context.expiresAt !== session.accessTokenExpiresAt ||
    context.accessTokenIssuedAt !== (session.primaryAuthenticatedAt !== undefined ||
      session.multiFactorAuthenticatedAt !== undefined ? session.accessTokenIssuedAt : undefined) ||
    context.primaryAuthenticatedAt !== session.primaryAuthenticatedAt ||
    context.multiFactorAuthenticatedAt !== session.multiFactorAuthenticatedAt ||
    context.delegatedContext !== undefined || context.supportContext !== undefined ||
    Date.parse(context.issuedAt) > now || Date.parse(context.expiresAt) <= now ||
    Date.parse(context.issuedAt) >= Date.parse(context.expiresAt))
    problem("refused");
  return context;
};

const readOrdinaryRoot = async (
  transaction: RequestDatabaseTransaction,
  rootId: string,
): Promise<Readonly<{ isSystemApplication: false }>> => {
  const rows = await transaction.query<DatabaseRow>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  if (rows.length !== 1 || rows[0]?.outcome !== "available") problem("refused", "unsupported_root");
  if (rows[0]?.application_origin_kind !== "ordinary") problem("refused", "unsupported_root");
  return { isSystemApplication: false };
};

const targetFacts = async (
  transaction: RequestDatabaseTransaction,
  _scope: SelectedOrganizationScope,
  rootId: string | undefined,
) => {
  if (rootId === undefined) problem("refused", "unsupported_root");
  return readOrdinaryRoot(transaction, rootId);
};

const permissionDeclaration = (key: string) => {
  const permission = platformPermissionDeclarations.find((entry) => entry.key === key);
  if (permission === undefined) problem("temporarily_unavailable");
  return organizationAccessDeclarationSchema.parse({
    operationKey: key,
    action: { actionKind: permission.actionKind },
    target: { kind: "organization" },
    requiredPermission: {
      ownerKind: "platform",
      ownerId: platformPermissionOwnerId,
      permissionId: permission.permissionId,
    },
    recentAuthentication: { kind: "none" },
    authority: { kind: "permission" },
  });
};

const readPermissionDeadline = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: HumanContext,
  key: string,
): Promise<string> => {
  const decision = await runOrganizationAccessOperation(
    transaction,
    scope,
    permissionDeclaration(key),
    async (allowed) => allowed,
  );
  if (decision.outcome !== "completed")
    problem(decision.reasonCode === "authentication_required" ? "authentication_required" : "refused");
  const parsed = organizationPermissionEligibilitySchema.safeParse({
    ...decision.value,
    outcome: "eligible",
  });
  if (!parsed.success || parsed.data.target.kind !== "organization" ||
    !sameUuid(parsed.data.organizationId, context.organizationId) ||
    !sameUuid(parsed.data.organizationAccountId, context.organizationAccountId) ||
    parsed.data.accessVersion !== context.accessVersion ||
    !sameUuid(parsed.data.correlationId, context.correlationId) ||
    Date.parse(parsed.data.checkedAt) > Date.parse(parsed.data.validUntil)) problem("refused");
  return parsed.data.validUntil;
};

const requireAuthority = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  operation: BuilderOperation,
): Promise<void> => {
  const authority = createBuilderAuthority({ transaction, scope, targetFacts });
  await requireBuilderAuthority(authority, operation).catch((error: unknown) => {
    if (error instanceof Error && "code" in error &&
      String((error as { readonly code?: unknown }).code) === "BUILDER_RECENT_AUTHENTICATION_REQUIRED")
      problem("authentication_required");
    problem("refused");
  });
};

const readReleaseSet = async (
  transaction: RequestDatabaseTransaction,
  rootId: string,
  releaseRevision: number,
  organizationId: string,
  correlationId: string,
): Promise<SystemApplicationBoundReleaseSetResult> => {
  let candidate: unknown;
  try {
    candidate = await createDatabaseApplicationReleaseAdoptionReleaseSetService(
      installedReleaseCatalogue,
      transaction,
    ).read({ applicationRootId: rootId, applicationReleaseRevision: releaseRevision });
  } catch (error) {
    if (!(error instanceof DefinitionConsumerReadError) || error.code === "DEFINITION_READ_FAILED")
      problem("temporarily_unavailable");
    problem("refused");
  }
  const parsed = systemApplicationBoundReleaseSetResultSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.modules.length === 0 ||
    parsed.data.application.kind !== "application" ||
    !sameUuid(parsed.data.application.organizationId, organizationId) ||
    !sameUuid(parsed.data.application.rootId, rootId) ||
    parsed.data.application.releaseRevision !== releaseRevision ||
    !sameUuid(parsed.data.application.correlationId, correlationId))
    problem("refused");
  const roots = new Set<string>();
  for (const module of parsed.data.modules) {
    if (!sameUuid(module.organizationId, organizationId) ||
      !sameUuid(module.correlationId, correlationId) || roots.has(module.rootId.toLowerCase()))
      problem("refused");
    roots.add(module.rootId.toLowerCase());
  }
  return parsed.data;
};

const releaseIdentity = (release: ReleaseIdentityInput): StudioApplicationInstallationReleaseIdentity => {
  const parsed = studioApplicationInstallationReleaseIdentitySchema.safeParse({
    releaseRevision: release.releaseRevision,
    releaseVersion: release.releaseVersion,
    validationContractVersion: release.validationContractVersion,
    contentFingerprint: release.contentFingerprint,
    resolutionFingerprint: release.resolutionFingerprint,
  });
  if (!parsed.success) problem("refused");
  return parsed.data;
};

const releaseSetModuleTuples = (releaseSet: SystemApplicationBoundReleaseSetResult): readonly unknown[][] =>
  releaseSet.modules.map((module) => [
    module.organizationId.toLowerCase(),
    module.rootId.toLowerCase(),
    module.definitionKey,
    module.releaseRevision,
    module.releaseVersion,
    module.validationContractVersion,
    module.contentFingerprint,
    module.resolutionFingerprint,
  ]).sort((left, right) => String(left[1]) < String(right[1]) ? -1 :
    String(left[1]) > String(right[1]) ? 1 : 0);

const bindingTuple = (binding: ModuleInstallationBindingEvidence): readonly unknown[] => [
  binding.organizationId.toLowerCase(),
  binding.applicationRootId.toLowerCase(),
  binding.moduleRootId.toLowerCase(),
  binding.bindingRevision,
  binding.applicationReleaseRevision,
  binding.moduleReleaseRevision,
  binding.state,
];

const sortedBindingTuples = (
  bindings: readonly ModuleInstallationBindingEvidence[],
): readonly (readonly unknown[])[] => bindings.map(bindingTuple)
  .sort((left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

const fingerprint = (domain: string, value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify([domain, value]), "utf8").digest("hex")}`;

const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

const readInstallationBindings = async (
  transaction: RequestDatabaseTransaction,
  rootId: string,
): Promise<InstallationBindings> => {
  const rows = await transaction.query<DatabaseRow>`
    select vortex_module.read_application_installation_bindings(${rootId}::uuid) as bindings
  `;
  if (rows.length !== 1) problem("refused", "installation_incomplete");
  const parsed = installationBindingsSchema.safeParse(rows[0]?.bindings);
  if (!parsed.success || !sameUuid(parsed.data.applicationRootId, rootId))
    problem("refused", "installation_incomplete");
  return parsed.data;
};

const readCurrentState = async (
  transaction: RequestDatabaseTransaction,
  selector: StudioApplicationInstallationSelector,
  context: HumanContext,
): Promise<ReadState> => {
  await readOrdinaryRoot(transaction, selector.rootId);
  let active: ActiveApplicationInstallationEvidence;
  try {
    active = await createActiveApplicationInstallationRepository(transaction).readCurrent();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code) : "";
    switch (code) {
      case "ACTIVE_APPLICATION_CONTEXT_REFUSED":
        problem("refused");
      case "ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE":
        problem("refused", "not_installed");
      case "ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE":
        problem("refused", "installation_incomplete");
      default:
        problem("temporarily_unavailable");
    }
  }
  if (!sameUuid(active.organizationId, selector.organizationId) ||
    !sameUuid(active.applicationRootId, selector.rootId) || active.moduleBindings.length === 0)
    problem("refused", "installation_incomplete");
  const bindings = await readInstallationBindings(transaction, selector.rootId);
  if (!sameUuid(bindings.organizationId, selector.organizationId))
    problem("refused", "installation_incomplete");
  if (bindings.moduleBindings.some((binding) =>
    !sameUuid(binding.organizationId, selector.organizationId) ||
    !sameUuid(binding.applicationRootId, selector.rootId)))
    problem("refused", "installation_incomplete");
  const activeBindings = bindings.moduleBindings.filter((binding) => binding.state === "active");
  if (bindings.moduleBindings.some((binding) => binding.state !== "active" && binding.state !== "detached") ||
    !same(sortedBindingTuples(activeBindings), sortedBindingTuples(active.moduleBindings)) ||
    bindings.registeredReleaseRevision !== active.applicationReleaseRevision)
    problem("refused", bindings.registeredReleaseRevision !== active.applicationReleaseRevision
      ? "registration_misaligned" : "installation_incomplete");

  const activeReleaseSet = await readReleaseSet(
    transaction,
    selector.rootId,
    active.applicationReleaseRevision,
    selector.organizationId,
    context.correlationId,
  );
  const selectedReleaseSet = await readReleaseSet(
    transaction,
    selector.rootId,
    selector.releaseRevision,
    selector.organizationId,
    context.correlationId,
  );
  const activeModules = releaseSetModuleTuples(activeReleaseSet);
  if (activeModules.length !== active.moduleBindings.length ||
    active.moduleBindings.some((binding) => !activeReleaseSet.modules.some((module) =>
      sameUuid(module.rootId, binding.moduleRootId) && module.releaseRevision === binding.moduleReleaseRevision &&
      binding.applicationReleaseRevision === active.applicationReleaseRevision)))
    problem("refused", "installation_incomplete");
  return { active, activeReleaseSet, selectedReleaseSet, bindings };
};

const makeSnapshot = (
  selector: StudioApplicationInstallationSelector,
  state: ReadState,
  context: HumanContext,
  validUntil: string,
): StudioApplicationInstallationSnapshot => {
  const application = state.selectedReleaseSet.application;
  if (application.kind !== "application" ||
    !sameUuid(application.rootId, selector.rootId) ||
    !sameUuid(application.organizationId, selector.organizationId) ||
    state.activeReleaseSet.application.definitionKey !== application.definitionKey)
    problem("refused");
  const selected = releaseIdentity(application);
  const active = releaseIdentity(state.activeReleaseSet.application);
  const snapshot = studioApplicationInstallationSnapshotSchema.safeParse({
    organizationId: selector.organizationId,
    rootId: selector.rootId,
    definitionKey: application.definitionKey,
    selected,
    active,
    moduleSetFingerprint: fingerprint("vortex.studio.install.module-set.v1", releaseSetModuleTuples(state.selectedReleaseSet)),
    bindingSetFingerprint: fingerprint(
      "vortex.studio.install.binding-set.v1",
      sortedBindingTuples(state.bindings.moduleBindings),
    ),
    validUntil,
    correlationId: context.correlationId,
  });
  if (!snapshot.success) problem("temporarily_unavailable");
  return snapshot.data;
};

const assertStateEligible = (
  selector: StudioApplicationInstallationSelector,
  state: ReadState,
  allowEqual: boolean,
): void => {
  if (selector.releaseRevision < state.active.applicationReleaseRevision)
    problem("refused", "not_newer");
  const sameModules = same(
    releaseSetModuleTuples(state.activeReleaseSet),
    releaseSetModuleTuples(state.selectedReleaseSet),
  );
  if (selector.releaseRevision === state.active.applicationReleaseRevision) {
    if (!sameModules) problem("refused", "installation_incomplete");
    if (!allowEqual) problem("refused", "not_newer");
    return;
  }
  if (!sameModules) problem("refused", "module_set_changed");
};

const installOperation = (
  rootId: string,
  releaseSet: SystemApplicationBoundReleaseSetResult,
) => ({
  kind: "installation" as const,
  applicationRootId: rootId,
  change: "install_or_upgrade" as const,
  containsCustomComponents: releaseSetContainsCustomComponents(releaseSet),
  acceptedPermissions: [],
});

const sameSnapshotState = (
  left: StudioApplicationInstallationSnapshot,
  right: StudioApplicationInstallationSnapshot,
): boolean => same({
  organizationId: left.organizationId,
  rootId: left.rootId,
  definitionKey: left.definitionKey,
  selected: left.selected,
  active: left.active,
  moduleSetFingerprint: left.moduleSetFingerprint,
  bindingSetFingerprint: left.bindingSetFingerprint,
}, {
  organizationId: right.organizationId,
  rootId: right.rootId,
  definitionKey: right.definitionKey,
  selected: right.selected,
  active: right.active,
  moduleSetFingerprint: right.moduleSetFingerprint,
  bindingSetFingerprint: right.bindingSetFingerprint,
});

const sameSelectedSnapshot = (
  expected: StudioApplicationInstallationSnapshot,
  current: StudioApplicationInstallationSnapshot,
): boolean => same({
  organizationId: expected.organizationId,
  rootId: expected.rootId,
  definitionKey: expected.definitionKey,
  selected: expected.selected,
  moduleSetFingerprint: expected.moduleSetFingerprint,
}, {
  organizationId: current.organizationId,
  rootId: current.rootId,
  definitionKey: current.definitionKey,
  selected: current.selected,
  moduleSetFingerprint: current.moduleSetFingerprint,
});

const withCurrentAuthorizedState = async (
  selector: StudioApplicationInstallationSelector,
  session: IdentitySession,
  allowEqual: boolean,
): Promise<AuthorizedState> => {
  let captured: Problem | undefined;
  const result = await humanOrganizationRequests().run(
    session,
    { organizationId: selector.organizationId, applicationRootId: selector.rootId },
    async (transaction, scope, issuedAt) => {
      try {
        const context = await readHumanContext(transaction, scope, session, issuedAt, {
          organizationId: selector.organizationId,
          applicationRootId: selector.rootId,
        });
        await requireAuthority(transaction, scope, { kind: "draft_change", rootId: selector.rootId });
        const firstState = await readCurrentState(transaction, selector, context);
        assertStateEligible(selector, firstState, allowEqual);
        await requireAuthority(transaction, scope, installOperation(selector.rootId, firstState.selectedReleaseSet));

        const finalContext = await readHumanContext(transaction, scope, session, issuedAt, {
          organizationId: selector.organizationId,
          applicationRootId: selector.rootId,
        });
        if (!same(context, finalContext)) problem("refused");
        const finalState = await readCurrentState(transaction, selector, finalContext);
        assertStateEligible(selector, finalState, allowEqual);
        if (!same({
          active: firstState.active,
          activeReleaseSet: firstState.activeReleaseSet,
          selectedReleaseSet: firstState.selectedReleaseSet,
          bindings: firstState.bindings,
        }, {
          active: finalState.active,
          activeReleaseSet: finalState.activeReleaseSet,
          selectedReleaseSet: finalState.selectedReleaseSet,
          bindings: finalState.bindings,
        })) problem("conflict");
        await requireAuthority(transaction, scope, { kind: "draft_change", rootId: selector.rootId });
        await requireAuthority(transaction, scope, installOperation(selector.rootId, finalState.selectedReleaseSet));

        const draftDeadline = await readPermissionDeadline(
          transaction, scope, finalContext, "platform.organization.definition_drafts.manage",
        );
        const installationDeadline = await readPermissionDeadline(
          transaction, scope, finalContext, "platform.organization.applications.manage",
        );
        const completedAt = await databaseNow(transaction);
        const deadline = Math.min(
          Date.parse(finalContext.expiresAt), Date.parse(draftDeadline), Date.parse(installationDeadline),
        );
        if (!Number.isFinite(deadline) || Date.parse(completedAt) >= deadline)
          problem("refused");
        return {
          snapshot: makeSnapshot(selector, finalState, finalContext, new Date(deadline).toISOString()),
          state: finalState,
          checkedAt: completedAt,
        };
      } catch (error) {
        captured = safeFailure(error);
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (captured !== undefined) throw new InstallationProblem(captured);
  if (result.kind === "unavailable") problem("refused");
  problem("temporarily_unavailable");
};

const readActiveObservation = async (
  organizationId: string,
  rootId: string,
  session: IdentitySession,
): Promise<StudioApplicationInstallationReleaseIdentity> => {
  let captured: Problem | undefined;
  const result = await humanOrganizationRequests().run(
    session,
    { organizationId, applicationRootId: rootId },
    async (transaction, scope, issuedAt) => {
      try {
        const context = await readHumanContext(
          transaction, scope, session, issuedAt, { organizationId, applicationRootId: rootId },
        );
        await requireAuthority(transaction, scope, { kind: "draft_change", rootId });
        const active = await createActiveApplicationInstallationRepository(transaction).readCurrent();
        if (!sameUuid(active.organizationId, organizationId) || !sameUuid(active.applicationRootId, rootId))
          problem("refused");
        const registration = await readInstallationBindings(transaction, rootId);
        const registeredActive = registration.moduleBindings.filter((binding) => binding.state === "active");
        if (!sameUuid(registration.organizationId, organizationId) ||
          !sameUuid(registration.applicationRootId, rootId) ||
          registration.moduleBindings.some((binding) =>
            !sameUuid(binding.organizationId, organizationId) || !sameUuid(binding.applicationRootId, rootId)) ||
          registration.registeredReleaseRevision !== active.applicationReleaseRevision ||
          registration.moduleBindings.some((binding) => binding.state !== "active" && binding.state !== "detached") ||
          !same(sortedBindingTuples(registeredActive), sortedBindingTuples(active.moduleBindings)))
          problem("refused");
        const releaseSet = await readReleaseSet(
          transaction, rootId, active.applicationReleaseRevision, organizationId, context.correlationId,
        );
        if (releaseSet.modules.length !== active.moduleBindings.length ||
          active.moduleBindings.some((binding) => !releaseSet.modules.some((module) =>
            sameUuid(module.rootId, binding.moduleRootId) && module.releaseRevision === binding.moduleReleaseRevision)))
          problem("refused");
        await readOrdinaryRoot(transaction, rootId);
        await requireAuthority(transaction, scope, installOperation(rootId, releaseSet));
        const finalContext = await readHumanContext(
          transaction, scope, session, issuedAt, { organizationId, applicationRootId: rootId },
        );
        if (!same(context, finalContext)) problem("refused");
        await requireAuthority(transaction, scope, { kind: "draft_change", rootId });
        const deadline = await readPermissionDeadline(
          transaction, scope, context, "platform.organization.applications.manage",
        );
        if (Date.parse(await databaseNow(transaction)) >= Math.min(Date.parse(context.expiresAt), Date.parse(deadline)))
          problem("refused");
        return releaseIdentity(releaseSet.application);
      } catch (error) {
        captured = safeFailure(error);
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (captured !== undefined) throw new InstallationProblem(captured);
  problem(result.kind === "unavailable" ? "refused" : "temporarily_unavailable");
};

export const loadStudioApplicationInstallation = async (
  organizationIdCandidate: string,
  selectorCandidate: unknown,
) => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const selector = studioApplicationInstallationSelectorSchema.safeParse(selectorCandidate);
  if (!organizationId.success || !selector.success ||
    !sameUuid(organizationId.data, selector.data.organizationId))
    return studioApplicationInstallationLoadResultSchema.parse({ kind: "refused" });
  try {
    const session = await exactSession();
    if (session === undefined) return studioApplicationInstallationLoadResultSchema.parse({ kind: "refused" });
    const authorized = await withCurrentAuthorizedState(selector.data, session, true);
    if (authorized.snapshot.selected.releaseRevision < authorized.snapshot.active.releaseRevision)
      return unavailable("not_newer");
    return studioApplicationInstallationLoadResultSchema.parse({
      kind: "available",
      snapshot: authorized.snapshot,
    });
  } catch (error) {
    return toLoadFailure(safeFailure(error));
  }
};

const sameActiveBindings = (
  candidate: unknown,
  expected: readonly ModuleInstallationBindingEvidence[],
): boolean => {
  const parsed = z.array(moduleInstallationBindingEvidenceSchema).max(10_000).safeParse(candidate);
  return parsed.success && same(sortedBindingTuples(parsed.data), sortedBindingTuples(expected));
};

const humanDefinitionAccess = (): HumanInstallationDefinitionAccess => ({
  async readReleaseSet(session, target) {
    const result = await humanOrganizationRequests().run(
      session,
      { organizationId: target.organizationId, applicationRootId: target.applicationRootId },
      (transaction) => createDatabaseApplicationReleaseAdoptionReleaseSetService(
        installedReleaseCatalogue,
        transaction,
      ).read({
        applicationRootId: target.applicationRootId,
        applicationReleaseRevision: target.applicationReleaseRevision,
      }),
    );
    if (result.kind !== "available")
      throw new ApplicationInstallationCoordinatorError("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
    return result.value;
  },
  async prepareRegistrationCandidate(target, releaseSet) {
    return prepareApplicationRoleTemplatesForHumanRequest(
      target.organizationId,
      { applicationRootId: target.applicationRootId, releaseRevision: target.applicationReleaseRevision },
      releaseSet,
    );
  },
});

const currentInstallationStateForCoordinator = async (
  transaction: RequestDatabaseTransaction,
  selector: StudioApplicationInstallationSelector,
  baseline: ReadState,
  step: number,
  context: HumanContext,
): Promise<void> => {
  const current = await readInstallationBindings(transaction, selector.rootId);
  if (!sameUuid(current.organizationId, selector.organizationId) ||
    !sameUuid(current.applicationRootId, selector.rootId) ||
    current.moduleBindings.some((binding) => binding.state !== "active" && binding.state !== "detached") ||
    !same(sortedBindingTuples(current.moduleBindings), sortedBindingTuples(baseline.bindings.moduleBindings)) ||
    !sameActiveBindings(current.moduleBindings.filter((binding) => binding.state === "active"), baseline.active.moduleBindings))
    problem("conflict");
  const allowedRegistrations = step === 0
    ? [baseline.active.applicationReleaseRevision]
    : [baseline.active.applicationReleaseRevision, selector.releaseRevision];
  if (!allowedRegistrations.includes(current.registeredReleaseRevision ?? -1))
    problem("conflict");
  if (!sameUuid(context.organizationId, selector.organizationId))
    problem("refused");
};

const coordinatorFor = (selector: StudioApplicationInstallationSelector, baseline: ReadState) => {
  const requests = humanOrganizationRequests();
  let step = 0;
  const installerRequests: Pick<ReturnType<typeof humanOrganizationRequests>, "runChange"> = {
    runChange: async <Result>(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      operation: (
        transaction: RequestDatabaseTransaction,
        scope: SelectedOrganizationScope,
        issuedAt: string,
      ) => Promise<Result>,
    ): Promise<HumanOrganizationRequestResult<Result>> => {
      const thisStep = step++;
      // The existing coordinator can open a third, compensating Access transaction after a
      // failed switch. The same baseline guard below permits only restoration of this request's
      // exact prior registration; any further installer transaction is unexpected.
      if (thisStep > 2) problem("temporarily_unavailable");
      let callbackFailure: unknown;
      const result = await requests.runChange(session, candidate, async (transaction, scope, issuedAt) => {
        try {
          if (!sameUuid(scope.organizationId, selector.organizationId) || scope.applicationRootId !== undefined)
            problem("refused");
          const context = await readHumanContext(transaction, scope, session, issuedAt, {
            organizationId: selector.organizationId,
          });
          await readOrdinaryRoot(transaction, selector.rootId);
          await requireAuthority(transaction, scope, { kind: "draft_change", rootId: selector.rootId });
          await currentInstallationStateForCoordinator(transaction, selector, baseline, thisStep, context);
          return await operation(transaction, scope, issuedAt);
        } catch (error) {
          callbackFailure = error;
          throw error;
        }
      });
      if (callbackFailure !== undefined) throw callbackFailure;
      return result;
    },
  };
  return createApplicationInstallationCoordinator({
    installerRequests,
    resolveModuleContributions,
    builderAuthority: (transaction, scope) => createBuilderAuthority({ transaction, scope, targetFacts }),
    containsCustomComponents: releaseSetContainsCustomComponents,
    humanDefinitionAccess: humanDefinitionAccess(),
  });
};

const verifyCoordinatorActivation = (
  result: ApplicationInstallationActivationResult<unknown>,
  selector: StudioApplicationInstallationSelector,
  priorRevision: number,
  selectedReleaseSet: SystemApplicationBoundReleaseSetResult,
): Readonly<{ outcome: "activated" | "unchanged"; previousActiveRevision: number | null }> => {
  const installed = result.installation;
  const selectedModules = new Map(selectedReleaseSet.modules.map((module) => [module.rootId.toLowerCase(), module]));
  if (!sameUuid(installed.organizationId, selector.organizationId) ||
    !sameUuid(installed.applicationRootId, selector.rootId) ||
    installed.applicationReleaseRevision !== selector.releaseRevision ||
    installed.moduleBindings.length !== selectedModules.size ||
    installed.moduleBindings.some((binding) => {
      const module = selectedModules.get(binding.moduleRootId.toLowerCase());
      return binding.state !== "active" || !sameUuid(binding.organizationId, selector.organizationId) ||
        !sameUuid(binding.applicationRootId, selector.rootId) ||
        binding.applicationReleaseRevision !== selector.releaseRevision || module === undefined ||
        binding.moduleReleaseRevision !== module.releaseRevision;
    })) problem("failed");
  if (result.outcome === "activated") {
    if (result.previousApplicationReleaseRevision !== priorRevision) problem("conflict");
    return { outcome: "activated", previousActiveRevision: result.previousApplicationReleaseRevision };
  }
  if (result.previousApplicationReleaseRevision !== selector.releaseRevision) problem("conflict");
  return { outcome: "unchanged", previousActiveRevision: null };
};

export const installSelectedStudioApplicationRelease = async (
  organizationIdCandidate: string,
  commandCandidate: unknown,
): Promise<StudioApplicationInstallationCommandResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const command = studioApplicationInstallationCommandSchema.safeParse(commandCandidate);
  if (!organizationId.success || !command.success ||
    !sameUuid(organizationId.data, command.data.selector.organizationId) ||
    !sameUuid(command.data.expected.organizationId, command.data.selector.organizationId) ||
    !sameUuid(command.data.expected.rootId, command.data.selector.rootId) ||
    command.data.expected.selected.releaseRevision !== command.data.selector.releaseRevision)
    return toCommandFailure({ kind: "refused" }, false);

  let invocationStarted = false;
  try {
    const session = await exactSession();
    if (session === undefined) return toCommandFailure({ kind: "refused" }, false);
    const current = await withCurrentAuthorizedState(command.data.selector, session, true);
    const currentSnapshot = current.snapshot;
    const now = Date.parse(current.checkedAt);
    if (!Number.isFinite(now) || Date.parse(command.data.expected.validUntil) <= now ||
      Date.parse(currentSnapshot.validUntil) <= now)
      return toCommandFailure({ kind: "conflict" }, false);

    const selected = current.snapshot.selected;
    const currentActiveRevision = current.state.active.applicationReleaseRevision;
    if (selected.releaseRevision === currentActiveRevision) {
      if (!sameSelectedSnapshot(command.data.expected, currentSnapshot) ||
        !same(current.snapshot.active, current.snapshot.selected))
        return toCommandFailure({ kind: "conflict" }, false);
      const postCommit = { kind: "observed" as const, active: current.snapshot.active };
      return studioApplicationInstallationCommandResultSchema.parse({
        kind: "completed",
        outcome: "unchanged",
        selected,
        previousActiveRevision: null,
        activeAtCommitRevision: currentActiveRevision,
        postCommit,
        registrationMayHaveChanged: false,
      });
    }
    if (!sameSnapshotState(command.data.expected, currentSnapshot))
      return toCommandFailure({ kind: "conflict" }, false);

    invocationStarted = true;
    const result = await coordinatorFor(command.data.selector, current.state).activate(session, {
      organizationId: current.state.active.organizationId,
      applicationRootId: command.data.selector.rootId,
      applicationReleaseRevision: command.data.selector.releaseRevision,
      expectedActiveReleaseRevision: currentActiveRevision,
    });
    const verified = verifyCoordinatorActivation(
      result,
      command.data.selector,
      currentActiveRevision,
      current.state.selectedReleaseSet,
    );
    let postCommit: { kind: "observed"; active: StudioApplicationInstallationReleaseIdentity } |
      { kind: "unavailable" } = { kind: "unavailable" };
    try {
      postCommit = {
        kind: "observed",
        active: await readActiveObservation(organizationId.data, command.data.selector.rootId, session),
      };
    } catch {
      postCommit = { kind: "unavailable" };
    }
    return studioApplicationInstallationCommandResultSchema.parse({
      kind: "completed",
      outcome: verified.outcome,
      selected,
      previousActiveRevision: verified.previousActiveRevision,
      activeAtCommitRevision: result.installation.applicationReleaseRevision,
      postCommit,
      registrationMayHaveChanged: invocationStarted,
    });
  } catch (error) {
    return toCommandFailure(safeFailure(error), invocationStarted ? "unknown" : false);
  }
};
