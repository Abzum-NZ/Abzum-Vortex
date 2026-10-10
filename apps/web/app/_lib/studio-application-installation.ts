import "server-only";

import { createHash, randomUUID } from "node:crypto";
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
  activityIdSchema,
  applicationRootIdSchema,
  archiveDestinationReferenceSchema,
  connectionInstanceIdSchema,
  canonicalJson,
  connectionTypeIdSchema,
  databaseRevision,
  databaseTimestamp,
  moduleInstallationBindingEvidenceSchema,
  moduleRootIdSchema,
  organizationLifecycleLimitsSchema,
  organizationAccessDecisionSchema,
  organizationAccessDeclarationSchema,
  organizationIdSchema,
  organizationPermissionEligibilitySchema,
  protectedOperationChannelSchema,
  recordLifecyclePolicyIdSchema,
  recordTypeLifecyclePolicySchema,
  revisionSchema,
  sameId,
  sessionContextSchema,
  storageContractIdSchema,
  systemApplicationBoundReleaseSetResultSchema,
  timestampSchema,
  workflowIdSchema,
  type ActiveApplicationInstallationEvidence,
  type ApplicationRootId,
  type ArchiveDestinationReference,
  type IdentitySession,
  type ModuleInstallationBindingEvidence,
  type OrganizationAccessDeclaration,
  type OrganizationAccessDecision,
  type OrganizationLifecycleLimits,
  type OrganizationSelectionCandidate,
  type RecordTypeLifecyclePolicy,
  type StorageContractId,
  type SelectedOrganizationScope,
  type SessionContext,
  type SystemApplicationBoundReleaseSetResult,
} from "@vortex/contracts";
import { listEligibleArchiveConnectionsForApplication } from "@vortex/connection";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  builderRecentAuthentication,
  DefinitionConsumerReadError,
  createDatabaseApplicationBoundReleaseSetService,
  createDatabaseApplicationReleaseAdoptionReleaseSetService,
  createDatabaseFirstInstallApplicationReleaseSetService,
  deriveBuilderRequirements,
  readApplicationDefinitionDraft,
  resolveModuleContributions,
} from "@vortex/definition";
import { createActiveApplicationInstallationRepository } from "@vortex/module";
import { createRecordTypeLifecyclePolicyService } from "@vortex/record";
import { platformPermissionDeclarations, platformPermissionOwnerId } from "@vortex/modules";
import { z } from "zod";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { installedReleaseCatalogue, releaseSetContainsCustomComponents } from "./definition-catalogue";
import { humanOrganizationRequestDependencies, humanOrganizationRequests } from "./server-composition";
import {
  inspectStudioApplicationReleaseHistory,
  loadStudioApplicationHistoryAccess,
} from "./studio-application-history";
import {
  studioApplicationInstallationCommandResultSchema,
  studioApplicationInstallationCommandSchema,
  studioApplicationInstallationLoadResultSchema,
  studioApplicationInstallationReleaseIdentitySchema,
  studioApplicationInstallationSelectorSchema,
  studioApplicationInstallationSnapshotSchema,
  studioApplicationArchiveOptionsQuerySchema,
  studioApplicationArchiveOptionsResultSchema,
  studioApplicationFirstInstallActivateCommandSchema,
  studioApplicationFirstInstallCommandResultSchema,
  studioApplicationFirstInstallLoadResultSchema,
  studioApplicationFirstInstallPolicyInputSchema,
  studioApplicationFirstInstallPrepareCommandSchema,
  studioApplicationFirstInstallSaveCommandSchema,
  studioApplicationFirstInstallSelectorSchema,
  studioApplicationFirstInstallSetupSchema,
  studioApplicationFirstInstallSnapshotSchema,
  type StudioApplicationArchiveOptionsResult,
  type StudioApplicationFirstInstallCommandResult,
  type StudioApplicationFirstInstallLoadResult,
  type StudioApplicationFirstInstallSelector,
  type StudioApplicationFirstInstallSnapshot,
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

function problem(kind: Problem["kind"], unavailableReason?: Problem["unavailableReason"]): never {
  throw new InstallationProblem({ kind, ...(unavailableReason === undefined ? {} : { unavailableReason }) });
}

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
  const { channel: rawChannel, ...sessionContext } = transport.data;
  const channel = protectedOperationChannelSchema.safeParse(rawChannel);
  if (!channel.success || channel.data !== "web") problem("refused");
  const parsed = sessionContextSchema.safeParse(sessionContext);
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

const permissionDeclaration = (key: string, requiresRecentAuthentication = false) => {
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
    recentAuthentication: requiresRecentAuthentication
      ? builderRecentAuthentication
      : { kind: "none" },
    authority: { kind: "permission" },
  });
};

