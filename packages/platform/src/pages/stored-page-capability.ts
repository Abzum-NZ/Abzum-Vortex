import type { PlatformPermissionSource } from "../access/platform-permissions";
import "server-only";

import { randomUUID } from "node:crypto";
import {
  sessionContextSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "../access/identity-access";
import {
  organizationRecordAccessDeclarationSchema,
  type OrganizationAccessDeclaration,
} from "../access/organization-access-decision";
import type { PermissionRegistryEntryCandidate } from "../access/permission-registry";
import type { PermissionDeclaration } from "../access/permissions";
import { safeHttpsUrlSchema, type JsonValue } from "../catalogue/common";
import {
  applicationRootIdSchema,
  pageIdSchema,
  revisionSchema,
  type ApplicationRootId,
  type PlatformId,
} from "../catalogue/identifiers";
import { PLATFORM_SERVICE_OPERATIONS } from "../catalogue/platform-service-operation-catalogue";
import { databaseTimestamp, sameId, describeFailure } from "../catalogue/runtime-primitives";
import {
  type CompiledLayout,
  compiledItemTree,
} from "../definition/application-composition/page-composition";
import { conditionNodeSchema, type ConditionNode } from "../definition/module-foundation-contracts";
import { installedNamedActionReferenceSchema } from "../records/named-actions";
import { platformOperationKey } from "../workflows/default-flow-sources";
import {
  flowTaskChildLists,
  type FlowDefinition,
  type FlowTask,
} from "../workflows/flow-contracts";
import { flowTaskRegistry } from "../workflows/flow-task-registry";
import { collectActionFlowTasks, flowLibraryOf } from "../rules/action-flow-run";
import { evaluateTypedCondition } from "../rules/typed-condition";
import { TypedConditionEvaluationError } from "../rules/typed-condition-error";
import {
  readSubjectWithNamedActionAvailability,
  type NamedActionAvailability,
} from "../records/action-record-availability";
import { installedNamedActions } from "../definition/installed-named-actions";
import type { FlowNamedAction } from "../definition/flow-orchestrator-types";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "../access/human-organization-request";
import {
  isTrustedInstalledPageBundleContext,
  matchesInstalledPageBundleIdentity,
  readInstalledPageComposition,
} from "../definition/installed-page-bundle-context";
import {
  requireInstalledRuntimeContext,
  type InstalledRuntimeContext,
} from "../definition/installed-runtime-context";
import { resolveInstalledPageIdentity } from "../definition/standard-page-resolution";
import {
  createAuthenticatedPageCapabilityService,
  type FixedAuthenticatedPageCapability,
} from "./authenticated-page-capability";
import {
  projectUnavailableLinkDestination,
  type ProjectedLinkDestination,
  type ProjectedPageCapability,
} from "./page-capability-projection";
import { resolvePageComposition } from "./page-composition-resolution";
import { pageSubjectFromRead, type PageSubjectReadResult } from "./page-subject-read";
import { activeInstallationBundleStateSchema } from "../definition/active-installation-bundle-repository";
import type { RequestDatabaseTransaction } from "../db/request-transaction";

/** The page subject and, when it is readable, its bound named actions' availability by action id. */
type SubjectWithAvailability = Readonly<{
  subject: PageSubjectReadResult;
  availability: ReadonlyMap<string, NamedActionAvailability>;
}>;

/** Address candidates select a page and its subject; organisation, installation and release come from context. */
export type StoredPageCapabilitySelection = Readonly<{
  pageId: string;
  /** Untrusted address candidate, used only with this page's exact declared protected subject. */
  subjectRecordId?: string;
}>;

export type StoredPageCapabilityDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    /**
     * The single trusted installed context assembled by App. Page projects only from this exact
     * release set and never re-reads or rebuilds organisation, release or permission authority.
     */
    context: InstalledRuntimeContext;
    selection: StoredPageCapabilitySelection;
    /** The shipped platform permission catalogue page requirements may name. */
    permissions: PlatformPermissionSource;
  }>;

class StoredPageCapabilityFailure extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "StoredPageCapabilityFailure";
  }
}

/**
 * One declared link target the browser asks the server to re-check when a link is activated. It
 * names a target kind and that target's permanent identity (or an external address); it carries no
 * authority, so resolving it can never grant access to what it names.
 */
type StoredLinkTargetDeclaration =
  | Readonly<{ kind: "page"; pageId: string }>
  | Readonly<{ kind: "application"; applicationRootId: string }>
  | Readonly<{ kind: "external"; address: string }>;

/**
 * One resolved page requirement: an application or bound-Module permission from the release's
 * prepared registration, or an exact platform administration permission from the shipped
 * platform catalogue. The two carry different authority shapes, so they stay distinct until the
 * declaration is built.
 */
type PagePermissionBinding =
  | Readonly<{ kind: "definition"; entry: PermissionRegistryEntryCandidate }>
  | Readonly<{ kind: "platform"; ownerId: PlatformId; permission: PermissionDeclaration }>;

