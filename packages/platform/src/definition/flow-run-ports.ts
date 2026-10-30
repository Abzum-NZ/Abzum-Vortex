import "server-only";

import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import {
  createHumanOrganizationRequestService,
  type BoundHumanOrganizationRequest,
  type HumanOrganizationRequestDependencies,
} from "../access/human-organization-request";
import { recordIdSchema, recordTypeIdSchema } from "../catalogue/identifiers";
import { describeFailure, sameId } from "../catalogue/runtime-primitives";
import { createPageSubjectReader } from "../pages/page-subject-read";
import type { createViewerSafeRecordLinkReadService } from "../queries/viewer-safe-record-link-read";
import type { createNamedActionRecordPort } from "../records/action-record-port";
import type { createRecordSaveService } from "../records/save-record";
import type { BackendAdapter } from "../workflows/backend-adapters";
import type { FlowReceiptClaim } from "../workflows/start";
import { canonicalJson } from "./canonical-json";
import { createFlowCurrentRecordReader } from "./flow-current-record";
import type { InstalledFlowBindings } from "./flow-binding-endpoint";
import { createFlowProtectedExecutor } from "./flow-protected-executor";
import { createFlowQueryReader } from "./flow-query-reader";
import { createFlowRecordChangePort } from "./flow-record-changes";
import type { FlowOrchestratorDependencies, FlowRelease } from "./flow-orchestrator-types";
import type { ApplicationStoreService } from "./installation-application-store";
import { createInstalledContextLoader } from "./installed-page-bundle-context";
import { installedModuleClosure } from "./flow-selected-record-context";
import { runOrganizationAccessOperation } from "../access/organization-access-decision-access";
import { createOptionMembershipCheck } from "./option-membership-check";
import type { QueryContinuationKey } from "../queries/continuation-token";
import type { FlowPinTarget, createViewerSafeRecordLinkService } from "./viewer-safe-record-link";

/** What the ports of every flow run on one installed application have in common. */
export type FlowRunPortsHost = Readonly<{
  requestDependencies: HumanOrganizationRequestDependencies;
  identitySession: IdentitySession;
  applicationKey: string;
  applicationStore: ApplicationStoreService;
  /** Save record tasks and named actions run through the record service's own protected paths. */
  records: ReturnType<typeof createRecordSaveService>;
  actionRecords: ReturnType<typeof createNamedActionRecordPort>;
  backend: BackendAdapter;
  continuationKey: QueryContinuationKey;
  selectedRecordReader: ReturnType<typeof createViewerSafeRecordLinkReadService>;
  recordPinService: ReturnType<typeof createViewerSafeRecordLinkService>;
}>;

/** The admission of the run's page start, server segments and continuations. */
export type FlowRunAdmission = Pick<
  FlowOrchestratorDependencies,
  "admitSegment" | "admitContinuation" | "admitPageStart"
>;

/**
 * The ports one flow run needs, bound to the given request when there is one: protected
 * operations, record reads and writes, record pins, the back end and the invocation check. How a
 * segment is admitted is the caller's: a person's invocation admits through the receipts and
 * rate limits of the flow gate, a builder's test run through its own rolled-back transaction.
 */