const readPermissionDeadline = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: HumanContext,
  key: string,
  requiresRecentAuthentication = false,
): Promise<string> => {
  const decision = await runOrganizationAccessOperation(
    transaction,
    scope,
    permissionDeclaration(key, requiresRecentAuthentication),
    async (allowed) => allowed,
  );
  if (decision.outcome !== "completed")
    problem(decision.reasonCode === "authentication_required" ? "authentication_required" : "refused");
  const parsed = organizationPermissionEligibilitySchema.safeParse({
    ...decision.value,
    outcome: "eligible",
  });
  if (!parsed.success || parsed.data.outcome !== "eligible") problem("refused");
  if (parsed.data.target.kind !== "organization" ||
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

const readInstallationAuthorityDeadlines = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: HumanContext,
  rootId: string,
  releaseSet: SystemApplicationBoundReleaseSetResult,
): Promise<readonly string[]> => {
  const operation = installOperation(rootId, releaseSet);
  const facts = await targetFacts(transaction, scope, rootId);
  const requirements = deriveBuilderRequirements(operation, facts);
  if (requirements.refused || requirements.permissionKeys.length === 0 ||
    requirements.delegatedPermissions.length !== 0) problem("refused");

  const deadlines: string[] = [];
  for (const [index, key] of requirements.permissionKeys.entries()) {
    deadlines.push(await readPermissionDeadline(
      transaction,
      scope,
      context,
      key,
      requirements.recentAuthentication && index === 0,
    ));
  }
  return deadlines;
};

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
        const installationDeadlines = await readInstallationAuthorityDeadlines(
          transaction, scope, finalContext, selector.rootId, finalState.selectedReleaseSet,
        );
        const completedAt = await databaseNow(transaction);
        const deadline = Math.min(
          Date.parse(finalContext.expiresAt),
          Date.parse(draftDeadline),
          ...installationDeadlines.map((validUntil) => Date.parse(validUntil)),
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
  organizationId: SelectedOrganizationScope["organizationId"],
  rootId: StudioApplicationInstallationSelector["rootId"],
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
        const draftDeadline = await readPermissionDeadline(
          transaction, scope, finalContext, "platform.organization.definition_drafts.manage",
        );
        const installationDeadlines = await readInstallationAuthorityDeadlines(
          transaction, scope, finalContext, rootId, releaseSet,
        );
        const completedAt = await databaseNow(transaction);
        const deadline = Math.min(
          Date.parse(finalContext.expiresAt),
          Date.parse(draftDeadline),
          ...installationDeadlines.map((validUntil) => Date.parse(validUntil)),
        );
        if (!Number.isFinite(deadline) || Date.parse(completedAt) >= deadline) problem("refused");
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

type FirstInstallUnavailableReason =
  | "release_not_published"
  | "already_installed"
  | "installation_incomplete"
  | "setup_unavailable"
  | "unsupported_root";

class FirstInstallUnavailable extends Error {
  constructor(readonly reason: FirstInstallUnavailableReason) {
    super(reason);
    this.name = "FirstInstallUnavailable";
  }
}

const firstInstallUnavailable = (reason: FirstInstallUnavailableReason): never => {
  throw new FirstInstallUnavailable(reason);
};

const firstInstallHistory = (snapshot: Readonly<{
  draftRevision: number;
  sourceFingerprint: string;
  anchorReleaseRevision: number | null;
}>) => ({
  draftRevision: snapshot.draftRevision,
  sourceFingerprint: snapshot.sourceFingerprint,
  anchorReleaseRevision: snapshot.anchorReleaseRevision,
});

const sameFirstInstallRelease = (
  left: SystemApplicationBoundReleaseSetResult,
  right: SystemApplicationBoundReleaseSetResult,
): boolean => {
  const withoutCorrelation = (value: SystemApplicationBoundReleaseSetResult) => ({
    application: (({ correlationId: _correlationId, ...application }) => application)(value.application),
    modules: value.modules.map(({ correlationId: _correlationId, ...module }) => module),
  });
  return same(withoutCorrelation(left), withoutCorrelation(right));
};

const firstInstallWorkflows = (releaseSet: SystemApplicationBoundReleaseSetResult): string[] => {
  const seen = new Set<string>();
  for (const dependency of releaseSet.application.dependencyManifest) {
    if (dependency.kind !== "application_workflow" ||
      !sameUuid(dependency.applicationRootId, releaseSet.application.rootId)) continue;
    const workflow = workflowIdSchema.safeParse(dependency.workflowId);
    if (!workflow.success || seen.has(workflow.data.toLowerCase())) problem("refused");
    seen.add(workflow.data.toLowerCase());
  }
  return [...seen].sort();
};

const firstInstallModuleSetFingerprint = (releaseSet: SystemApplicationBoundReleaseSetResult): string =>
  fingerprint("application-first-install-module-set-v1", releaseSetModuleTuples(releaseSet));

const firstInstallSelectedIdentity = (releaseSet: SystemApplicationBoundReleaseSetResult) => ({
  definitionKey: releaseSet.application.definitionKey,
  releaseRevision: releaseSet.application.releaseRevision,
  releaseVersion: releaseSet.application.releaseVersion,
  validationContractVersion: releaseSet.application.validationContractVersion,
  contentFingerprint: releaseSet.application.contentFingerprint,
  resolutionFingerprint: releaseSet.application.resolutionFingerprint,
  moduleSetFingerprint: firstInstallModuleSetFingerprint(releaseSet),
});

const firstInstallSnapshot = (
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: InstallationBindings,
  registrationState: StudioApplicationFirstInstallSnapshot["registrationState"],
  setup: unknown | null,
): StudioApplicationFirstInstallSnapshot => studioApplicationFirstInstallSnapshotSchema.parse({
  organizationId: selector.organizationId,
  rootId: selector.rootId,
  selected: firstInstallSelectedIdentity(releaseSet),
  history,
  registrationState,
  registeredReleaseRevision: bindings.registeredReleaseRevision,
  moduleBindings: bindings.moduleBindings,
  workflows: firstInstallWorkflows(releaseSet),
  setup,
});

const firstInstallState = (
  selector: StudioApplicationFirstInstallSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: InstallationBindings,
): StudioApplicationFirstInstallSnapshot["registrationState"] => {
  const pinned = new Map(releaseSet.modules.map((module) => [module.rootId.toLowerCase(), module]));
  if (pinned.size !== releaseSet.modules.length || pinned.size === 0)
    firstInstallUnavailable("setup_unavailable");
  if (bindings.moduleBindings.some((binding) =>
    !sameUuid(binding.organizationId, selector.organizationId) ||
    !sameUuid(binding.applicationRootId, selector.rootId) || binding.state === "draining"))
    firstInstallUnavailable("installation_incomplete");
  if (bindings.registeredReleaseRevision === null) {
    if (bindings.moduleBindings.some((binding) => binding.state !== "detached"))
      firstInstallUnavailable("installation_incomplete");
    return "unprepared";
  }
  if (bindings.registeredReleaseRevision !== selector.releaseRevision)
    firstInstallUnavailable("already_installed");

  const nonDetached = bindings.moduleBindings.filter((binding) => binding.state !== "detached");
  if (new Set(nonDetached.map((binding) => binding.moduleRootId.toLowerCase())).size !== nonDetached.length ||
    nonDetached.some((binding) => !pinned.has(binding.moduleRootId.toLowerCase())))
    firstInstallUnavailable("installation_incomplete");
  const expected = releaseSet.modules;
  if (nonDetached.some((binding) => {
    const module = pinned.get(binding.moduleRootId.toLowerCase());
    return module === undefined || binding.state !== "provisioned" ||
      binding.applicationReleaseRevision !== selector.releaseRevision ||
      binding.moduleReleaseRevision !== module.releaseRevision;
  })) {
    const activeExact = expected.every((module) => {
      const matches = nonDetached.filter((binding) =>
        sameUuid(binding.moduleRootId, module.rootId) &&
        binding.applicationReleaseRevision === selector.releaseRevision &&
        binding.moduleReleaseRevision === module.releaseRevision && binding.state === "active");
      return matches.length === 1;
    });
    if (activeExact && nonDetached.length === expected.length) return "active_exact";
    firstInstallUnavailable("installation_incomplete");
  }
  const exactState = (state: "active" | "provisioned") => expected.every((module) => {
    const matches = nonDetached.filter((binding) =>
      sameUuid(binding.moduleRootId, module.rootId) &&
      binding.applicationReleaseRevision === selector.releaseRevision &&
      binding.moduleReleaseRevision === module.releaseRevision && binding.state === state);
    return matches.length === 1;
  }) && nonDetached.length === expected.length;
  if (exactState("active")) return "active_exact";
  if (exactState("provisioned")) return "provisioned_inactive";
  return "registration_aligned_partial";
};

const firstInstallHistoryMatchesDraft = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  definitionKey: string,
): Promise<void> => {
  const draft = await readApplicationDefinitionDraft(transaction, scope, {
    rootId: selector.rootId,
    expectedDraftRevision: history.draftRevision,
  });
  if (!sameUuid(draft.rootId, selector.rootId) || draft.key !== definitionKey ||
    draft.sourceFingerprint !== history.sourceFingerprint ||
    draft.publishedRevision !== history.anchorReleaseRevision ||
    history.anchorReleaseRevision === null || selector.releaseRevision > history.anchorReleaseRevision)
    problem("conflict");
};

const readFirstInstallReleaseSet = async (
  transaction: RequestDatabaseTransaction,
  selector: StudioApplicationFirstInstallSelector,
  context: HumanContext,
): Promise<SystemApplicationBoundReleaseSetResult> => {
  let candidate: unknown;
  try {
    candidate = await createDatabaseFirstInstallApplicationReleaseSetService(
      installedReleaseCatalogue,
      transaction,
    ).read({
      applicationRootId: selector.rootId,
      applicationReleaseRevision: selector.releaseRevision,
    });
  } catch (error) {
    if (!(error instanceof DefinitionConsumerReadError)) problem("temporarily_unavailable");
    if (error.code === "DEFINITION_RELEASE_NOT_FOUND")
      firstInstallUnavailable("release_not_published");
    if (error.code === "DEFINITION_CONTEXT_REFUSED") problem("refused");
    if (error.code === "DEFINITION_RELEASE_INTEGRITY_FAILED") problem("refused");
    problem("temporarily_unavailable");
  }
  const parsed = systemApplicationBoundReleaseSetResultSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.application.kind !== "application" ||
    !sameUuid(parsed.data.application.organizationId, context.organizationId) ||
    !sameUuid(parsed.data.application.rootId, selector.rootId) ||
    parsed.data.application.releaseRevision !== selector.releaseRevision ||
    !sameUuid(parsed.data.application.correlationId, context.correlationId) ||
    parsed.data.modules.some((module) => !sameUuid(module.organizationId, context.organizationId) ||
      !sameUuid(module.correlationId, context.correlationId)))
    problem("refused");
  return parsed.data;
};

const firstInstallSetMatchesHistory = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
  metadata: Readonly<{
    releaseRevision: number;
    releaseVersion: string;
    contentFingerprint: string;
  }>,
  selector: StudioApplicationFirstInstallSelector,
): boolean => releaseSet.application.releaseRevision === metadata.releaseRevision &&
  releaseSet.application.releaseVersion === metadata.releaseVersion &&
  releaseSet.application.contentFingerprint === metadata.contentFingerprint &&
  sameUuid(releaseSet.application.rootId, selector.rootId) &&
  releaseSet.application.releaseRevision === selector.releaseRevision;

const firstInstallLoadFailure = (error: unknown): StudioApplicationFirstInstallLoadResult => {
  if (error instanceof FirstInstallUnavailable)
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "unavailable", reason: error.reason });
  const failure = safeFailure(error);
  if (failure.kind === "conflict")
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "conflict" });
  if (failure.kind === "refused" || failure.kind === "authentication_required")
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "refused" });
  return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "temporarily_unavailable" });
};

const firstInstallCommandFailure = (
  error: unknown,
  stateMayHaveChanged: boolean | "unknown",
): StudioApplicationFirstInstallCommandResult => {
  const failure = error instanceof FirstInstallUnavailable
    ? error.reason === "already_installed"
      ? { kind: "conflict" as const }
      : { kind: "refused" as const }
    : safeFailure(error);
  return studioApplicationFirstInstallCommandResultSchema.parse({
    kind: failure.kind,
    stateMayHaveChanged,
  });
};

type FirstInstallCandidate = Readonly<{
  selector: StudioApplicationFirstInstallSelector;
  history: ReturnType<typeof firstInstallHistory>;
  historyMetadata: Readonly<{
    releaseRevision: number;
    releaseVersion: string;
    contentFingerprint: string;
  }>;
  releaseSet: SystemApplicationBoundReleaseSetResult;
  snapshot: StudioApplicationFirstInstallSnapshot;
  session: IdentitySession;
}>;