const declaration = (
  operationKey: string,
  applicationRootId: ApplicationRootId,
  binding: PagePermissionBinding,
): OrganizationAccessDeclaration =>
  binding.kind === "platform"
    ? {
        operationKey,
        action: {
          actionKind: binding.permission.actionKind,
          ...(binding.permission.namedAction === undefined
            ? {}
            : { namedAction: binding.permission.namedAction }),
        },
        target: { kind: "organization" },
        requiredPermission: {
          ownerKind: "platform",
          ownerId: binding.ownerId,
          permissionId: binding.permission.permissionId,
        },
        recentAuthentication: { kind: "none" },
        authority: { kind: "permission" },
      }
    : {
        operationKey,
        action: {
          actionKind: binding.entry.permission.actionKind,
          ...(binding.entry.permission.namedAction === undefined
            ? {}
            : { namedAction: binding.entry.permission.namedAction }),
        },
        target: { kind: "application", applicationRootId },
        requiredPermission: {
          applicationRootId: binding.entry.applicationRootId,
          ownerKind: binding.entry.ownerKind,
          ownerId: binding.entry.ownerId,
          permissionId: binding.entry.permission.permissionId,
        },
        recentAuthentication: { kind: "none" },
        authority: { kind: "permission" },
      };

/** Exact installed descriptor selection, never a browser-supplied type or storage binding. */
const placementPermission = (
  context: InstalledRuntimeContext,
  operationKey: string,
  applicationRootId: ApplicationRootId,
  permissionKey: string,
  binding: PagePermissionBinding,
): NonNullable<FixedAuthenticatedPageCapability["placements"][string]["viewPermission"]> => {
  if (binding.kind === "platform" || binding.entry.permission.recordTypeId === undefined)
    return {
      kind: "permission",
      permissionKey,
      declaration: declaration(operationKey, applicationRootId, binding),
    };

  const entry = binding.entry;
  const recordTypeId = entry.permission.recordTypeId;
  const matches = context.releaseSet.modules.flatMap((module) =>
    module.content.recordTypes
      .filter((record) => sameId(record.recordTypeId, recordTypeId))
      .map((record) => ({ module, record })),
  );
  const match = matches[0];
  if (
    !sameId(entry.applicationRootId, applicationRootId) ||
    matches.length !== 1 ||
    match === undefined ||
    (entry.ownerKind === "module" && !sameId(entry.ownerId, match.module.rootId))
  )
    throw new Error("STORED_PAGE_PERMISSION_BINDING_UNAVAILABLE");

  return {
    kind: "record",
    permissionKey,
    declaration: organizationRecordAccessDeclarationSchema.parse({
      operationKey,
      action: {
        actionKind: entry.permission.actionKind,
        ...(entry.permission.namedAction === undefined
          ? {}
          : { namedAction: entry.permission.namedAction }),
      },
      target: { kind: "application", applicationRootId },
      requiredPermissions: [
        {
          applicationRootId: entry.applicationRootId,
          ownerKind: entry.ownerKind,
          ownerId: entry.ownerId,
          permissionId: entry.permission.permissionId,
        },
      ],
      recordBinding: {
        moduleRootId: match.module.rootId,
        recordTypeId: match.record.recordTypeId,
        storageContractId: match.record.storageContractId,
        storageScope: match.record.storageScope,
      },
      recentAuthentication: { kind: "none" },
      authority: { kind: "permission" },
    }),
  };
};

const literal = (task: FlowTask, name: string): string | undefined => {
  const value = (
    task as { properties?: Record<string, { kind: string; literal?: { value: unknown } }> }
  ).properties?.[name];
  return value?.kind === "literal" ? String(value.literal?.value) : undefined;
};

/**
 * The one installed named action each placement's bound flows call, by lower-case placement id. A
 * placement whose flows call no named action, or more than one, is bound to none: its availability
 * is not one action's.
 */
const placementNamedActions = (
  context: InstalledRuntimeContext,
): ReadonlyMap<string, FlowNamedAction> => {
  const application = context.releaseSet.application;
  const named = installedNamedActions(application, context.releaseSet.modules);
  const flows = new Map(application.content.flows.map((flow) => [flow.id.toLowerCase(), flow]));
  const called = new Map<string, Map<string, FlowNamedAction>>();
  for (const binding of application.content.flowBindings) {
    const flow = flows.get(binding.flow.flowId.toLowerCase());
    if (flow === undefined) continue;
    const placementId = binding.controlId.toLowerCase();
    const actions = called.get(placementId) ?? new Map<string, FlowNamedAction>();
    called.set(placementId, actions);
    const seen = new Set<string>();
    const visit = (tasks: readonly FlowTask[]): void => {
      for (const task of tasks) {
        if (task.type === "operation.call") {
          const key = literal(task, "operation");
          const action = key === undefined ? undefined : named.get(key);
          if (key !== undefined && action !== undefined) actions.set(key, action);
        } else if (task.type === "run_flow") {
          visitFlow(String((task as { flowId: string }).flowId));
        }
        for (const child of flowTaskChildLists(task)) visit(child.tasks);
      }
    };
    const visitFlow = (id: string): void => {
      const target = flows.get(id.toLowerCase());
      if (target === undefined || seen.has(target.id)) return;
      seen.add(target.id);
      visit(target.tasks);
      visit(target.errors);
      visit(target.finally);
    };
    visitFlow(flow.id);
  }
  return new Map(
    [...called].flatMap(([placementId, actions]) =>
      actions.size === 1 ? [[placementId, [...actions.values()][0]!] as const] : [],
    ),
  );
};