export const createFlowRunPorts = (
  host: FlowRunPortsHost,
  release: FlowRelease,
  runId: string | undefined,
  installation: InstalledFlowBindings,
  admission: FlowRunAdmission,
  boundRequest?: BoundHumanOrganizationRequest,
  pin?: Readonly<{ target: FlowPinTarget; storedTargetResume: boolean }>,
  receipt?: FlowReceiptClaim,
): FlowOrchestratorDependencies => {
  const executorFor = (boundRequest?: BoundHumanOrganizationRequest, receipt?: FlowReceiptClaim) =>
    createFlowProtectedExecutor(
      { ...host.requestDependencies, ...(boundRequest === undefined ? {} : { boundRequest }) },
      host.applicationStore,
      receipt,
    );
  const selectedRecordReadsFor = (
    installation: InstalledFlowBindings,
    requests: ReturnType<typeof createHumanOrganizationRequestService>,
  ) => ({
    readFields: async (
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      target: Readonly<{ recordTypeId: string; recordId: string; fieldIds: readonly string[] }>,
    ) =>
      requests.run(session, selection, async (transaction, scope) => {
        const recordTypeId = recordTypeIdSchema.safeParse(target.recordTypeId);
        const recordId = recordIdSchema.safeParse(target.recordId);
        const owner = installation.selectedRecordReadModules?.get(
          target.recordTypeId.toLowerCase(),
        );
        const requestedFields = target.fieldIds.map((fieldId) => fieldId.toLowerCase());
        const projectionIsTrusted = [
          ...(installation.selectedRecordReadProjections?.values() ?? []),
        ]
          .flatMap((byTask) => [...byTask.values()])
          .some(
            (projection) =>
              sameId(projection.recordTypeId, target.recordTypeId) &&
              projection.fields.length === requestedFields.length &&
              projection.fields.every(
                (field, index) => field.fieldId.toLowerCase() === requestedFields[index],
              ),
          );
        if (
          !recordTypeId.success ||
          !recordId.success ||
          owner === undefined ||
          !projectionIsTrusted ||
          !sameId(session.identityId, host.identitySession.identityId) ||
          !sameId(selection.organizationId, installation.organizationId) ||
          selection.applicationRootId === undefined ||
          !sameId(selection.applicationRootId, installation.applicationRootId) ||
          !sameId(scope.organizationId, installation.organizationId) ||
          scope.applicationRootId === undefined ||
          !sameId(scope.applicationRootId, installation.applicationRootId)
        )
          return { outcome: "unavailable" } as const;

        return host.selectedRecordReader.readFields(transaction, scope, {
          identity: {
            organizationId: installation.organizationId,
            applicationRootId: installation.applicationRootId,
            moduleRootId: owner.moduleRootId,
            moduleReleaseRevision: owner.moduleReleaseRevision,
            recordTypeId: recordTypeId.data,
            storageContractId: owner.storageContractId,
            recordId: recordId.data,
          },
          applicationReleaseRevision: installation.installationRevision,
          fieldIds: target.fieldIds,
        });
      }),
  });

  const scopedDependencies = {
    ...host.requestDependencies,
    ...(boundRequest === undefined ? {} : { boundRequest }),
  };
  const requests = createHumanOrganizationRequestService(scopedDependencies);
  // The one check a save makes that a value is among the options its field's source offers now.
  const optionMember =
    boundRequest === undefined
      ? undefined
      : createOptionMembershipCheck({
          dependencies: { ...scopedDependencies, continuationKey: host.continuationKey },
          installation,
          session: boundRequest.session,
          selection: boundRequest.selection,
        });
  const subjectReader = createPageSubjectReader(scopedDependencies);
  const matchesBound = (session: IdentitySession, selection: OrganizationSelectionCandidate) =>
    boundRequest !== undefined &&
    canonicalJson(session) === canonicalJson(boundRequest.session) &&
    canonicalJson(selection) === canonicalJson(boundRequest.selection);
  return {
    continuationKey: host.continuationKey,
    ...admission,
    executor: executorFor(boundRequest, receipt),
    backend: host.backend,
    ...(boundRequest === undefined
      ? {}
      : { recordChanges: createFlowRecordChangePort(boundRequest, optionMember) }),
    records:
      boundRequest === undefined
        ? host.records
        : {
            save: async (session, selection, command) =>
              matchesBound(session, selection)
                ? host.records.saveInTransaction(
                    boundRequest.transaction,
                    boundRequest.issuedAt,
                    selection,
                    command,
                    optionMember,
                  )
                : { kind: "unavailable" },
          },
    actionRecords:
      boundRequest === undefined
        ? host.actionRecords
        : {
            execute: async (session, selection, command, run) =>
              matchesBound(session, selection)
                ? host.actionRecords.executeInTransaction(
                    boundRequest.transaction,
                    boundRequest.issuedAt,
                    selection,
                    command,
                    run,
                  )
                : { kind: "unavailable" },
          },
    subjects: {
      read: async (session, selection, subject) => {
        const result = await subjectReader.read(session, selection, subject);
        if (result.kind === "read" && result.row.revision === undefined)
          throw new Error("FLOW_RECORD_REVISION_MISSING");
        return result.kind === "read" ? { kind: "read", revision: result.row.revision! } : result;
      },
    },
    selectedRecordReads: selectedRecordReadsFor(installation, requests),
    queryRecords: createFlowQueryReader(
      { ...scopedDependencies, continuationKey: host.continuationKey },
      installation,
    ),
    currentRecords: createFlowCurrentRecordReader({
      requests,
      reader: host.selectedRecordReader,
      installation,
      identityId: host.identitySession.identityId,
    }),
    recordPins: {
      storedTargetResume: pin?.storedTargetResume === true,
      acquireIdentity: async (session, selection, selector) => {
        if (
          canonicalJson(session) !== canonicalJson(host.identitySession) ||
          !sameId(selection.organizationId, installation.organizationId) ||
          selection.applicationRootId === undefined ||
          !sameId(selection.applicationRootId, installation.applicationRootId) ||
          release.releaseKey !== installation.releaseKey ||
          release.flows !== installation.flows ||
          installation.modules === undefined
        )
          return { outcome: "unavailable" };
        const capturedModules = installation.modules;
        const checked = await requests.run(session, selection, async (transaction, scope) => {
          if (
            !sameId(scope.organizationId, installation.organizationId) ||
            scope.applicationRootId === undefined ||
            !sameId(scope.applicationRootId, installation.applicationRootId)
          )
            return false;
          const current = await createInstalledContextLoader(transaction, scope).load();
          const application = current.releaseSet.application;
          const modules = installedModuleClosure(application, current.releaseSet.modules);
          return (
            sameId(current.organizationId, installation.organizationId) &&
            sameId(current.applicationRootId, installation.applicationRootId) &&
            current.applicationReleaseRevision === installation.installationRevision &&
            [
              application.releaseVersion,
              application.contentFingerprint,
              application.resolutionFingerprint,
            ].join(":") === installation.releaseKey &&
            modules !== undefined &&
            modules.size === capturedModules.length &&
            capturedModules.every((captured) => {
              const bound = modules.get(captured.rootId.toLowerCase());
              return (
                bound !== undefined &&
                bound.definitionKey === captured.definitionKey &&
                bound.validationContractVersion === captured.validationContractVersion &&
                bound.releaseRevision === captured.releaseRevision &&
                bound.releaseVersion === captured.releaseVersion &&
                bound.contentFingerprint === captured.contentFingerprint &&
                bound.resolutionFingerprint === captured.resolutionFingerprint
              );
            })
          );
        });
        if (checked.kind !== "available" || !checked.value) return { outcome: "unavailable" };
        if (pin !== undefined && runId !== undefined)
          return host.recordPinService.acquireFlowPin(session, selection, runId, pin.target);
        if (boundRequest === undefined)
          return host.recordPinService.acquireIdentity(session, selection, selector);
        if (selector.applicationKey !== host.applicationKey) return { outcome: "unavailable" };
        return host.recordPinService.acquireIdentityInRequest(
          boundRequest.transaction,
          boundRequest.scope,
          selection.organizationId,
          selection.applicationRootId,
          selector,
        );
      },
    },
    authorizeInvocation: async (session, selection, flow) => {
      try {
        // Only this request's verified person and captured installed release may ask for a
        // decision. The permission identity comes from the compiled flow, never request JSON.
        if (
          canonicalJson(session) !== canonicalJson(host.identitySession) ||
          !(Date.parse(session.accessTokenExpiresAt) > Date.now()) ||
          !sameId(selection.organizationId, installation.organizationId) ||
          selection.applicationRootId === undefined ||
          !sameId(selection.applicationRootId, installation.applicationRootId) ||
          release.releaseKey !== installation.releaseKey ||
          release.flows !== installation.flows ||
          installation.applicationContent === undefined ||
          installation.modules === undefined ||
          flow.invocationPermissionId === undefined
        )
          return false;

        const capturedApplication = installation.applicationContent;
        const capturedModules = installation.modules;
        const permissionId = flow.invocationPermissionId;
        const capturedOwners = [
          ...capturedApplication.flows.map((candidate) => ({
            flow: candidate,
            ownerKind: "application" as const,
            ownerId: installation.applicationRootId,
          })),
          ...capturedModules.flatMap((module) =>
            module.content.flows.map((candidate) => ({
              flow: candidate,
              ownerKind: "module" as const,
              ownerId: module.rootId,
            })),
          ),
        ].filter((candidate) => sameId(String(candidate.flow.id), String(flow.id)));
        const capturedOwner = capturedOwners.length === 1 ? capturedOwners[0] : undefined;
        // Every flow here was validated with its release; the comparison needs no parse.
        if (
          capturedOwner === undefined ||
          canonicalJson(capturedOwner.flow) !== canonicalJson(flow) ||
          canonicalJson(installation.flows.get(String(flow.id))) !== canonicalJson(flow)
        )
          return false;

        const checked = await requests.run(session, selection, async (transaction, scope) => {
          if (
            !sameId(scope.organizationId, installation.organizationId) ||
            scope.applicationRootId === undefined ||
            !sameId(scope.applicationRootId, installation.applicationRootId)
          )
            return false;
          const current = await createInstalledContextLoader(transaction, scope).load();
          const application = current.releaseSet.application;
          const modules = installedModuleClosure(application, current.releaseSet.modules);
          if (
            !sameId(current.organizationId, installation.organizationId) ||
            !sameId(current.applicationRootId, installation.applicationRootId) ||
            current.applicationReleaseRevision !== installation.installationRevision ||
            [
              application.releaseVersion,
              application.contentFingerprint,
              application.resolutionFingerprint,
            ].join(":") !== installation.releaseKey ||
            modules === undefined ||
            modules.size !== capturedModules.length
          )
            return false;
          // Every bound Module must still be the exact captured immutable release, including
          // dependencies reached through other Modules. A matching flow ID alone is insufficient.
          for (const captured of capturedModules) {
            const module = modules.get(captured.rootId.toLowerCase());
            if (
              module === undefined ||
              module.definitionKey !== captured.definitionKey ||
              module.releaseRevision !== captured.releaseRevision ||
              module.releaseVersion !== captured.releaseVersion ||
              module.validationContractVersion !== captured.validationContractVersion ||
              module.contentFingerprint !== captured.contentFingerprint ||
              module.resolutionFingerprint !== captured.resolutionFingerprint
            )
              return false;
          }
          const currentOwners = [
            ...application.content.flows.map((candidate) => ({
              flow: candidate,
              ownerKind: "application" as const,
              ownerId: application.rootId,
            })),
            ...[...modules.values()].flatMap((module) =>
              module.content.flows.map((candidate) => ({
                flow: candidate,
                ownerKind: "module" as const,
                ownerId: module.rootId,
              })),
            ),
          ].filter((candidate) => sameId(String(candidate.flow.id), String(flow.id)));
          const currentOwner = currentOwners.length === 1 ? currentOwners[0] : undefined;
          if (
            currentOwner === undefined ||
            currentOwner.ownerKind !== capturedOwner.ownerKind ||
            !sameId(currentOwner.ownerId, capturedOwner.ownerId) ||
            canonicalJson(currentOwner.flow) !== canonicalJson(flow)
          )
            return false;

          const permissions = current.permissionRegistration.entries.filter((entry) =>
            sameId(entry.permission.permissionId, permissionId),
          );
          const entry = permissions.length === 1 ? permissions[0] : undefined;
          if (
            entry === undefined ||
            !sameId(entry.applicationRootId, installation.applicationRootId) ||
            entry.permission.recordTypeId !== undefined ||
            entry.permission.recordScope !== undefined ||
            entry.permission.fieldPolicy !== undefined
          )
            return false;
          const decision = await runOrganizationAccessOperation(
            transaction,
            scope,
            {
              operationKey: entry.permission.key,
              action: {
                actionKind: entry.permission.actionKind,
                ...(entry.permission.namedAction === undefined
                  ? {}
                  : { namedAction: entry.permission.namedAction }),
              },
              target: {
                kind: "application",
                applicationRootId: current.applicationRootId,
              },
              requiredPermission: {
                applicationRootId: entry.applicationRootId,
                ownerKind: entry.ownerKind,
                ownerId: entry.ownerId,
                permissionId: entry.permission.permissionId,
              },
              recentAuthentication: { kind: "none" },
              authority: { kind: "permission" },
            },
            async (allowed) => {
              const now = Date.now();
              return (
                allowed.accessVersion === scope.accessVersion &&
                Date.parse(allowed.checkedAt) <= now &&
                Date.parse(allowed.validUntil) > now &&
                Date.parse(session.accessTokenExpiresAt) > now
              );
            },
          );
          return decision.outcome === "completed" && decision.value === true;
        });
        return checked.kind === "available" && checked.value === true;
      } catch (error) {
        // Missing, ambiguous, stale, foreign or unavailable evidence shares one refusal; the log
        // keeps the cause.
        console.error(`[flows] invocation evidence check refused: ${describeFailure(error)}`);
        return false;
      }
    },
    resolveActor: async (session, selection) => {
      const result = await requests.run(
        session,
        selection,
        async (_transaction, scope) => scope.organizationAccountId,
      );
      return result.kind === "available" ? result.value : undefined;
    },
    // The release was read from the trusted installation for this exact request.
    resolveRelease: async () => release,
    ...(runId === undefined ? {} : { newRunId: () => runId }),
  };
};