const readCurrentFirstInstallCandidate = async (
  selector: StudioApplicationFirstInstallSelector,
): Promise<FirstInstallCandidate> => {
  const session = await exactSession();
  if (session === undefined) problem("refused");
  const access = await loadStudioApplicationHistoryAccess(selector.organizationId, selector.rootId);
  if (access.kind !== "available") {
    if (access.kind === "conflict") problem("conflict");
    if (access.kind === "refused") problem("refused");
    problem("temporarily_unavailable");
  }
  const history = firstInstallHistory(access.snapshot);
  if (history.anchorReleaseRevision === null || selector.releaseRevision > history.anchorReleaseRevision)
    firstInstallUnavailable("release_not_published");
  const inspected = await inspectStudioApplicationReleaseHistory(selector.organizationId, {
    rootId: selector.rootId,
    expected: history,
    releaseRevision: selector.releaseRevision,
  });
  if (inspected.kind !== "available") {
    if (inspected.kind === "conflict") problem("conflict");
    if (inspected.kind === "refused") firstInstallUnavailable("release_not_published");
    problem("temporarily_unavailable");
  }
  const result = await humanOrganizationRequests().runChange(
    session,
    { organizationId: selector.organizationId },
    async (transaction, scope, issuedAt) => {
      const context = await readHumanContext(transaction, scope, session, issuedAt, {
        organizationId: selector.organizationId,
      });
      if (scope.applicationRootId !== undefined) problem("refused");
      await readOrdinaryRoot(transaction, selector.rootId);
      await requireAuthority(transaction, scope, { kind: "draft_change", rootId: selector.rootId });
      await firstInstallHistoryMatchesDraft(
        transaction, scope, selector, history, inspected.snapshot.definitionKey,
      );
      const releaseSet = await readFirstInstallReleaseSet(transaction, selector, context);
      if (!firstInstallSetMatchesHistory(releaseSet, inspected.metadata, selector) ||
        releaseSet.application.definitionKey !== inspected.snapshot.definitionKey)
        problem("conflict");
      await requireAuthority(transaction, scope, installOperation(selector.rootId, releaseSet));
      await firstInstallHistoryMatchesDraft(
        transaction, scope, selector, history, inspected.snapshot.definitionKey,
      );
      const bindings = await readInstallationBindings(transaction, selector.rootId);
      const finalContext = await readHumanContext(transaction, scope, session, issuedAt, {
        organizationId: selector.organizationId,
      });
      if (!same(context, finalContext)) problem("refused");
      await requireAuthority(transaction, scope, { kind: "draft_change", rootId: selector.rootId });
      await requireAuthority(transaction, scope, installOperation(selector.rootId, releaseSet));
      const draftDeadline = await readPermissionDeadline(
        transaction, scope, finalContext, "platform.organization.definition_drafts.manage",
      );
      const installationDeadlines = await readInstallationAuthorityDeadlines(
        transaction, scope, finalContext, selector.rootId, releaseSet,
      );
      const checkedAt = await databaseNow(transaction);
      if (Date.parse(checkedAt) >= Math.min(
        Date.parse(finalContext.expiresAt), Date.parse(draftDeadline),
        ...installationDeadlines.map((deadline) => Date.parse(deadline)),
      )) problem("refused");
      return { releaseSet, bindings };
    },
  );
  if (result.kind !== "available") problem(result.kind === "unavailable" ? "refused" : "temporarily_unavailable");
  const { releaseSet, bindings } = result.value;
  const registrationState = firstInstallState(selector, releaseSet, bindings);
  let setup: unknown | null = null;
  if (registrationState === "provisioned_inactive") {
    setup = await readCurrentProvisionedSetup(selector, history, releaseSet, session);
    if (setup === null) firstInstallUnavailable("setup_unavailable");
  }
  const snapshot = firstInstallSnapshot(
    selector, history, releaseSet, bindings, registrationState, setup,
  );
  return {
    selector,
    history,
    historyMetadata: inspected.metadata,
    releaseSet,
    snapshot,
    session,
  };
};

const provisionedSetupAccessDeclaration = (key: string): OrganizationAccessDeclaration => {
  const declaration = permissionDeclaration(key);
  return key === "platform.organization.applications.install_scope"
    ? organizationAccessDeclarationSchema.parse({
        ...declaration,
        authority: {
          kind: "delegated_management",
          before: { kind: "organization_catalogue" },
          after: { kind: "organization_catalogue" },
        },
      })
    : declaration;
};

const readProvisionedSetupAccessDecision = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  key: string,
): Promise<OrganizationAccessDecision> => {
  const result = await runOrganizationAccessOperation(
    transaction,
    scope,
    provisionedSetupAccessDeclaration(key),
    async (decision) => decision,
  );
  if (result.outcome !== "completed") problem("refused");
  const parsed = organizationAccessDecisionSchema.safeParse(result.value);
  if (!parsed.success || parsed.data.outcome !== "allowed" || parsed.data.operationKey !== key ||
    parsed.data.target.kind !== "organization" ||
    !sameUuid(parsed.data.organizationId, scope.organizationId) ||
    !sameUuid(parsed.data.organizationAccountId, scope.organizationAccountId) ||
    parsed.data.accessVersion !== scope.accessVersion)
    problem("refused");
  return parsed.data;
};

const provisionedSetupModulePins = (
  selector: StudioApplicationFirstInstallSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: InstallationBindings,
): readonly Readonly<{ moduleRootId: string; bindingRevision: number }>[] => {
  if (releaseSet.modules.length === 0) firstInstallUnavailable("setup_unavailable");
  const provisioned = bindings.moduleBindings.filter((binding) => binding.state === "provisioned");
  if (provisioned.length !== releaseSet.modules.length ||
    bindings.registeredReleaseRevision !== selector.releaseRevision)
    firstInstallUnavailable("installation_incomplete");
  const pins = provisioned.map((binding) => {
    if (!sameUuid(binding.organizationId, selector.organizationId) ||
      !sameUuid(binding.applicationRootId, selector.rootId) ||
      binding.applicationReleaseRevision !== selector.releaseRevision)
      firstInstallUnavailable("installation_incomplete");
    return { moduleRootId: binding.moduleRootId, bindingRevision: binding.bindingRevision };
  }).sort((left, right) => left.moduleRootId < right.moduleRootId ? -1 : left.moduleRootId > right.moduleRootId ? 1 : 0);
  for (const module of releaseSet.modules) {
    const matches = provisioned.filter((binding) =>
      sameUuid(binding.moduleRootId, module.rootId) &&
      binding.moduleReleaseRevision === module.releaseRevision &&
      binding.applicationReleaseRevision === selector.releaseRevision);
    if (matches.length !== 1) firstInstallUnavailable("installation_incomplete");
  }
  return pins;
};

const recordProvisionedSetupSchema = z.object({
  organizationId: organizationIdSchema,
  applicationRootId: applicationRootIdSchema,
  applicationReleaseRevision: revisionSchema,
  registrationRevision: revisionSchema,
  organizationLimits: organizationLifecycleLimitsSchema,
  targets: z.array(z.object({
    storageContractId: storageContractIdSchema,
    storageScope: z.enum(["application_contained", "organization_shared"]),
    applicationRootId: applicationRootIdSchema.nullable(),
    sourceBindings: z.array(z.object({
      moduleRootId: moduleRootIdSchema,
      moduleReleaseRevision: revisionSchema,
      bindingRevision: revisionSchema,
    }).strict()).min(1).max(10_000),
    policy: z.discriminatedUnion("state", [
      z.object({ state: z.literal("absent") }).strict(),
      z.object({
        state: z.literal("configured"),
        policyId: recordLifecyclePolicyIdSchema,
        policyRevision: revisionSchema,
        policyBody: recordTypeLifecyclePolicySchema,
      }).strict(),
    ]),
  }).strict()).max(10_000),
}).strict();

const visiblePolicyBody = (policy: RecordTypeLifecyclePolicy) => {
  const common = {
    maxAgeDays: policy.maxAgeDays,
    maxCount: policy.maxCount,
    allowUnlimitedAge: policy.allowUnlimitedAge,
    allowUnlimitedCount: policy.allowUnlimitedCount,
  };
  return policy.action === "delete"
    ? {
        ...common,
        action: policy.action,
        ...(policy.recoveryWindowDays === undefined ? {} : { recoveryWindowDays: policy.recoveryWindowDays }),
      }
    : {
        ...common,
        action: policy.action,
        archiveWorkflowId: policy.archiveWorkflowId,
        expectedWorkflowRevision: policy.expectedWorkflowRevision,
        archiveConnectionInstanceId: policy.archiveConnectionInstanceId,
        archiveDestination: policy.archiveDestination,
        expectedConnectionRevision: policy.expectedConnectionRevision,
        expectedConnectionHealthOutcome: policy.expectedConnectionHealthOutcome,
      };
};

const visibleProvisionedSetup = (
  setup: z.infer<typeof recordProvisionedSetupSchema>,
): z.infer<typeof studioApplicationFirstInstallSetupSchema> =>
  studioApplicationFirstInstallSetupSchema.parse({
    ...setup,
    targets: setup.targets.map((target) => ({
      ...target,
      policy: target.policy.state === "absent" ? target.policy : {
        ...target.policy,
        policyBody: visiblePolicyBody(target.policy.policyBody),
      },
    })),
  });