/** Whether a placement's flow bindings reach an operation, and whether all of them resolve. */
type PlacementOperationBinding = Readonly<{ required: boolean; bound: boolean }>;

const platformOperationsByKey = new Map(
  Object.values(PLATFORM_SERVICE_OPERATIONS).map((entry) => [
    platformOperationKey(entry.key),
    entry,
  ]),
);

/**
 * Resolves every placement's compiled component flow bindings against this exact installed release.
 * A placement requires an operation when one of its bound flows changes something, starts
 * background work or calls a protected operation, or when any binding cannot be proved (a flow, an
 * operation, a query or a record type missing from this release), so an unprovable binding fails
 * closed even without a use gate. It is operation-bound only when it requires an operation and
 * every task it reaches resolves: a platform-service operation is pinned by this release's
 * verified dependency manifest with the exact release the catalogue registers, and a named action,
 * query or record type belongs to a bound Module release. The operation is never named by the
 * placement or the browser, and this only proves the binding resolves; the owning operation still
 * re-checks its own authority when invoked.
 */
const placementOperationBindings = (
  context: InstalledRuntimeContext,
): ReadonlyMap<string, PlacementOperationBinding> => {
  const release = context.releaseSet;
  const application = release.application;
  const manifest = application.dependencyManifest;
  const flows = new Map(application.content.flows.map((flow) => [flow.id.toLowerCase(), flow]));
  const lower = (values: Iterable<unknown>): Set<string> =>
    new Set([...values].map((value) => String(value).toLowerCase()));
  const actionKeys = new Set([
    ...application.content.actions.map((action) => String(action.key)),
    ...release.modules.flatMap((module) =>
      module.content.actions.map((action) => String(action.key)),
    ),
  ]);
  const recordTypeIds = lower(
    release.modules.flatMap((module) =>
      module.content.recordTypes.map((record) => record.recordTypeId),
    ),
  );
  const queryIds = lower([
    ...application.content.queries.map((query) => query.queryId),
    ...release.modules.flatMap((module) => module.content.queries.map((query) => query.queryId)),
  ]);
  const operationResolves = (key: string | undefined): boolean => {
    if (key === undefined) return false;
    if (actionKeys.has(key)) return true;
    const platform = platformOperationsByKey.get(key);
    return (
      platform !== undefined &&
      manifest.some(
        (entry) =>
          entry.kind === "protected_operation" &&
          entry.operation.owner.kind === "platform_service" &&
          sameId(entry.operation.owner.serviceId, platform.release.serviceId) &&
          sameId(entry.operation.operationId, platform.release.operationId) &&
          entry.releaseVersion === platform.release.releaseVersion &&
          entry.contentFingerprint === platform.release.contentFingerprint,
      )
    );
  };
  /** What one flow, and every flow it runs, needs and whether all of it resolves in this release. */
  const analyse = (
    flow: FlowDefinition,
    seen: ReadonlySet<string>,
  ): { required: boolean; resolved: boolean } => {
    const outcome = { required: false, resolved: true };
    const visit = (tasks: readonly FlowTask[]) => {
      for (const task of tasks) {
        if (task.type === "run_flow") {
          const target = flows.get(String((task as { flowId: string }).flowId).toLowerCase());
          if (target === undefined || seen.has(target.id)) outcome.resolved = false;
          else {
            const inner = analyse(target, new Set([...seen, target.id]));
            outcome.required ||= inner.required;
            outcome.resolved &&= inner.resolved;
          }
        } else if (Object.hasOwn(flowTaskRegistry, task.type)) {
          const definition = flowTaskRegistry[task.type as keyof typeof flowTaskRegistry];
          if (task.type === "operation.call") {
            outcome.required = true;
            if (!operationResolves(literal(task, "operation"))) outcome.resolved = false;
          } else if (task.type === "record.query") {
            if (!queryIds.has(String(literal(task, "query")).toLowerCase())) {
              outcome.required = true;
              outcome.resolved = false;
            }
          } else if (definition.effect === "change" || definition.effect === "background_start") {
            outcome.required = true;
            const recordType = literal(task, "record_type");
            if (recordType !== undefined && !recordTypeIds.has(recordType.toLowerCase()))
              outcome.resolved = false;
            if (
              task.type === "flow.run_background" &&
              !flows.has(String(literal(task, "flow")).toLowerCase())
            )
              outcome.resolved = false;
          }
        } else outcome.resolved = false;
        for (const child of flowTaskChildLists(task)) visit(child.tasks);
      }
    };
    visit(flow.tasks);
    visit(flow.errors);
    visit(flow.finally);
    return outcome;
  };
  const outcomes = new Map<string, { required: boolean; resolved: boolean }>();
  for (const binding of application.content.flowBindings) {
    const placementId = binding.controlId.toLowerCase();
    const outcome = outcomes.get(placementId) ?? { required: false, resolved: true };
    outcomes.set(placementId, outcome);
    const flow = flows.get(binding.flow.flowId.toLowerCase());
    // A flow this release does not contain fails closed like any binding that cannot be proved.
    if (flow === undefined) {
      outcome.required = true;
      outcome.resolved = false;
      continue;
    }
    const analysed = analyse(flow, new Set([flow.id]));
    outcome.required ||= analysed.required;
    outcome.resolved &&= analysed.resolved;
  }
  return new Map(
    [...outcomes].map(([placementId, outcome]) => [
      placementId,
      { required: outcome.required, bound: outcome.required && outcome.resolved },
    ]),
  );
};