const readProvisionedSetupInternalInTransaction = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  selector: StudioApplicationFirstInstallSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
): Promise<z.infer<typeof recordProvisionedSetupSchema>> => {
  const bindings = await readInstallationBindings(transaction, selector.rootId);
  const expectedModuleBindings = provisionedSetupModulePins(selector, releaseSet, bindings);
  const rows = await transaction.query<DatabaseRow>`
    select vortex_record.read_provisioned_lifecycle_policy_setup(
      ${selector.rootId}::uuid,
      ${selector.releaseRevision}::bigint,
      ${JSON.stringify(expectedModuleBindings)}::text::jsonb
    ) as snapshot
  `;
  const setup = recordProvisionedSetupSchema.safeParse(rows[0]?.snapshot);
  if (rows.length === 1 && setup.success && setup.data.targets.length === 0)
    firstInstallUnavailable("setup_unavailable");
  if (rows.length !== 1 || !setup.success ||
    !sameUuid(setup.data.organizationId, selector.organizationId) ||
    !sameUuid(setup.data.applicationRootId, selector.rootId) ||
    setup.data.applicationReleaseRevision !== selector.releaseRevision ||
    new Set(setup.data.targets.map((target) => target.storageContractId.toLowerCase())).size !==
      setup.data.targets.length ||
    setup.data.targets.some((target) =>
      target.storageScope === "organization_shared"
        ? target.applicationRootId !== null
        : target.applicationRootId === null || !sameUuid(target.applicationRootId, selector.rootId)) ||
    setup.data.targets.some((target) => target.sourceBindings.some((binding) =>
      !expectedModuleBindings.some((pin) => sameUuid(pin.moduleRootId, binding.moduleRootId) &&
        pin.bindingRevision === binding.bindingRevision))))
    problem("refused");
  const exactWorkflowIds = new Set(firstInstallWorkflows(releaseSet).map((workflowId) => workflowId.toLowerCase()));
  if (setup.data.targets.some((target) =>
    target.policy.state === "configured" && target.policy.policyBody.action === "archive_workflow" &&
    (target.policy.policyBody.expectedWorkflowRevision !== selector.releaseRevision ||
      !exactWorkflowIds.has(target.policy.policyBody.archiveWorkflowId.toLowerCase()))))
    firstInstallUnavailable("setup_unavailable");

  const context = await readHumanContext(transaction, scope, session, issuedAt, {
    organizationId: selector.organizationId,
    applicationRootId: selector.rootId,
  });
  const decisions = await Promise.all([
    readProvisionedSetupAccessDecision(transaction, scope, "platform.organization.applications.install"),
    readProvisionedSetupAccessDecision(transaction, scope, "platform.organization.applications.install_scope"),
    readProvisionedSetupAccessDecision(transaction, scope, "platform.organization.record_lifecycle.manage_policy"),
  ]);
  const finalContext = await readHumanContext(transaction, scope, session, issuedAt, {
    organizationId: selector.organizationId,
    applicationRootId: selector.rootId,
  });
  if (!same(context, finalContext)) problem("refused");
  const completion = await databaseNow(transaction);
  const completionMs = Date.parse(completion);
  if (decisions.some((decision) =>
    !sameUuid(decision.correlationId, context.correlationId) ||
    decision.accessVersion !== context.accessVersion ||
    Date.parse(decision.checkedAt) > completionMs ||
    Date.parse(decision.validUntil) <= completionMs) ||
    Date.parse(context.expiresAt) <= completionMs)
    problem("refused");
  const limits = organizationLifecycleLimitsSchema.safeParse(setup.data.organizationLimits);
  if (!limits.success || !sameUuid(limits.data.organizationId, selector.organizationId))
    problem("refused");
  const exactProvisionedBindings = new Map(bindings.moduleBindings
    .filter((binding) => binding.state === "provisioned")
    .map((binding) => [binding.moduleRootId.toLowerCase(), binding]));
  for (const target of setup.data.targets) {
    const targetBindings = new Set<string>();
    for (const sourceBinding of target.sourceBindings) {
      const key = sourceBinding.moduleRootId.toLowerCase();
      const expected = exactProvisionedBindings.get(key);
      if (expected === undefined || targetBindings.has(key) ||
        !sameUuid(expected.moduleRootId, sourceBinding.moduleRootId) ||
        expected.moduleReleaseRevision !== sourceBinding.moduleReleaseRevision ||
        expected.bindingRevision !== sourceBinding.bindingRevision)
        problem("refused");
      targetBindings.add(key);
    }
  }
  return setup.data;
};

const readProvisionedSetupInTransaction = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  selector: StudioApplicationFirstInstallSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
): Promise<z.infer<typeof studioApplicationFirstInstallSetupSchema>> =>
  visibleProvisionedSetup(await readProvisionedSetupInternalInTransaction(
    transaction, scope, session, issuedAt, selector, releaseSet,
  ));

const readCurrentProvisionedSetup = async (
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  expectedReleaseSet: SystemApplicationBoundReleaseSetResult,
  session: IdentitySession,
): Promise<z.infer<typeof studioApplicationFirstInstallSetupSchema> | null> => {
  let callbackFailure: unknown;
  const result = await humanOrganizationRequests().runChange(
    session,
    { organizationId: selector.organizationId, applicationRootId: selector.rootId },
    async (transaction, scope, issuedAt) => {
      try {
        const context = await readHumanContext(transaction, scope, session, issuedAt, {
          organizationId: selector.organizationId,
          applicationRootId: selector.rootId,
        });
        await readOrdinaryRoot(transaction, selector.rootId);
        await requireAuthority(transaction, scope, { kind: "draft_change", rootId: selector.rootId });
        await firstInstallHistoryMatchesDraft(
          transaction, scope, selector, history, expectedReleaseSet.application.definitionKey,
        );
        const currentCandidate = await createDatabaseApplicationBoundReleaseSetService(
          installedReleaseCatalogue,
          transaction,
        ).read({ applicationReleaseRevision: selector.releaseRevision });
        const currentRelease = systemApplicationBoundReleaseSetResultSchema.safeParse(currentCandidate);
        if (!currentRelease.success ||
          !sameUuid(currentRelease.data.application.organizationId, selector.organizationId) ||
          !sameUuid(currentRelease.data.application.rootId, selector.rootId) ||
          !sameFirstInstallRelease(currentRelease.data, expectedReleaseSet))
          problem("conflict");
        await requireAuthority(transaction, scope, installOperation(selector.rootId, currentRelease.data));
        const setup = await readProvisionedSetupInTransaction(
          transaction, scope, session, issuedAt, selector, currentRelease.data,
        );
        await firstInstallHistoryMatchesDraft(
          transaction, scope, selector, history, expectedReleaseSet.application.definitionKey,
        );
        await firstInstallAppCompletion(
          transaction, scope, session, issuedAt, selector, history, currentRelease.data, context,
        );
        return setup;
      } catch (error) {
        callbackFailure = error;
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (callbackFailure !== undefined) throw callbackFailure;
  if (result.kind === "unavailable") problem("refused");
  problem("temporarily_unavailable");
};

export const loadStudioApplicationFirstInstall = async (
  organizationIdCandidate: string,
  selectorCandidate: unknown,
): Promise<StudioApplicationFirstInstallLoadResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const selector = studioApplicationFirstInstallSelectorSchema.safeParse(selectorCandidate);
  if (!organizationId.success || !selector.success ||
    !sameUuid(organizationId.data, selector.data.organizationId))
    return studioApplicationFirstInstallLoadResultSchema.parse({ kind: "refused" });
  try {
    const current = await readCurrentFirstInstallCandidate(selector.data);
    return studioApplicationFirstInstallLoadResultSchema.parse({
      kind: "available",
      snapshot: current.snapshot,
    });
  } catch (error) {
    return firstInstallLoadFailure(error);
  }
};

const firstInstallDefinitionAccess = (
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  expectedReleaseSet: SystemApplicationBoundReleaseSetResult,
): HumanInstallationDefinitionAccess => ({
  async readReleaseSet(session, target) {
    if (!sameUuid(target.organizationId, selector.organizationId) ||
      !sameUuid(target.applicationRootId, selector.rootId) ||
      target.applicationReleaseRevision !== selector.releaseRevision)
      throw new ApplicationInstallationCoordinatorError("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
    let callbackFailure: unknown;
    const result = await humanOrganizationRequests().runChange(
      session,
      { organizationId: selector.organizationId },
      async (transaction, scope, issuedAt) => {
        try {
          if (scope.applicationRootId !== undefined) problem("refused");
          const context = await readHumanContext(transaction, scope, session, issuedAt, {
            organizationId: selector.organizationId,
          });
          await readOrdinaryRoot(transaction, selector.rootId);
          await requireAuthority(transaction, scope, { kind: "draft_change", rootId: selector.rootId });
          await firstInstallHistoryMatchesDraft(
            transaction, scope, selector, history, expectedReleaseSet.application.definitionKey,
          );
          const releaseSet = await readFirstInstallReleaseSet(transaction, selector, context);
          if (!sameFirstInstallRelease(releaseSet, expectedReleaseSet)) problem("conflict");
          await firstInstallHistoryMatchesDraft(
            transaction, scope, selector, history, expectedReleaseSet.application.definitionKey,
          );
          const finalContext = await readHumanContext(transaction, scope, session, issuedAt, {
            organizationId: selector.organizationId,
          });
          if (!same(context, finalContext)) problem("refused");
          await requireAuthority(transaction, scope, { kind: "draft_change", rootId: selector.rootId });
          await requireAuthority(transaction, scope, installOperation(selector.rootId, releaseSet));
          const draftDeadline = await readPermissionDeadline(
            transaction, scope, finalContext, "platform.organization.definition_drafts.manage",
          );
          const installDeadlines = await readInstallationAuthorityDeadlines(
            transaction, scope, finalContext, selector.rootId, releaseSet,
          );
          const completedAt = await databaseNow(transaction);
          if (Date.parse(completedAt) >= Math.min(
            Date.parse(finalContext.expiresAt), Date.parse(draftDeadline),
            ...installDeadlines.map((deadline) => Date.parse(deadline)),
          )) problem("refused");
          return releaseSet;
        } catch (error) {
          callbackFailure = error;
          throw error;
        }
      },
    );
    if (result.kind !== "available") {
      if (callbackFailure !== undefined) throw callbackFailure;
      throw new ApplicationInstallationCoordinatorError("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
    }
    return result.value;
  },
  async prepareRegistrationCandidate(target, releaseSet) {
    if (!sameUuid(target.organizationId, selector.organizationId) ||
      !sameUuid(target.applicationRootId, selector.rootId) ||
      target.applicationReleaseRevision !== selector.releaseRevision ||
      !sameFirstInstallRelease(releaseSet, expectedReleaseSet))
      throw new ApplicationInstallationCoordinatorError("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE");
    return prepareApplicationRoleTemplatesForHumanRequest(
      target.organizationId,
      { applicationRootId: target.applicationRootId, releaseRevision: target.applicationReleaseRevision },
      releaseSet,
    );
  },
});

const exactFirstInstallBindings = (
  selector: StudioApplicationFirstInstallSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: InstallationBindings,
  state: "active" | "provisioned",
): boolean => {
  const relevant = bindings.moduleBindings.filter((binding) => binding.state !== "detached");
  return bindings.registeredReleaseRevision === selector.releaseRevision &&
    relevant.length === releaseSet.modules.length &&
    releaseSet.modules.every((module) => relevant.filter((binding) =>
      sameUuid(binding.organizationId, selector.organizationId) &&
      sameUuid(binding.applicationRootId, selector.rootId) &&
      sameUuid(binding.moduleRootId, module.rootId) &&
      binding.applicationReleaseRevision === selector.releaseRevision &&
      binding.moduleReleaseRevision === module.releaseRevision && binding.state === state).length === 1);
};

const sameFirstInstallBindings = (
  left: InstallationBindings,
  right: readonly ModuleInstallationBindingEvidence[],
): boolean => same(sortedBindingTuples(left.moduleBindings), sortedBindingTuples(right));

const assertFirstInstallCoordinatorBoundary = (
  mode: "prepare" | "activate",
  phase: "before" | "after_first" | "after_final",
  selector: StudioApplicationFirstInstallSelector,
  expected: StudioApplicationFirstInstallSnapshot,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: InstallationBindings,
): void => {
  if (!sameFirstInstallBindings(bindings, expected.moduleBindings)) {
    if (!(phase === "after_final" && mode === "prepare" &&
      exactFirstInstallBindings(selector, releaseSet, bindings, "provisioned")) &&
      !(phase === "after_final" && mode === "activate" &&
        exactFirstInstallBindings(selector, releaseSet, bindings, "active")))
      problem("conflict");
  }
  if (phase === "before" && mode === "prepare" &&
    expected.registrationState !== "unprepared" &&
    expected.registrationState !== "registration_aligned_partial")
    problem("conflict");
  if (phase === "before" && mode === "activate" &&
    expected.registrationState !== "provisioned_inactive")
    problem("conflict");
  if ((phase === "after_first" || (phase === "before" && mode === "activate")) &&
    bindings.registeredReleaseRevision !== selector.releaseRevision)
    problem("conflict");
  if (phase === "after_final") {
    const expectedState = mode === "prepare" ? "provisioned" : "active";
    if (!exactFirstInstallBindings(selector, releaseSet, bindings, expectedState))
      problem("conflict");
  }
};

const firstInstallCoordinator = (
  selector: StudioApplicationFirstInstallSelector,
  expected: StudioApplicationFirstInstallSnapshot,
  expectedReleaseSet: SystemApplicationBoundReleaseSetResult,
  mode: "prepare" | "activate",
) => {
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
      const currentStep = step++;
      if (currentStep > 1) problem("temporarily_unavailable");
      let callbackFailure: unknown;
      const result = await requests.runChange(session, candidate, async (transaction, scope, issuedAt) => {
        try {
          if (!sameUuid(candidate.organizationId, selector.organizationId) ||
            candidate.applicationRootId !== undefined || scope.applicationRootId !== undefined)
            problem("refused");
          const context = await readHumanContext(transaction, scope, session, issuedAt, {
            organizationId: selector.organizationId,
          });
          await readOrdinaryRoot(transaction, selector.rootId);
          await requireAuthority(transaction, scope, { kind: "draft_change", rootId: selector.rootId });
          await firstInstallHistoryMatchesDraft(
            transaction, scope, selector, expected.history, expected.selected.definitionKey,
          );
          const releaseSet = await readFirstInstallReleaseSet(transaction, selector, context);
          if (!sameFirstInstallRelease(releaseSet, expectedReleaseSet)) problem("conflict");
          await requireAuthority(transaction, scope, installOperation(selector.rootId, releaseSet));
          const before = await readInstallationBindings(transaction, selector.rootId);
          if (currentStep === 0 && mode === "prepare" &&
            before.registeredReleaseRevision !== expected.registeredReleaseRevision)
            problem("conflict");
          if (!sameFirstInstallBindings(before, expected.moduleBindings)) problem("conflict");
          assertFirstInstallCoordinatorBoundary(
            mode, currentStep === 0 ? "before" : "after_first", selector, expected, releaseSet, before,
          );
          const value = await operation(transaction, scope, issuedAt);
          const after = await readInstallationBindings(transaction, selector.rootId);
          if (currentStep === 0) {
            if (after.registeredReleaseRevision !== selector.releaseRevision ||
              !sameFirstInstallBindings(after, expected.moduleBindings)) problem("conflict");
            assertFirstInstallCoordinatorBoundary(
              mode, "after_first", selector, expected, releaseSet, after,
            );
          } else {
            assertFirstInstallCoordinatorBoundary(
              mode, "after_final", selector, expected, releaseSet, after,
            );
          }
          await firstInstallHistoryMatchesDraft(
            transaction, scope, selector, expected.history, expected.selected.definitionKey,
          );
          const finalContext = await readHumanContext(transaction, scope, session, issuedAt, {
            organizationId: selector.organizationId,
          });
          if (!same(context, finalContext)) problem("refused");
          if (currentStep === 0) {
            const completedAt = await databaseNow(transaction);
            if (Date.parse(finalContext.expiresAt) <= Date.parse(completedAt)) problem("refused");
            return value;
          }
          await requireAuthority(transaction, scope, { kind: "draft_change", rootId: selector.rootId });
          await requireAuthority(transaction, scope, installOperation(selector.rootId, releaseSet));
          const draftDeadline = await readPermissionDeadline(
            transaction, scope, finalContext, "platform.organization.definition_drafts.manage",
          );
          const installDeadlines = await readInstallationAuthorityDeadlines(
            transaction, scope, finalContext, selector.rootId, releaseSet,
          );
          const completedAt = await databaseNow(transaction);
          if (Date.parse(completedAt) >= Math.min(
            Date.parse(finalContext.expiresAt), Date.parse(draftDeadline),
            ...installDeadlines.map((deadline) => Date.parse(deadline)),
          )) problem("refused");
          return value;
        } catch (error) {
          callbackFailure = error;
          throw error;
        }
      });
      if (callbackFailure !== undefined && result.kind !== "available") throw callbackFailure;
      return result;
    },
  };
  return createApplicationInstallationCoordinator({
    installerRequests,
    resolveModuleContributions,
    builderAuthority: (transaction, scope) => createBuilderAuthority({ transaction, scope, targetFacts }),
    containsCustomComponents: releaseSetContainsCustomComponents,
    humanDefinitionAccess: firstInstallDefinitionAccess(selector, expected.history, expectedReleaseSet),
  });
};

const sameFirstInstallExpectation = (
  expected: StudioApplicationFirstInstallSnapshot,
  actual: StudioApplicationFirstInstallSnapshot,
): boolean => same(expected, actual);

export const prepareStudioApplicationFirstInstall = async (
  organizationIdCandidate: string,
  commandCandidate: unknown,
): Promise<StudioApplicationFirstInstallCommandResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const command = studioApplicationFirstInstallPrepareCommandSchema.safeParse(commandCandidate);
  if (!organizationId.success || !command.success ||
    !sameUuid(organizationId.data, command.data.selector.organizationId) ||
    !sameUuid(command.data.expected.organizationId, command.data.selector.organizationId) ||
    !sameUuid(command.data.expected.rootId, command.data.selector.rootId) ||
    command.data.expected.selected.releaseRevision !== command.data.selector.releaseRevision)
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "refused", stateMayHaveChanged: false,
    });
  let invocationStarted = false;
  try {
    const current = await readCurrentFirstInstallCandidate(command.data.selector);
    if (!sameFirstInstallExpectation(command.data.expected, current.snapshot))
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    if (current.snapshot.registrationState !== "unprepared" &&
      current.snapshot.registrationState !== "registration_aligned_partial")
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    const coordinator = firstInstallCoordinator(
      current.selector, current.snapshot, current.releaseSet, "prepare",
    );
    invocationStarted = true;
    const outcome = await coordinator.prepare(current.session, {
      organizationId: current.selector.organizationId,
      applicationRootId: current.selector.rootId,
      applicationReleaseRevision: current.selector.releaseRevision,
    });
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "completed",
      action: "prepared",
      stateMayHaveChanged: outcome.outcome === "prepared",
    });
  } catch (error) {
    return firstInstallCommandFailure(error, invocationStarted ? "unknown" : false);
  }
};

const archiveOptionsFailure = (error: unknown): StudioApplicationArchiveOptionsResult => {
  const failure = safeFailure(error);
  if (failure.kind === "conflict")
    return studioApplicationArchiveOptionsResultSchema.parse({ kind: "conflict" });
  if (failure.kind === "refused" || failure.kind === "authentication_required")
    return studioApplicationArchiveOptionsResultSchema.parse({ kind: "refused" });
  return studioApplicationArchiveOptionsResultSchema.parse({ kind: "temporarily_unavailable" });
};