/** Every item of a resolved layout as its placement identity and its Vortex metadata. */
const placementEntries = (layout: CompiledLayout): Record<string, unknown>[] =>
  compiledItemTree(layout.content).map((item) => ({
    placementId: item.props.id,
    ...item.props.vortex,
  }));

export const createStoredPageCapabilityService = (
  dependencies: StoredPageCapabilityDependencies,
) => {
  // Only a context App assembled is accepted; a missing or look-alike object fails closed here.
  const context = requireInstalledRuntimeContext(dependencies.context);
  const applicationRootId = applicationRootIdSchema.parse(context.applicationRootId);
  const releaseRevision = revisionSchema
    .max(Number.MAX_SAFE_INTEGER)
    .parse(context.applicationReleaseRevision);
  const selectedPageId = pageIdSchema.parse(dependencies.selection.pageId);

  // The loader has already verified this; Page still refuses, rather than projects, a context
  // whose exact release, registration and scope disagree.
  const applicationRelease = context.releaseSet.application;
  const registration = context.permissionRegistration;
  if (
    applicationRelease.organizationId !== context.organizationId ||
    applicationRelease.rootId !== context.applicationRootId ||
    applicationRelease.releaseRevision !== releaseRevision ||
    registration.organizationId !== context.organizationId ||
    registration.applicationRootId !== context.applicationRootId ||
    registration.applicationRelease.releaseRevision !== releaseRevision
  )
    throw new Error("STORED_PAGE_TRUSTED_CONTEXT_UNAVAILABLE");

  const requestDependencies = {
    ...dependencies,
    correlationId: () => context.correlationId,
  };
  const requests = createHumanOrganizationRequestService(requestDependencies);
  const boundActions = placementNamedActions(context);
  // Application and Module flows, one per identity: an ambiguous release is refused, not run.
  let flowLibraryValue: ReturnType<typeof flowLibraryOf> | undefined;
  const flowLibrary = () => {
    if (flowLibraryValue === undefined) {
      const flows = new Map<string, unknown>();
      for (const flow of [
        ...applicationRelease.content.flows,
        ...context.releaseSet.modules.flatMap((module) => module.content.flows),
      ]) {
        if (flows.has(String(flow.id))) throw new Error("FLOW_IDENTITY_AMBIGUOUS");
        flows.set(String(flow.id), flow);
      }
      flowLibraryValue = flowLibraryOf(flows);
    }
    return flowLibraryValue;
  };

  // Undefined means the selected page is not in the release: a lasting answer, not a fault.
  const load = async (pageId: string): Promise<FixedAuthenticatedPageCapability | undefined> => {
    const identity = resolveInstalledPageIdentity(context, { pageId });
    if (identity === undefined) return undefined;
    // Resolution reports the pair, but only the explicitly requested endpoint selects a page.
    const pages = applicationRelease.content.pages.filter((page) =>
      sameId(page.pageId, identity.requested.pageId),
    );
    if (pages.length !== 1 || pages[0] === undefined)
      throw new Error("STORED_PAGE_DEFINITION_EVIDENCE_UNAVAILABLE");
    const page = pages[0];
    // A page requirement names either an exact application or bound-Module permission from this
    // release's prepared registration, or an exact platform administration permission from the
    // shipped platform catalogue. Anything else fails this page closed.
    const permission = (key: string): PagePermissionBinding => {
      const platform = dependencies.permissions.forKey(key);
      if (platform !== undefined)
        return {
          kind: "platform",
          ownerId: dependencies.permissions.ownerId,
          permission: platform,
        };
      const matches = registration.entries.filter((entry) => entry.permission.key === key);
      if (matches.length !== 1 || matches[0] === undefined)
        throw new Error("STORED_PAGE_PERMISSION_BINDING_UNAVAILABLE");
      return { kind: "definition", entry: matches[0] };
    };
    const operationBindings = placementOperationBindings(context);
    const pagePermissionBinding = permission(page.accessPermissionKey);
    const resolvedComposition = readInstalledPageComposition(context, page.pageId);
    const resolved =
      resolvedComposition ?? resolvePageComposition(page, applicationRelease.content.shells);
    const placements: Record<string, unknown>[] =
      resolved.roots.kind === "page"
        ? placementEntries(resolved.roots.main)
        : Object.values(resolved.roots.stepContent).flatMap(placementEntries);
    return {
      page,
      applicationShells: applicationRelease.content.shells,
      ...(resolvedComposition === undefined
        ? {}
        : { resolvedComposition, resolvedCompositionContext: context }),
      sourceCorrelationId: applicationRelease.correlationId,
      applicationReleaseRevision: releaseRevision,
      pagePermission: {
        permissionKey: page.accessPermissionKey,
        declaration: declaration(
          "application.page.discover",
          applicationRootId,
          pagePermissionBinding,
        ),
      },
      placements: Object.fromEntries(
        placements.map((placement) => {
          const placementId = String(placement.placementId);
          const viewPermissionKey = placement.viewPermissionKey as string | undefined;
          const usePermissionKey = placement.usePermissionKey as string | undefined;
          const viewBinding =
            viewPermissionKey === undefined ? undefined : permission(viewPermissionKey);
          const useBinding =
            usePermissionKey === undefined ? undefined : permission(usePermissionKey);
          const operation = operationBindings.get(placementId.toLowerCase());
          return [
            placementId,
            {
              ...(viewBinding === undefined || viewPermissionKey === undefined
                ? {}
                : {
                    viewPermission: placementPermission(
                      context,
                      "application.page.placement.view",
                      applicationRootId,
                      viewPermissionKey,
                      viewBinding,
                    ),
                  }),
              ...(useBinding === undefined || usePermissionKey === undefined
                ? {}
                : {
                    usePermission: placementPermission(
                      context,
                      "application.page.placement.use",
                      applicationRootId,
                      usePermissionKey,
                      useBinding,
                    ),
                  }),
              operationRequired: operation?.required === true,
              operationBound: operation?.bound === true,
            },
          ];
        }),
      ),
    };
  };

  // Projects one loaded page for the viewer's current authority over this exact scope only.
  const projectStored = (
    session: IdentitySession,
    candidate: OrganizationSelectionCandidate,
    stored: FixedAuthenticatedPageCapability,
  ): Promise<HumanOrganizationRequestResult<ProjectedPageCapability>> => {
    // This cache belongs to one projection transaction, never another page, actor or release.
    let subjectRead:
      | Readonly<{
          recordTypeId: string;
          recordId: string;
          read: Promise<SubjectWithAvailability>;
        }>
      | undefined;
    const conditionSubjectFieldIds: string[] = [];
    const collectConditionFields = (candidate: unknown): void => {
      const parsed = conditionNodeSchema.safeParse(candidate);
      if (!parsed.success) return;
      const visit = (node: ConditionNode): void => {
        if (node.kind === "comparison") {
          for (const operand of [node.left, node.right])
            if (operand?.source === "field") conditionSubjectFieldIds.push(operand.fieldId);
        } else if (node.kind === "not") visit(node.condition);
        else node.conditions.forEach(visit);
      };
      visit(parsed.data);
    };
    const resolved =
      stored.resolvedComposition ?? resolvePageComposition(stored.page, stored.applicationShells);
    const conditionLayouts =
      resolved.roots.kind === "page"
        ? [resolved.roots.main]
        : Object.values(resolved.roots.stepContent);
    for (const layout of conditionLayouts)
      for (const item of compiledItemTree(layout.content))
        collectConditionFields(item.props.vortex.visibilityCondition);
    // The page subject, read once, together with the preview of every named action the page's
    // placements are bound to on it: one read decision for the record serves them all.
    const readSubject = (
      transaction: RequestDatabaseTransaction,
      recordTypeId: string,
      recordId: string,
    ): Promise<SubjectWithAvailability> => {
      if (subjectRead !== undefined) {
        if (
          !sameId(subjectRead.recordTypeId, recordTypeId) ||
          !sameId(subjectRead.recordId, recordId)
        )
          throw new Error("PAGE_SUBJECT_MISMATCH");
        return subjectRead.read;
      }
      const actions = new Map<string, FlowNamedAction["action"]>();
      for (const placementId of Object.keys(stored.placements)) {
        const bound = boundActions.get(placementId.toLowerCase());
        if (bound !== undefined && sameId(bound.subjectRecordTypeId, recordTypeId))
          actions.set(
            bound.action.actionId.toLowerCase(),
            installedNamedActionReferenceSchema.parse(bound.action),
          );
      }
      const read = (async (): Promise<SubjectWithAvailability> => {
        try {
          const combined = await readSubjectWithNamedActionAvailability(
            transaction,
            {
              recordTypeId,
              recordId,
              // Action preparation validates a complete proposed record, not only changed fields.
              // Conditions alone consume only their declared field operands.
              requestedFieldIds: actions.size > 0 ? null : conditionSubjectFieldIds,
            },
            [...actions.values()],
            (dependencies.clock ?? (() => new Date()))().toISOString(),
            (action) => (seed) =>
              collectActionFlowTasks(flowLibrary(), action.actionId, randomUUID(), seed),
          );
          return {
            subject: pageSubjectFromRead(combined.record, combined.capabilities, recordId),
            availability: combined.availability,
          };
        } catch (error) {
          console.error(
            `[page] page subject read with action previews failed: ${describeFailure(error)}`,
          );
          return { subject: { kind: "temporarily_unavailable" }, availability: new Map() };
        }
      })();
      subjectRead = { recordTypeId, recordId, read };
      return read;
    };
    // One preview per bound action, however many placements share it.
    const availabilities = new Map<string, Promise<boolean | undefined>>();
    return createAuthenticatedPageCapabilityService({
      ...requestDependencies,
      evaluateActionAvailability: async (transaction, scope, page, placementId) => {
        const action = boundActions.get(placementId.toLowerCase());
        const subjectRecordId = dependencies.selection.subjectRecordId;
        // Only the selected page's own subject is previewed; a list or another page has none.
        if (
          action === undefined ||
          subjectRecordId === undefined ||
          !sameId(page.pageId, selectedPageId) ||
          !(
            page.type === "detail" ||
            page.type === "public" ||
            page.type === "form" ||
            page.type === "guided_form"
          ) ||
          page.recordType?.state !== "resolved" ||
          !sameId(page.recordType.recordTypeId, action.subjectRecordTypeId) ||
          scope.applicationRootId === undefined ||
          !sameId(scope.organizationId, context.organizationId) ||
          !sameId(scope.applicationRootId, applicationRootId)
        )
          return undefined;
        const key = action.action.actionId.toLowerCase();
        let decision = availabilities.get(key);
        if (decision === undefined) {
          decision = (async () => {
            const { subject: read, availability: previewed } = await readSubject(
              transaction,
              action.subjectRecordTypeId,
              subjectRecordId,
            );
            // A transient failure is not a decision: it fails the projection instead of hiding controls.
            if (read.kind === "temporarily_unavailable")
              throw new Error("PAGE_SUBJECT_READ_UNAVAILABLE");
            // A subject the viewer cannot read shows no control that acts on it.
            if (read.kind !== "read") return false;
            const availability = previewed.get(key);
            if (availability === undefined) throw new Error("PAGE_ACTION_PREVIEW_MISSING");
            if (availability.kind === "undecided") {
              console.info(
                `[page] action availability undecided for placement ${placementId}: ${availability.reason}`,
              );
              return undefined;
            }
            return availability.kind === "available";
          })();
          availabilities.set(key, decision);
        }
        return decision;
      },
      validateAccessEligibilityUntil: async (transaction, scope, validUntil) => {
        try {
          // The installed bundle identity, the request context and the database clock are
          // independent reads of this one transaction, so they are sent together (one round trip
          // instead of three) and still checked in their original order.
          const bundleRead = isTrustedInstalledPageBundleContext(context)
            ? transaction.query<{
                readonly bundle_state: unknown;
              }>`
                select vortex_definition.read_active_installation_bundle_identity() as bundle_state
              `
            : undefined;
          const contextRead = transaction.query<{
            readonly request_context: unknown;
            readonly observed_at: unknown;
          }>`
            select
              vortex_access.validated_human_request_context() - 'channel' as request_context,
              clock_timestamp() as observed_at
          `;
          const [bundleRows, contextRows] = await Promise.all([bundleRead, contextRead]);
          if (bundleRows !== undefined) {
            const bundleState = activeInstallationBundleStateSchema.safeParse(
              bundleRows[0]?.bundle_state,
            );
            if (bundleRows.length === 1 && bundleRows[0] !== undefined && !bundleState.success)
              throw new StoredPageCapabilityFailure("STORED_PAGE_BUNDLE_IDENTITY_MALFORMED", {
                cause: bundleState.error,
              });
            if (
              bundleRows.length !== 1 ||
              bundleRows[0] === undefined ||
              !bundleState.success ||
              !matchesInstalledPageBundleIdentity(
                context,
                bundleState.data,
                scope.accessVersion,
                scope.organizationAccountId,
              )
            )
              return false;
          }

          if (contextRows.length !== 1 || contextRows[0] === undefined)
            throw new StoredPageCapabilityFailure("STORED_PAGE_REQUEST_CONTEXT_MISSING");
          const current = sessionContextSchema.safeParse(contextRows[0].request_context);
          if (!current.success)
            throw new StoredPageCapabilityFailure("STORED_PAGE_REQUEST_CONTEXT_INVALID", {
              cause: current.error,
            });
          if (current.data.callerKind !== "human")
            throw new StoredPageCapabilityFailure("STORED_PAGE_REQUEST_CONTEXT_CALLER_INVALID");
          const observedAt = databaseTimestamp(contextRows[0].observed_at);
          if (typeof observedAt !== "string")
            throw new StoredPageCapabilityFailure("STORED_PAGE_REQUEST_CLOCK_INVALID");
          const observedMilliseconds = Date.parse(observedAt);
          if (!Number.isFinite(observedMilliseconds))
            throw new StoredPageCapabilityFailure("STORED_PAGE_REQUEST_CLOCK_INVALID");
          const expiresAt =
            current.data.expiresAt === undefined ? Number.NaN : Date.parse(current.data.expiresAt);
          const validUntilMilliseconds = Date.parse(validUntil);
          if (!Number.isFinite(expiresAt) || !Number.isFinite(validUntilMilliseconds))
            throw new StoredPageCapabilityFailure("STORED_PAGE_ACCESS_DEADLINE_INVALID");
          return (
            expiresAt > observedMilliseconds &&
            (current.data.delegatedContext === undefined ||
              Date.parse(current.data.delegatedContext.expiresAt) > observedMilliseconds) &&
            (current.data.supportContext === undefined ||
              Date.parse(current.data.supportContext.expiresAt) > observedMilliseconds) &&
            sameId(current.data.tenantId, scope.tenantId) &&
            sameId(current.data.organizationId, scope.organizationId) &&
            sameId(current.data.organizationAccountId, scope.organizationAccountId) &&
            current.data.applicationRootId !== undefined &&
            sameId(current.data.applicationRootId, scope.applicationRootId) &&
            current.data.accessVersion === scope.accessVersion &&
            validUntilMilliseconds > observedMilliseconds
          );
        } catch (error) {
          if (error instanceof StoredPageCapabilityFailure) throw error;
          throw new StoredPageCapabilityFailure("STORED_PAGE_CAPABILITY_VALIDATION_FAILED", {
            cause: error,
          });
        }
      },
      evaluateVisibilityCondition: async (transaction, scope, page, condition) => {
        if (
          scope.applicationRootId === undefined ||
          !sameId(scope.organizationId, context.organizationId) ||
          !sameId(scope.applicationRootId, applicationRootId)
        )
          return false;
        const parsed = conditionNodeSchema.safeParse(condition);
        if (!parsed.success) return false;
        const fieldIds = new Set<string>();
        let unsupported = false;
        const collect = (node: ConditionNode): void => {
          if (node.kind === "comparison") {
            for (const operand of [node.left, node.right]) {
              if (operand?.source === "parameter") unsupported = true;
              if (operand?.source === "field") fieldIds.add(operand.fieldId.toLowerCase());
            }
          } else if (node.kind === "not") collect(node.condition);
          else node.conditions.forEach(collect);
        };
        // Inspect every branch before any read; an unsupported operand cannot short-circuit to true.
        collect(parsed.data);
        if (unsupported) return false;
        try {
          if (fieldIds.size === 0)
            return evaluateTypedCondition({
              condition: parsed.data,
              sourceRecordFields: [],
              declaredFieldIds: [],
              fieldValues: {},
              parameterDeclarations: [],
              parameterValues: {},
            });

          // A different destination page cannot borrow the selected page's address subject.
          const recordType =
            sameId(page.pageId, selectedPageId) &&
            (page.type === "detail" ||
              page.type === "public" ||
              page.type === "form" ||
              page.type === "guided_form") &&
            page.recordType?.state === "resolved"
              ? page.recordType
              : undefined;
          const subjectRecordId = dependencies.selection.subjectRecordId;
          if (recordType === undefined || subjectRecordId === undefined) return false;
          const modules = context.releaseSet.modules.filter((module) =>
            sameId(module.rootId, recordType.moduleRootId),
          );
          if (modules.length !== 1) return false;
          const records = modules[0]!.content.recordTypes.filter((record) =>
            sameId(record.recordTypeId, recordType.recordTypeId),
          );
          if (records.length !== 1) return false;
          const fields = records[0]!.fields;
          const fieldsById = new Map(fields.map((field) => [field.fieldId.toLowerCase(), field]));
          if (fieldsById.size !== fields.length || [...fieldIds].some((id) => !fieldsById.has(id)))
            return false;
          const { subject: read } = await readSubject(
            transaction,
            recordType.recordTypeId,
            subjectRecordId,
          );
          if (read.kind !== "read") return false;
          const values: Record<string, JsonValue> = {};
          for (const id of fieldIds) {
            const matches = Object.entries(read.row.values).filter(([key]) => sameId(key, id));
            // An unreadable/missing field is not a null field; duplicate identity aliases refuse.
            if (matches.length !== 1) return false;
            values[fieldsById.get(id)!.fieldId] = matches[0]![1];
          }
          type Operand = Extract<ConditionNode, { kind: "comparison" }>["left"];
          const canonicalOperand = (operand: Operand): Operand =>
            operand.source === "field"
              ? { source: "field", fieldId: fieldsById.get(operand.fieldId.toLowerCase())!.fieldId }
              : operand;
          const canonicalCondition = (node: ConditionNode): ConditionNode => {
            if (node.kind === "comparison")
              return {
                ...node,
                left: canonicalOperand(node.left),
                ...(node.right === undefined ? {} : { right: canonicalOperand(node.right) }),
              };
            if (node.kind === "not")
              return { kind: "not", condition: canonicalCondition(node.condition) };
            return { kind: node.kind, conditions: node.conditions.map(canonicalCondition) };
          };
          return evaluateTypedCondition({
            condition: canonicalCondition(parsed.data),
            sourceRecordFields: fields,
            declaredFieldIds: [...fieldIds].map((id) => fieldsById.get(id)!.fieldId),
            fieldValues: values,
            parameterDeclarations: [],
            parameterValues: {},
          });
        } catch (error) {
          if (error instanceof TypedConditionEvaluationError) return false;
          throw error;
        }
      },
      adapter: {
        load: async (_transaction, scope) => {
          if (
            scope.applicationRootId === undefined ||
            !sameId(scope.organizationId, context.organizationId) ||
            !sameId(scope.applicationRootId, applicationRootId)
          )
            throw new Error("STORED_PAGE_HUMAN_SCOPE_UNAVAILABLE");
          return stored;
        },
      },
    }).project(session, candidate, undefined);
  };

  const project = async (
    session: IdentitySession,
    candidate: OrganizationSelectionCandidate,
  ): Promise<HumanOrganizationRequestResult<ProjectedPageCapability>> => {
    if (
      !sameId(candidate.organizationId, context.organizationId) ||
      candidate.applicationRootId === undefined ||
      !sameId(candidate.applicationRootId, applicationRootId)
    )
      return { kind: "unavailable" };
    // A caller without access gets the same answer whether or not the page exists. The load below
    // only reads the already-loaded context, and the projection runs the same HUMAN request over
    // this exact scope, so a found page proves the person's current authority there. Only a page
    // that cannot be projected (missing or unloadable) proves that authority first, on its own.
    const verifiedRefusal = async () => {
      const verified = await requests.run(session, candidate, async () => undefined);
      return verified.kind === "available" ? undefined : verified;
    };
    let fixed: FixedAuthenticatedPageCapability | undefined;
    try {
      fixed = await load(selectedPageId);
    } catch (error) {
      const refusal = await verifiedRefusal();
      if (refusal !== undefined) return refusal;
      const failure =
        error instanceof StoredPageCapabilityFailure
          ? error
          : new StoredPageCapabilityFailure("STORED_PAGE_CAPABILITY_LOAD_FAILED", { cause: error });
      const cause = describeFailure(failure);
      console.error(`[page] stored capability load failed: ${cause}`);
      return { kind: "temporarily_unavailable", cause };
    }
    if (fixed === undefined) return (await verifiedRefusal()) ?? { kind: "unavailable" };
    return projectStored(session, candidate, fixed);
  };

  /**
   * True only when the viewer can currently open this page of the exact installed release, proved
   * through the same page/access projection as `project`. Missing, refused, withdrawn and
   * unprovable pages are all simply false, so no caller can tell them apart.
   */
  const pageOpens = async (
    session: IdentitySession,
    candidate: OrganizationSelectionCandidate,
    pageId: string,
  ): Promise<boolean> => {
    let fixed: FixedAuthenticatedPageCapability | undefined;
    try {
      fixed = await load(pageId);
    } catch (error) {
      const failure = new StoredPageCapabilityFailure("STORED_PAGE_TARGET_CAPABILITY_LOAD_FAILED", {
        cause: error,
      });
      console.error(`[page] stored page target capability failed: ${describeFailure(failure)}`);
      throw failure;
    }
    if (fixed === undefined) return false;
    const projected = await projectStored(session, candidate, fixed);
    if (projected.kind === "temporarily_unavailable")
      throw new StoredPageCapabilityFailure("STORED_PAGE_TARGET_AUTHORIZATION_FAILED", {
        cause: new Error(projected.cause ?? "STORED_PAGE_TARGET_AUTHORIZATION_UNAVAILABLE"),
      });
    return projected.kind === "available" && projected.value !== undefined;
  };

  return Object.freeze({
    project: (session: IdentitySession, candidate: OrganizationSelectionCandidate) =>
      project(session, candidate),
    /**
     * Re-checks one declared link target against the viewer's current access at navigation time.
     * The target is definition or record data and grants nothing. An external address is available
     * once it satisfies the bounded HTTPS contract and is never fetched. An application is
     * available only when the viewer can currently open its release home page or a role home page
     * of this installed release (the homes the #599 launcher opens at; the destination still
     * chooses its own home when opened); a page only when the viewer can currently open that page.
     * A target in another application is resolved by that application's own installed service.
     * Missing, refused, withdrawn and out-of-release targets, and a viewer whose current authority
     * fails, all collapse to the same opaque unavailable state with no name, icon, address or
     * reason. A selection outside this installed scope gets the same neutral refusal as the page.
     */
    async resolveLinkTarget(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      target: StoredLinkTargetDeclaration,
    ): Promise<HumanOrganizationRequestResult<ProjectedLinkDestination>> {
      if (
        !sameId(candidate.organizationId, context.organizationId) ||
        candidate.applicationRootId === undefined ||
        !sameId(candidate.applicationRootId, applicationRootId)
      )
        return { kind: "unavailable" };
      const unavailable = {
        kind: "available",
        value: projectUnavailableLinkDestination(),
      } as const;

      if (target.kind === "external") {
        const address = safeHttpsUrlSchema.safeParse(target.address);
        return address.success
          ? {
              kind: "available",
              value: { availability: "available", kind: "external", address: address.data },
            }
          : unavailable;
      }

      if (target.kind === "application") {
        const parsed = applicationRootIdSchema.safeParse(target.applicationRootId);
        if (!parsed.success || !sameId(parsed.data, applicationRootId)) return unavailable;
        const homes = [
          applicationRelease.content.homePageId,
          ...applicationRelease.content.roles.map((role) => role.homePageId),
        ].filter((pageId, index, all) => all.findIndex((other) => sameId(other, pageId)) === index);
        for (const pageId of homes)
          if (await pageOpens(session, candidate, pageId))
            return {
              kind: "available",
              value: { availability: "available", kind: "application", applicationRootId },
            };
        return unavailable;
      }

      const parsed = pageIdSchema.safeParse(target.pageId);
      return parsed.success && (await pageOpens(session, candidate, parsed.data))
        ? {
            kind: "available",
            value: { availability: "available", kind: "page", pageId: parsed.data },
          }
        : unavailable;
    },
  });
};