export const loadStudioApplicationArchiveOptions = async (
  organizationIdCandidate: string,
  queryCandidate: unknown,
): Promise<StudioApplicationArchiveOptionsResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const query = studioApplicationArchiveOptionsQuerySchema.safeParse(queryCandidate);
  if (!organizationId.success || !query.success ||
    !sameUuid(organizationId.data, query.data.selector.organizationId) ||
    !sameUuid(query.data.expected.organizationId, query.data.selector.organizationId) ||
    !sameUuid(query.data.expected.rootId, query.data.selector.rootId) ||
    query.data.expected.selected.releaseRevision !== query.data.selector.releaseRevision)
    return studioApplicationArchiveOptionsResultSchema.parse({ kind: "refused" });
  try {
    const current = await readCurrentFirstInstallCandidate(query.data.selector);
    if (!sameFirstInstallExpectation(query.data.expected, current.snapshot))
      return studioApplicationArchiveOptionsResultSchema.parse({ kind: "conflict" });
    const result = await runFirstInstallAppTransaction(
      current,
      query.data.expected,
      async (transaction, _scope, _issuedAt, initial) => {
        const target = currentTarget(initial.setup, query.data.storageContractId);
        if (target.policy.state !== "absent" || target.storageScope !== "application_contained" ||
          target.applicationRootId === null || !initial.setup.organizationLimits.allowedActions.includes("archive_workflow") ||
          initial.setup.organizationLimits.allowedArchiveDestinations.length === 0)
          problem("refused");
        const finalSetup = await readProvisionedSetupInternalInTransaction(
          transaction, _scope, current.session, _issuedAt, query.data.selector, initial.releaseSet,
        );
        if (!same(finalSetup, initial.internalSetup)) problem("conflict");
        const currentRelease = await readAppScopedFirstInstallReleaseSet(transaction, query.data.selector);
        if (!sameFirstInstallRelease(currentRelease, initial.releaseSet)) problem("conflict");
        await firstInstallAppCompletion(
          transaction, _scope, current.session, _issuedAt, query.data.selector,
          query.data.expected.history, currentRelease, initial.context,
        );
        const page = await listEligibleArchiveConnectionsForApplication(
          transaction,
          query.data.selector.organizationId,
          query.data.selector.rootId,
          initial.setup.organizationLimits.allowedArchiveDestinations,
          {
            pageSize: 100,
            ...(query.data.afterConnectionInstanceId === undefined
              ? {}
              : { afterConnectionInstanceId: query.data.afterConnectionInstanceId }),
          },
        );
        if (page.outcome !== "available") {
          if (page.reasonCode === "not_authorized" || page.reasonCode === "invalid_parameters")
            problem("refused");
          if (page.reasonCode === "stale_page") problem("conflict");
          problem("temporarily_unavailable");
        }
        return studioApplicationArchiveOptionsResultSchema.parse({
          kind: "available",
          options: page.options.map(({ destinationFingerprint: _privateFingerprint, ...option }) => option),
          ...(page.nextAfterConnectionInstanceId === undefined
            ? {}
            : { nextAfterConnectionInstanceId: page.nextAfterConnectionInstanceId }),
        });
      },
      true,
    );
    return result;
  } catch (error) {
    return archiveOptionsFailure(error);
  }
};

const saveDeleteInitialPolicy = async (
  candidate: FirstInstallCandidate,
  target: z.infer<typeof studioApplicationFirstInstallTargetSchema>,
  expectedBindingRevision: number,
  expectedSettingsRevision: number,
  policy: Extract<z.infer<typeof studioApplicationFirstInstallPolicyInputSchema>, { action: "delete" }>,
): Promise<RecordTypeLifecyclePolicy> => {
  if (!target.sourceBindings.some((binding) => binding.bindingRevision === expectedBindingRevision))
    problem("conflict");
  const service = createRecordTypeLifecyclePolicyService(humanOrganizationRequestDependencies());
  const result = await service.saveInitialForProvisionedSetup(candidate.session, initialPolicyCommand(
    candidate, target, expectedBindingRevision, expectedSettingsRevision, policy,
  ));
  if (result.kind !== "available") {
    if (result.kind === "unavailable") problem("refused");
    problem("temporarily_unavailable");
  }
  return initialPolicyMatches(result.value, candidate, target, policy);
};

const workflowIsInExactRelease = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
  applicationRootId: string,
  workflowId: string,
): boolean => releaseSet.application.dependencyManifest.some((dependency) =>
  dependency.kind === "application_workflow" &&
  sameUuid(dependency.applicationRootId, applicationRootId) &&
  sameUuid(dependency.workflowId, workflowId));

const writeInitialArchivePolicy = async (
  transaction: RequestDatabaseTransaction,
  candidate: FirstInstallCandidate,
  target: z.infer<typeof studioApplicationFirstInstallTargetSchema>,
  expectedBindingRevision: number,
  expectedSettingsRevision: number,
  actionInput: Extract<z.infer<typeof studioApplicationFirstInstallPolicyInputSchema>, { action: "archive_workflow" }>,
  option: Awaited<ReturnType<typeof readSelectedEligibleArchiveConnection>>,
): Promise<RecordTypeLifecyclePolicy> => {
  if (target.applicationRootId === null ||
    !workflowIsInExactRelease(candidate.releaseSet, candidate.selector.rootId, actionInput.archiveWorkflowId))
    problem("refused");
  const bindings = target.sourceBindings.filter((binding) => binding.bindingRevision === expectedBindingRevision);
  if (bindings.length !== 1) problem("conflict");
  const policy = {
    action: "archive_workflow" as const,
    maxAgeDays: actionInput.maxAgeDays,
    maxCount: actionInput.maxCount,
    allowUnlimitedAge: actionInput.allowUnlimitedAge,
    allowUnlimitedCount: actionInput.allowUnlimitedCount,
    archiveWorkflowId: actionInput.archiveWorkflowId,
    expectedWorkflowRevision: candidate.selector.releaseRevision,
    archiveConnectionInstanceId: option.connectionInstanceId,
    archiveDestination: option.destinationKey,
    expectedConnectionRevision: option.expectedRevision,
    expectedDestinationFingerprint: option.destinationFingerprint,
    expectedConnectionHealthOutcome: "healthy" as const,
  };
  const activityId = activityIdSchema.parse(randomUUID());
  await transaction.query`set local role vortex_runtime`;
  const rows = await transaction.query<DatabaseRow>`
    select vortex_record.save_initial_record_type_lifecycle_policy_for_provisioned_setup(
      ${candidate.selector.rootId}::uuid,
      ${expectedBindingRevision}::bigint,
      ${target.storageContractId}::uuid,
      ${target.applicationRootId}::uuid,
      ${expectedSettingsRevision}::bigint,
      ${activityId}::uuid,
      ${JSON.stringify(policy)}::text::jsonb
    ) as policy
  `;
  if (rows.length !== 1) problem("temporarily_unavailable");
  return initialPolicyMatches(rows[0]?.policy, candidate, target, actionInput, option.destinationFingerprint);
};

const readAppScopedFirstInstallReleaseSet = async (
  transaction: RequestDatabaseTransaction,
  selector: StudioApplicationFirstInstallSelector,
): Promise<SystemApplicationBoundReleaseSetResult> => {
  let candidate: unknown;
  try {
    candidate = await createDatabaseApplicationBoundReleaseSetService(
      installedReleaseCatalogue,
      transaction,
    ).read({ applicationReleaseRevision: selector.releaseRevision });
  } catch (error) {
    if (!(error instanceof DefinitionConsumerReadError) || error.code === "DEFINITION_READ_FAILED")
      problem("temporarily_unavailable");
    problem("refused");
  }
  const parsed = systemApplicationBoundReleaseSetResultSchema.safeParse(candidate);
  if (!parsed.success || !sameUuid(parsed.data.application.organizationId, selector.organizationId) ||
    !sameUuid(parsed.data.application.rootId, selector.rootId) ||
    parsed.data.application.releaseRevision !== selector.releaseRevision ||
    parsed.data.modules.length === 0)
    firstInstallUnavailable("setup_unavailable");
  return parsed.data;
};

const firstInstallAppCompletion = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  initialContext: HumanContext,
): Promise<void> => {
  await firstInstallHistoryMatchesDraft(
    transaction, scope, selector, history, releaseSet.application.definitionKey,
  );
  await readOrdinaryRoot(transaction, selector.rootId);
  await requireAuthority(transaction, scope, { kind: "draft_change", rootId: selector.rootId });
  await requireAuthority(transaction, scope, installOperation(selector.rootId, releaseSet));
  const finalContext = await readHumanContext(transaction, scope, session, issuedAt, {
    organizationId: selector.organizationId,
    applicationRootId: selector.rootId,
  });
  if (!same(initialContext, finalContext)) problem("refused");
  const draftDeadline = await readPermissionDeadline(
    transaction, scope, finalContext, "platform.organization.definition_drafts.manage",
  );
  const installDeadlines = await readInstallationAuthorityDeadlines(
    transaction, scope, finalContext, selector.rootId, releaseSet,
  );
  const setupDecisions = await Promise.all([
    readProvisionedSetupAccessDecision(transaction, scope, "platform.organization.applications.install"),
    readProvisionedSetupAccessDecision(transaction, scope, "platform.organization.applications.install_scope"),
    readProvisionedSetupAccessDecision(transaction, scope, "platform.organization.record_lifecycle.manage_policy"),
  ]);
  const completedAt = await databaseNow(transaction);
  if (Date.parse(completedAt) >= Math.min(
    Date.parse(finalContext.expiresAt), Date.parse(draftDeadline),
    ...installDeadlines.map((deadline) => Date.parse(deadline)),
  ) || setupDecisions.some((decision) =>
    !sameUuid(decision.correlationId, finalContext.correlationId) ||
    decision.accessVersion !== finalContext.accessVersion ||
    Date.parse(decision.checkedAt) > Date.parse(completedAt) ||
    Date.parse(decision.validUntil) <= Date.parse(completedAt))) problem("refused");
}

type FirstInstallAppState = Readonly<{
  context: HumanContext;
  releaseSet: SystemApplicationBoundReleaseSetResult;
  bindings: InstallationBindings;
  setup: z.infer<typeof studioApplicationFirstInstallSetupSchema>;
  internalSetup: z.infer<typeof recordProvisionedSetupSchema>;
}>;

const readFirstInstallAppState = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  selector: StudioApplicationFirstInstallSelector,
  expected: StudioApplicationFirstInstallSnapshot,
): Promise<FirstInstallAppState> => {
  const context = await readHumanContext(transaction, scope, session, issuedAt, {
    organizationId: selector.organizationId,
    applicationRootId: selector.rootId,
  });
  await readOrdinaryRoot(transaction, selector.rootId);
  await requireAuthority(transaction, scope, { kind: "draft_change", rootId: selector.rootId });
  await firstInstallHistoryMatchesDraft(
    transaction, scope, selector, expected.history, expected.selected.definitionKey,
  );
  const releaseSet = await readAppScopedFirstInstallReleaseSet(transaction, selector);
  if (!same(firstInstallSelectedIdentity(releaseSet), expected.selected) ||
    !same(firstInstallWorkflows(releaseSet), expected.workflows)) problem("conflict");
  await requireAuthority(transaction, scope, installOperation(selector.rootId, releaseSet));
  const bindings = await readInstallationBindings(transaction, selector.rootId);
  const state = firstInstallState(selector, releaseSet, bindings);
  if (state !== "provisioned_inactive") firstInstallUnavailable("installation_incomplete");
  const internalSetup = await readProvisionedSetupInternalInTransaction(
    transaction, scope, session, issuedAt, selector, releaseSet,
  );
  const setup = visibleProvisionedSetup(internalSetup);
  const current = firstInstallSnapshot(selector, expected.history, releaseSet, bindings, state, setup);
  if (!sameFirstInstallExpectation(expected, current)) problem("conflict");
  return { context, releaseSet, bindings, setup, internalSetup };
};

type FirstInstallTransactionAction<Value> = (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  issuedAt: string,
  initial: FirstInstallAppState,
) => Promise<Value>;

const runFirstInstallAppTransaction = async <Value>(
  candidate: FirstInstallCandidate,
  expected: StudioApplicationFirstInstallSnapshot,
  action: FirstInstallTransactionAction<Value>,
  actionIsFinalDatabaseOperation = false,
): Promise<Value> => {
  let callbackFailure: unknown;
  const result = await humanOrganizationRequests().runChange(
    candidate.session,
    { organizationId: candidate.selector.organizationId, applicationRootId: candidate.selector.rootId },
    async (transaction, scope, issuedAt) => {
      try {
        const initial = await readFirstInstallAppState(
          transaction, scope, candidate.session, issuedAt, candidate.selector, expected,
        );
        const value = await action(transaction, scope, issuedAt, initial);
        if (!actionIsFinalDatabaseOperation) {
          const currentRelease = await readAppScopedFirstInstallReleaseSet(transaction, candidate.selector);
          if (!sameFirstInstallRelease(currentRelease, initial.releaseSet)) problem("conflict");
          await firstInstallAppCompletion(
            transaction, scope, candidate.session, issuedAt, candidate.selector,
            expected.history, currentRelease, initial.context,
          );
        }
        return value;
      } catch (error) {
        callbackFailure = error;
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (callbackFailure !== undefined) throw callbackFailure;
  if (result.kind === "unavailable") problem("refused");
  problem("temporarily_unavailable");
};

const currentTarget = (
  setup: z.infer<typeof studioApplicationFirstInstallSetupSchema>,
  storageContractId: StorageContractId,
) => {
  const matching = setup.targets.filter((target) => sameUuid(target.storageContractId, storageContractId));
  if (matching.length !== 1) problem("conflict");
  const target = matching[0];
  if (target === undefined) problem("conflict");
  return target;
};

const assertPolicyCommonFields = (
  policy: z.infer<typeof studioApplicationFirstInstallPolicyInputSchema>,
  limits: OrganizationLifecycleLimits,
): void => {
  if (!limits.allowedActions.includes(policy.action) ||
    (policy.allowUnlimitedAge && policy.maxAgeDays !== null) ||
    (!policy.allowUnlimitedAge && policy.maxAgeDays === null) ||
    (policy.allowUnlimitedCount && policy.maxCount !== null) ||
    (!policy.allowUnlimitedCount && policy.maxCount === null) ||
    (policy.maxAgeDays !== null && limits.maxRetentionDays !== null &&
      limits.maxRetentionDays !== undefined && policy.maxAgeDays > limits.maxRetentionDays) ||
    (policy.maxCount !== null && limits.maxRecordCount !== null &&
      limits.maxRecordCount !== undefined && policy.maxCount > limits.maxRecordCount) ||
    (policy.allowUnlimitedAge && !limits.allowUnlimitedRetentionDays) ||
    (policy.allowUnlimitedCount && !limits.allowUnlimitedRecordCount))
    problem("refused");
};

const initialPolicyCommand = (
  candidate: FirstInstallCandidate,
  target: z.infer<typeof studioApplicationFirstInstallTargetSchema>,
  expectedBindingRevision: number,
  expectedSettingsRevision: number,
  policy: z.infer<typeof studioApplicationFirstInstallPolicyInputSchema>,
) => ({
  organizationId: candidate.selector.organizationId,
  bindingApplicationRootId: candidate.selector.rootId,
  expectedBindingRevision,
  storageContractId: target.storageContractId,
  applicationRootId: target.applicationRootId,
  expectedSettingsRevision,
  policy,
});

const initialPolicyMatches = (
  storedCandidate: unknown,
  candidate: FirstInstallCandidate,
  target: z.infer<typeof studioApplicationFirstInstallTargetSchema>,
  actionInput: z.infer<typeof studioApplicationFirstInstallPolicyInputSchema>,
  expectedConnectionFingerprint?: string,
): RecordTypeLifecyclePolicy => {
  const stored = recordTypeLifecyclePolicySchema.safeParse(storedCandidate);
  if (!stored.success || !sameUuid(stored.data.organizationId, candidate.selector.organizationId) ||
    !sameUuid(stored.data.storageContractId, target.storageContractId) ||
    (stored.data.applicationRootId === null) !== (target.applicationRootId === null) ||
    (stored.data.applicationRootId !== null && target.applicationRootId !== null &&
      !sameUuid(stored.data.applicationRootId, target.applicationRootId)) ||
    stored.data.policyRevision !== 1 || stored.data.action !== actionInput.action ||
    stored.data.maxAgeDays !== actionInput.maxAgeDays || stored.data.maxCount !== actionInput.maxCount ||
    stored.data.allowUnlimitedAge !== actionInput.allowUnlimitedAge ||
    stored.data.allowUnlimitedCount !== actionInput.allowUnlimitedCount)
    problem("temporarily_unavailable");
  if (stored.data.action === "delete") {
    if (actionInput.action !== "delete" ||
      stored.data.recoveryWindowDays !== actionInput.recoveryWindowDays)
      problem("temporarily_unavailable");
  } else {
    if (actionInput.action !== "archive_workflow" || expectedConnectionFingerprint === undefined ||
      !sameUuid(stored.data.archiveWorkflowId, actionInput.archiveWorkflowId) ||
      stored.data.expectedWorkflowRevision !== candidate.selector.releaseRevision ||
      !sameUuid(stored.data.archiveConnectionInstanceId, actionInput.archiveConnectionInstanceId) ||
      stored.data.archiveDestination !== actionInput.archiveDestination ||
      stored.data.expectedConnectionRevision !== actionInput.expectedConnectionRevision ||
      stored.data.expectedDestinationFingerprint !== expectedConnectionFingerprint ||
      stored.data.expectedConnectionHealthOutcome !== "healthy")
      problem("temporarily_unavailable");
  }
  return stored.data;
};

const readSelectedEligibleArchiveConnection = async (
  transaction: RequestDatabaseTransaction,
  selector: StudioApplicationFirstInstallSelector,
  limits: OrganizationLifecycleLimits,
  candidate: Extract<z.infer<typeof studioApplicationFirstInstallPolicyInputSchema>, { action: "archive_workflow" }>,
) => {
  if (candidate === undefined) problem("refused");
  let after: ReturnType<typeof connectionInstanceIdSchema.parse> | undefined;
  const seen = new Set<string>();
  let scannedPageCount = 0;
  while (scannedPageCount < 100) {
    const page = await listEligibleArchiveConnectionsForApplication(
      transaction,
      selector.organizationId,
      selector.rootId,
      limits.allowedArchiveDestinations,
      { pageSize: 100, ...(after === undefined ? {} : { afterConnectionInstanceId: after }) },
    );
    if (page.outcome !== "available") {
      if (page.reasonCode === "not_authorized" || page.reasonCode === "invalid_parameters") problem("refused");
      if (page.reasonCode === "stale_page") problem("conflict");
      problem("temporarily_unavailable");
    }
    const option = page.options.find((entry) =>
      sameUuid(entry.connectionInstanceId, candidate.archiveConnectionInstanceId));
    if (option !== undefined) {
      if (option.expectedRevision !== candidate.expectedConnectionRevision ||
        option.destinationKey !== candidate.archiveDestination)
        problem("conflict");
      return option;
    }
    if (page.nextAfterConnectionInstanceId === undefined) problem("refused");
    const next = page.nextAfterConnectionInstanceId;
    const nextKey = next.toLowerCase();
    if (seen.has(nextKey) || (after !== undefined && nextKey <= after.toLowerCase())) problem("conflict");
    seen.add(nextKey);
    after = next;
    scannedPageCount += 1;
  }
  problem("temporarily_unavailable");
};

const firstInstallCommandMatches = (
  organizationId: string,
  selector: StudioApplicationFirstInstallSelector,
  expected: StudioApplicationFirstInstallSnapshot,
): boolean => sameUuid(organizationId, selector.organizationId) &&
  sameUuid(expected.organizationId, selector.organizationId) &&
  sameUuid(expected.rootId, selector.rootId) &&
  expected.selected.releaseRevision === selector.releaseRevision;

const assertInitialPolicyTarget = (
  setup: z.infer<typeof studioApplicationFirstInstallSetupSchema>,
  command: z.infer<typeof studioApplicationFirstInstallSaveCommandSchema>,
): z.infer<typeof studioApplicationFirstInstallTargetSchema> => {
  const target = currentTarget(setup, command.storageContractId);
  if ((target.applicationRootId === null) !== (command.targetApplicationRootId === null) ||
    (target.applicationRootId !== null && command.targetApplicationRootId !== null &&
      !sameUuid(target.applicationRootId, command.targetApplicationRootId)) ||
    target.policy.state !== "absent" ||
    setup.organizationLimits.settingsRevision !== command.expectedSettingsRevision ||
    !target.sourceBindings.some((binding) =>
      binding.bindingRevision === command.expectedBindingRevision))
    problem("conflict");
  assertPolicyCommonFields(command.policy, setup.organizationLimits);
  if (command.policy.action === "archive_workflow" &&
    (target.storageScope !== "application_contained" ||
      target.applicationRootId === null ||
      !sameUuid(target.applicationRootId, command.selector.rootId)))
    problem("refused");
  return target;
};

const freshSavedPolicyIsObserved = async (
  selector: StudioApplicationFirstInstallSelector,
  history: ReturnType<typeof firstInstallHistory>,
  selected: StudioApplicationFirstInstallSnapshot["selected"],
  target: z.infer<typeof studioApplicationFirstInstallTargetSchema>,
  saved: RecordTypeLifecyclePolicy,
): Promise<void> => {
  const current = await readCurrentFirstInstallCandidate(selector);
  if (!same(current.snapshot.history, history) || !same(current.snapshot.selected, selected))
    problem("conflict");
  if (current.snapshot.registrationState === "active_exact") return;
  if (current.snapshot.registrationState !== "provisioned_inactive" || current.snapshot.setup === null)
    problem("temporarily_unavailable");
  const observedTarget = currentTarget(current.snapshot.setup, target.storageContractId);
  if (observedTarget.policy.state !== "configured" ||
    !sameUuid(observedTarget.policy.policyId, saved.policyId) ||
    observedTarget.policy.policyRevision !== saved.policyRevision ||
    !same(observedTarget.policy.policyBody, visiblePolicyBody(saved)))
    problem("temporarily_unavailable");
};

export const saveStudioApplicationFirstInstallPolicy = async (
  organizationIdCandidate: string,
  commandCandidate: unknown,
): Promise<StudioApplicationFirstInstallCommandResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const command = studioApplicationFirstInstallSaveCommandSchema.safeParse(commandCandidate);
  if (!organizationId.success || !command.success ||
    !firstInstallCommandMatches(organizationId.data, command.data.selector, command.data.expected))
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "refused", stateMayHaveChanged: false,
    });

  let invocationStarted = false;
  try {
    const candidate = await readCurrentFirstInstallCandidate(command.data.selector);
    if (!sameFirstInstallExpectation(command.data.expected, candidate.snapshot))
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    if (candidate.snapshot.registrationState !== "provisioned_inactive" ||
      candidate.snapshot.setup === null)
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    const target = assertInitialPolicyTarget(candidate.snapshot.setup, command.data);
    let saved: RecordTypeLifecyclePolicy;
    if (command.data.policy.action === "delete") {
      await runFirstInstallAppTransaction(candidate, command.data.expected,
        async (_transaction, _scope, _issuedAt, initial) => {
          const currentTargetValue = assertInitialPolicyTarget(initial.setup, command.data);
          if (!same(currentTargetValue, target)) problem("conflict");
        });
      invocationStarted = true;
      saved = await saveDeleteInitialPolicy(
        candidate,
        target,
        command.data.expectedBindingRevision,
        command.data.expectedSettingsRevision,
        command.data.policy,
      );
    } else {
      saved = await runFirstInstallAppTransaction(candidate, command.data.expected,
        async (transaction, scope, issuedAt, initial) => {
          const currentTargetValue = assertInitialPolicyTarget(initial.setup, command.data);
          if (!same(currentTargetValue, target) || !same(initial.setup, candidate.snapshot.setup))
            problem("conflict");
          if (!workflowIsInExactRelease(
            initial.releaseSet, command.data.selector.rootId, command.data.policy.archiveWorkflowId,
          )) problem("refused");
          const currentRelease = await readAppScopedFirstInstallReleaseSet(transaction, command.data.selector);
          if (!sameFirstInstallRelease(currentRelease, initial.releaseSet)) problem("conflict");
          const currentSetup = await readProvisionedSetupInternalInTransaction(
            transaction, scope, candidate.session, issuedAt, command.data.selector, currentRelease,
          );
          if (!same(currentSetup, initial.internalSetup)) problem("conflict");
          await firstInstallAppCompletion(
            transaction, scope, candidate.session, issuedAt, command.data.selector,
            command.data.expected.history, currentRelease, initial.context,
          );
          const option = await readSelectedEligibleArchiveConnection(
            transaction, command.data.selector, initial.setup.organizationLimits, command.data.policy,
          );
          invocationStarted = true;
          return writeInitialArchivePolicy(
            transaction, candidate, currentTargetValue,
            command.data.expectedBindingRevision, command.data.expectedSettingsRevision,
            command.data.policy, option,
          );
        }, true);
    }
    await freshSavedPolicyIsObserved(
      candidate.selector, candidate.history, candidate.snapshot.selected, target, saved,
    );
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "completed", action: "policy_saved", stateMayHaveChanged: true,
    });
  } catch (error) {
    return firstInstallCommandFailure(error, invocationStarted ? "unknown" : false);
  }
};

const verifyFirstInstallActivation = (
  result: ApplicationInstallationActivationResult<unknown>,
  selector: StudioApplicationFirstInstallSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
): void => {
  const installed = result.installation;
  const expectedModules = new Map(releaseSet.modules.map((module) => [module.rootId.toLowerCase(), module]));
  if (!sameUuid(installed.organizationId, selector.organizationId) ||
    !sameUuid(installed.applicationRootId, selector.rootId) ||
    installed.applicationReleaseRevision !== selector.releaseRevision ||
    installed.moduleBindings.length !== expectedModules.size ||
    new Set(installed.moduleBindings.map((binding) => binding.moduleRootId.toLowerCase())).size !== expectedModules.size ||
    installed.moduleBindings.some((binding) => {
      const module = expectedModules.get(binding.moduleRootId.toLowerCase());
      return binding.state !== "active" || !sameUuid(binding.organizationId, selector.organizationId) ||
        !sameUuid(binding.applicationRootId, selector.rootId) ||
        binding.applicationReleaseRevision !== selector.releaseRevision || module === undefined ||
        binding.moduleReleaseRevision !== module.releaseRevision;
    }) ||
    (result.outcome === "activated" && result.previousApplicationReleaseRevision !== null) ||
    (result.outcome === "unchanged" &&
      result.previousApplicationReleaseRevision !== selector.releaseRevision))
    problem("failed");
};

export const activateStudioApplicationFirstInstall = async (
  organizationIdCandidate: string,
  commandCandidate: unknown,
): Promise<StudioApplicationFirstInstallCommandResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  const command = studioApplicationFirstInstallActivateCommandSchema.safeParse(commandCandidate);
  if (!organizationId.success || !command.success ||
    !firstInstallCommandMatches(organizationId.data, command.data.selector, command.data.expected))
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "refused", stateMayHaveChanged: false,
    });

  let invocationStarted = false;
  try {
    const candidate = await readCurrentFirstInstallCandidate(command.data.selector);
    if (!sameFirstInstallExpectation(command.data.expected, candidate.snapshot))
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "conflict", stateMayHaveChanged: false,
      });
    if (candidate.snapshot.registrationState !== "provisioned_inactive" ||
      candidate.snapshot.setup === null ||
      candidate.snapshot.setup.targets.some((target) => target.policy.state !== "configured"))
      return studioApplicationFirstInstallCommandResultSchema.parse({
        kind: "refused", stateMayHaveChanged: false,
      });

    const coordinator = firstInstallCoordinator(
      candidate.selector, candidate.snapshot, candidate.releaseSet, "activate",
    );
    invocationStarted = true;
    const result = await coordinator.activate(candidate.session, {
      organizationId: candidate.selector.organizationId,
      applicationRootId: candidate.selector.rootId,
      applicationReleaseRevision: candidate.selector.releaseRevision,
      expectedActiveReleaseRevision: null,
    });
    verifyFirstInstallActivation(result, candidate.selector, candidate.releaseSet);
    let postCommit: { kind: "observed"; activeReleaseRevision: number } | { kind: "unavailable" } = {
      kind: "unavailable",
    };
    try {
      const observed = await readActiveObservation(
        candidate.selector.organizationId, candidate.selector.rootId, candidate.session,
      );
      postCommit = { kind: "observed", activeReleaseRevision: observed.releaseRevision };
    } catch {
      postCommit = { kind: "unavailable" };
    }
    return studioApplicationFirstInstallCommandResultSchema.parse({
      kind: "completed",
      action: result.outcome === "activated" ? "activated" : "unchanged",
      activeAtCommitRevision: result.installation.applicationReleaseRevision,
      postCommit,
      stateMayHaveChanged: true,
    });
  } catch (error) {
    return firstInstallCommandFailure(error, invocationStarted ? "unknown" : false);
  }
};
