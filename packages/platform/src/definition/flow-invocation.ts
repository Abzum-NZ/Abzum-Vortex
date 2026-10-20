import "server-only";

import { createHash } from "node:crypto";
import {
  describeFailure,
  flowTaskChildLists,
  canonicalJson,
  flowSchema,
  flowReadFieldsProjectionSchema,
  flowReadFieldsTypeMapSchema,
  fieldIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  sameId,
  type ApplicationContent,
  type ExactDefinitionDependency,
  type FlowBindingInvocation,
  type FlowDefinition,
  type FlowReadFieldsScalarType,
  type FlowTask,
  type FormContinuationOutcome,
  type FormContinuationRequest,
  type IdentityAuthorityId,
  type IdentitySession,
  type JsonValue,
  type ModuleDefinitionConsumerReadResult,
  type OrganizationSelectionCandidate,
  type ProtectedOperationChannel,
  isRecord,
} from "../schema";
import type { RecordReferenceChoiceCommand } from "../queries/reference-choice-contracts";
import type { PermittedApplication, PermittedApplicationsRead } from "./application-address";
import { createOrganizationAccessAdministrationService } from "../access/organization-access-administration-access";
import { runOrganizationAccessOperation } from "../access/organization-access-decision-access";
import { createHumanOrganizationRequestService } from "../access/human-organization-request";
import { createRequestBoundTenantGovernanceService } from "../identity/tenant-governance-request-bound";
import { createReferenceChoiceService } from "../queries/reference-choice-service";
import { createViewerSafeRecordLinkReadService } from "../queries/viewer-safe-record-link-read";
import {
  createPageFormRequestAdapter,
  createPrivateFormSubmitAdapter,
} from "../pages/form-request";
import { createPageSubjectReader } from "../pages/page-subject-read";
import { logRecordsTableRequestRefusal } from "../pages/records-table-features";
import { recordsTableBindingRefusal } from "../pages/records-table-features/flow-dispatch";
import { createNamedActionRecordPort } from "../records/action-record-port";
import { createRecordSaveService } from "../records/save-record";
import type { createDatabaseApplicationBoundReleaseSetService } from "./application-bound-release-set";
import { readPermittedApplicationsAtAddress } from "./application-address";
import { createDatabaseFlowStores } from "./flow-continuation-store";
import { createFlowCurrentRecordReader } from "./flow-current-record";
import { createFlowOrchestrator } from "./flow-orchestrator";
import type { FlowNamedAction, FlowRecordType, FlowRelease } from "./flow-orchestrator-types";
import { createFormContinuationService } from "./form-continuation";
import { flowReadFieldsScalarTypeForField } from "./flow-compilation";
import { createHumanInstalledPageBundleContextLoader } from "./installed-page-bundle-context";
import type { InstalledRuntimeContext } from "./installed-runtime-context";
import { installedNamedActionDescriptors, installedNamedActions } from "./installed-named-actions";
import { createProtectedOperationExecutor } from "./protected-operation-executor";
import type { ApplicationStoreService } from "./installation-application-store";
import { createViewerSafeRecordLinkService } from "./viewer-safe-record-link";
import type { QueryContinuationKey } from "../queries/continuation-token";
import {
  createFlowBindingEndpoint,
  type InstalledFlowBindings,
  type FlowBindingEndpointResult,
} from "./flow-binding-endpoint";

type ProjectedFormField = Readonly<{
  fieldKey: string;
  command: RecordReferenceChoiceCommand;
  releaseVersion: "1.1.0" | "1.2.0";
  dependency?: Readonly<{ key: string; fromField: string }>;
}>;
type ProjectedForm = Readonly<{ fields: ReadonlyMap<string, ProjectedFormField> }>;
type GuidedControl = Readonly<{
  pageKey: string;
  pageId: string;
  flowId?: string;
  summary: boolean;
}>;
type ConfirmationReference = Readonly<{
  draftId: string;
  revision: number;
  issuedAt: number;
  signature: string;
}>;

type GuidedInvocationPage = Readonly<{
  page: Readonly<Record<string, unknown>>;
  pageId: string;
  guidedForm?: Readonly<{
    draftId: string;
    revision: number;
    flowId: string;
    computedStepId: string;
    values: Readonly<Record<string, JsonValue>>;
  }>;
  invocation: Readonly<{ installationRevision: number; releaseKey: string }>;
  subject?: Readonly<{ recordId: string; revision: number }>;
  bindings: Readonly<Record<string, readonly Readonly<{ event: string; bindingId: string }>[]>>;
}>;

type InvocationDependencies = Readonly<{
  authorityId: IdentityAuthorityId;
  /** The application catalogue's install and upgrade journeys, run under the initiator's authority. */
  applicationStore: ApplicationStoreService;
  channel: ProtectedOperationChannel;
  telemetry: NonNullable<Parameters<typeof createRecordSaveService>[0]["telemetry"]>;
  releaseCatalogue: Parameters<typeof createDatabaseApplicationBoundReleaseSetService>[0];
  continuationKey: QueryContinuationKey;
  guidedFormControls: (
    page: unknown,
    shells?: unknown,
  ) => Readonly<{ all: ReadonlySet<string>; summary?: string }> | undefined;
  guidedFormFlowId: (page: unknown, bindings: unknown, shells?: unknown) => string | undefined;
  confirmationKey: string;
  confirmationReference: (proof: unknown) => ConfirmationReference | undefined;
  verifiesConfirmation: (
    proof: unknown,
    details: Readonly<{
      pageId: string;
      flowId: string;
      sessionId: string;
      identityId: string;
      organizationId: string;
      applicationRootId: string;
      subjectRecordId?: string;
    }>,
  ) => Promise<boolean>;
  hasAuthoredForm: (application: ApplicationContent, formId: string) => boolean;
  projectForm: (
    session: IdentitySession,
    request: Readonly<{
      installationRevision: number;
      releaseKey: string;
      formId: string;
      subjectRecordId?: string;
    }>,
  ) => Promise<ProjectedForm | undefined>;
  resolveFormValues: (
    args: Readonly<{
      service: ReturnType<typeof createReferenceChoiceService>;
      session: IdentitySession;
      selection: OrganizationSelectionCandidate;
      application: ApplicationContent;
      modules: readonly ModuleDefinitionConsumerReadResult[];
      formId: string;
      projectedFields: ReadonlyMap<string, ProjectedFormField>;
      values: unknown;
      evidence?: unknown;
    }>,
  ) => Promise<Readonly<Record<string, JsonValue>> | undefined>;
  loadGuidedPage: (
    session: IdentitySession,
    guided: GuidedControl,
    subject: Readonly<{ recordId: string; revision: number }> | undefined,
  ) => Promise<GuidedInvocationPage | undefined>;
}>;

export type FlowInvocationAddress = Readonly<{
  read: Extract<PermittedApplicationsRead, { kind: "available" }>;
  application: PermittedApplication;
  /**
   * The installed context this same request's own HUMAN address read authorized the application
   * against. The invocation reuses it instead of reading the installation again.
   */
  installedContext?: InstalledRuntimeContext;
}>;
export type FlowInvocationRequest = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  applicationKey: string;
  pageKey: string;
  invocation: FlowBindingInvocation;
}>;

/** One log line per form-continuation or guided-binding refusal; the page keeps its neutral outcome. */
const logFlowRefusal = (code: string): void => {
  console.error(`[flows] invocation refused ${code}`);
};

type SelectedRecordReadField = Readonly<{
  alias: string;
  fieldId: string;
  type: FlowReadFieldsScalarType;
}>;

type SelectedRecordReadProjection = Readonly<{
  recordTypeId: string;
  fields: readonly SelectedRecordReadField[];
}>;

type SelectedRecordReadModule = Readonly<{
  moduleRootId: string;
  moduleReleaseRevision: number;
  storageContractId: string;
}>;

type InstalledSelectedRecordReadContext = Readonly<{
  projections: NonNullable<FlowRelease["selectedRecordReadProjections"]>;
  /** Flow input name to its one exact selected-record type, keyed by lower-case flow ID. */
  inputs: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Exact installed Module owning each read target, keyed by lower-case record type ID. */
  modules: ReadonlyMap<string, SelectedRecordReadModule>;
}>;

type ModuleDependency = Extract<ExactDefinitionDependency, { kind: "module" }>;

const moduleDependencyMatches = (
  dependency: ModuleDependency,
  release: ModuleDefinitionConsumerReadResult,
): boolean =>
  sameId(dependency.rootId, release.rootId) &&
  dependency.key === release.definitionKey &&
  dependency.releaseRevision === release.releaseRevision &&
  dependency.releaseVersion === release.releaseVersion &&
  dependency.contentFingerprint === release.contentFingerprint;

/** Resolve only the exact Module closure reachable from the installed Application manifests. */
const installedModuleClosure = (
  application: Readonly<{
    content: ApplicationContent;
    dependencyManifest: readonly ExactDefinitionDependency[];
  }>,
  releases: readonly ModuleDefinitionConsumerReadResult[],
): ReadonlyMap<string, ModuleDefinitionConsumerReadResult> | undefined => {
  const byRoot = new Map<string, ModuleDefinitionConsumerReadResult>();
  for (const release of releases) {
    const root = release.rootId.toLowerCase();
    if (byRoot.has(root)) return undefined;
    byRoot.set(root, release);
  }

  const directDependencies = application.dependencyManifest.filter(
    (entry): entry is ModuleDependency => entry.kind === "module",
  );
  if (directDependencies.length !== application.content.moduleBindings.length) return undefined;
  for (const binding of application.content.moduleBindings) {
    const matches = directDependencies.filter(
      (dependency) =>
        sameId(dependency.rootId, binding.moduleRootId) &&
        dependency.releaseVersion === binding.resolvedVersion,
    );
    if (matches.length !== 1) return undefined;
  }

  const reachable = new Map<string, ModuleDefinitionConsumerReadResult>();
  const pending = [...directDependencies];
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (dependency === undefined) continue;
    const root = dependency.rootId.toLowerCase();
    const release = byRoot.get(root);
    if (release === undefined || !moduleDependencyMatches(dependency, release)) return undefined;
    if (reachable.has(root)) continue;
    reachable.set(root, release);
    pending.push(
      ...release.dependencyManifest.filter(
        (entry): entry is ModuleDependency => entry.kind === "module",
      ),
    );
  }

  return reachable.size === releases.length ? reachable : undefined;
};

const installedSelectedRecordReadContext = (
  application: Readonly<{
    content: ApplicationContent;
    dependencyManifest: readonly ExactDefinitionDependency[];
  }>,
  releases: readonly ModuleDefinitionConsumerReadResult[],
): InstalledSelectedRecordReadContext | undefined => {
  const modules = installedModuleClosure(application, releases);
  if (modules === undefined) return undefined;

  const recordTypes = new Map<
    string,
    Array<
      Readonly<{
        module: ModuleDefinitionConsumerReadResult;
        recordType: ModuleDefinitionConsumerReadResult["content"]["recordTypes"][number];
      }>
    >
  >();
  const readModules = new Map<string, SelectedRecordReadModule>();
  for (const module of modules.values())
    for (const recordType of module.content.recordTypes) {
      const key = recordType.recordTypeId.toLowerCase();
      const owners = recordTypes.get(key) ?? [];
      owners.push({ module, recordType });
      recordTypes.set(key, owners);
    }

  const moduleByRoot = new Map(
    [...modules.values()].map((module) => [module.rootId.toLowerCase(), module] as const),
  );
  const moduleDependenciesFor = (rootId: string): Set<string> | undefined => {
    const root = rootId.toLowerCase();
    if (!moduleByRoot.has(root)) return undefined;
    const visited = new Set<string>();
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || visited.has(current)) continue;
      visited.add(current);
      const module = moduleByRoot.get(current);
      if (module === undefined) return undefined;
      for (const dependency of module.dependencyManifest)
        if (dependency.kind === "module") pending.push(dependency.rootId.toLowerCase());
    }
    visited.delete(root);
    return visited;
  };

  const projections = new Map<string, Map<string, SelectedRecordReadProjection>>();
  const inputs = new Map<string, Map<string, string>>();
  const seenFlowIds = new Set<string>();
  const flowOwners: Array<Readonly<{ flow: FlowDefinition; moduleRootId?: string }>> = [
    ...application.content.flows.map((flow) => ({ flow })),
    ...[...modules.values()].flatMap((module) =>
      module.content.flows.map((flow) => ({ flow, moduleRootId: module.rootId })),
    ),
  ];

  for (const { flow, moduleRootId } of flowOwners) {
    const flowId = String(flow.id);
    const normalizedFlowId = flowId.toLowerCase();
    if (seenFlowIds.has(normalizedFlowId)) return undefined;
    seenFlowIds.add(normalizedFlowId);
    const flowProjections = new Map<string, SelectedRecordReadProjection>();
    const flowInputs = new Map<string, string>();
    const seenTaskIds = new Set<string>();
    const moduleDependencies =
      moduleRootId === undefined ? undefined : moduleDependenciesFor(moduleRootId);
    if (moduleRootId !== undefined && moduleDependencies === undefined) return undefined;

    const visit = (tasks: readonly FlowTask[]): boolean => {
      for (const task of tasks) {
        const taskId = String(task.id);
        const normalizedTaskId = taskId.toLowerCase();
        if (seenTaskIds.has(normalizedTaskId)) return false;
        seenTaskIds.add(normalizedTaskId);
        if (task.type === "record.read_fields") {
          const compiled = task as FlowTask &
            Readonly<{
              properties?: Readonly<Record<string, unknown>>;
              readFieldTypes?: unknown;
            }>;
          const properties = compiled.properties;
          const recordTypeValue = properties?.record_type;
          const recordTypeLiteral =
            isRecord(recordTypeValue) && recordTypeValue.kind === "literal"
              ? recordTypeValue.literal
              : undefined;
          const recordTypeId =
            isRecord(recordTypeLiteral) && recordTypeLiteral.type === "text"
              ? recordTypeIdSchema.safeParse(recordTypeLiteral.value)
              : undefined;
          const fieldsValue = properties?.fields;
          const fieldsLiteral =
            isRecord(fieldsValue) && fieldsValue.kind === "literal"
              ? fieldsValue.literal
              : undefined;
          const fields =
            isRecord(fieldsLiteral) && fieldsLiteral.type === "json"
              ? flowReadFieldsProjectionSchema.safeParse(fieldsLiteral.value)
              : undefined;
          const fieldTypes = flowReadFieldsTypeMapSchema.safeParse(compiled.readFieldTypes);
          if (
            !recordTypeId?.success ||
            !fields?.success ||
            !fieldTypes.success ||
            Object.keys(fieldTypes.data).length !== fields.data.length ||
            flowProjections.has(taskId)
          )
            return false;

          const selectedRecordOwners = recordTypes.get(recordTypeId.data.toLowerCase()) ?? [];
          if (selectedRecordOwners.length !== 1) return false;
          const owner = selectedRecordOwners[0]!;
          const ownerRoot = owner.module.rootId.toLowerCase();
          if (
            (moduleDependencies !== undefined && !moduleDependencies.has(ownerRoot)) ||
            (moduleRootId !== undefined && sameId(moduleRootId, owner.module.rootId))
          )
            return false;

          const recordValue = properties?.record;
          const reference =
            isRecord(recordValue) && recordValue.kind === "reference"
              ? recordValue.reference
              : undefined;
          if (
            !isRecord(reference) ||
            reference.source !== "input" ||
            typeof reference.name !== "string"
          )
            return false;
          const inputName = reference.name;
          const declaration = flow.inputs[inputName];
          if (
            declaration === undefined ||
            declaration.type !== "record_reference" ||
            declaration.recordTypeIds?.length !== 1 ||
            !sameId(declaration.recordTypeIds[0]!, recordTypeId.data)
          )
            return false;
          const previousInputType = flowInputs.get(inputName);
          if (previousInputType !== undefined && !sameId(previousInputType, recordTypeId.data))
            return false;
          flowInputs.set(inputName, recordTypeId.data);

          const projectedFields: SelectedRecordReadField[] = [];
          const seenFieldIds = new Set<string>();
          for (const field of fields.data) {
            const fieldId = fieldIdSchema.safeParse(field.field);
            const scalarType = fieldTypes.data[field.alias];
            if (!fieldId.success || scalarType === undefined) return false;
            const normalizedFieldId = fieldId.data.toLowerCase();
            if (seenFieldIds.has(normalizedFieldId)) return false;
            seenFieldIds.add(normalizedFieldId);
            const matchingFields = owner.recordType.fields.filter((candidate) =>
              sameId(candidate.fieldId, fieldId.data),
            );
            if (
              matchingFields.length !== 1 ||
              flowReadFieldsScalarTypeForField(matchingFields[0]!.type) !== scalarType
            )
              return false;
            projectedFields.push({ alias: field.alias, fieldId: fieldId.data, type: scalarType });
          }

          flowProjections.set(taskId, {
            recordTypeId: recordTypeId.data,
            fields: projectedFields,
          });
          readModules.set(recordTypeId.data.toLowerCase(), {
            moduleRootId: owner.module.rootId,
            moduleReleaseRevision: owner.module.releaseRevision,
            storageContractId: owner.recordType.storageContractId,
          });
        }
        for (const child of flowTaskChildLists(task)) if (!visit(child.tasks)) return false;
      }
      return true;
    };

    if (!visit([...flow.tasks, ...flow.errors, ...flow.finally])) return undefined;
    if (flowProjections.size > 0) projections.set(flowId, flowProjections);
    if (flowInputs.size > 0) inputs.set(normalizedFlowId, flowInputs);
  }

  return { projections, inputs, modules: readModules };
};

const guidedClickId = (draftId: string, revision: number, bindingId: string): string => {
  const hex = createHash("sha256")
    .update(JSON.stringify([draftId, revision, bindingId]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
/**
 * Whether an installed flow declares the paused node a continuation target names (#544): a task
 * with that id anywhere in the flow and, for a form, a Show form task whose literal form matches
 * or whose dynamic form is checked against the active authored release. The stored run still pins
 * the exact node; this refuses a target the installed flow could never pause at before spending
 * the continuation.
 */
const declaresPausedNode = (
  flow: unknown,
  node: Readonly<{ nodeId: string; formId?: string }>,
): boolean => {
  if (typeof flow !== "object" || flow === null) return false;
  const definition = flow as Partial<Pick<FlowDefinition, "tasks" | "errors" | "finally">>;
  const find = (tasks: readonly FlowTask[] | undefined): FlowTask | undefined => {
    for (const task of tasks ?? []) {
      if (task.id === node.nodeId) return task;
      for (const child of flowTaskChildLists(task)) {
        const found = find(child.tasks);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const task = find(definition.tasks) ?? find(definition.errors) ?? find(definition.finally);
  if (task === undefined) return false;
  if (node.formId === undefined) return task.type === "interface.confirm";
  if (task.type !== "interface.show_form") return false;
  const form = (task as { properties?: Record<string, unknown> }).properties?.form as
    Readonly<{ kind?: unknown; literal?: Readonly<{ value?: unknown }> }> | undefined;
  // A form chosen by a reference or formula is only known at run time; the stored run pins it.
  if (form?.kind !== "literal") return form !== undefined;
  return String(form.literal?.value).toLowerCase() === node.formId.toLowerCase();
};
export async function invokeInstalledFlow(
  session: IdentitySession,
  body: FlowInvocationRequest,
  address: FlowInvocationAddress,
  dependencies: InvocationDependencies,
): Promise<FlowBindingEndpointResult> {
  const identity = { session };
  const telemetry = dependencies.telemetry;
  const authorityId = dependencies.authorityId;
  const requestDependencies = {
    identityAuthorityId: authorityId,
    telemetry,
    channel: dependencies.channel,
  };
  const requests = createHumanOrganizationRequestService({
    ...requestDependencies,
  });
  const referenceChoices = createReferenceChoiceService({
    ...requestDependencies,
    continuationKey: dependencies.continuationKey,
  });
  const selectedRecordReader = createViewerSafeRecordLinkReadService();
  const recordPinService = createViewerSafeRecordLinkService({
    ...requestDependencies,
    permissions: dependencies.releaseCatalogue.permissions,
    createInstalledContextLoader: (transaction, scope) => {
      if (scope.applicationRootId === undefined) throw new Error("RECORD_PIN_TARGET_UNAVAILABLE");
      return createHumanInstalledPageBundleContextLoader({
        transaction,
        scope: {
          organizationId: scope.organizationId,
          organizationAccountId: scope.organizationAccountId,
          applicationRootId: scope.applicationRootId,
          ...(scope.previewInstallationId === undefined
            ? {}
            : { previewInstallationId: scope.previewInstallationId }),
        },
      });
    },
    resolveTargetApplication: async (session, sourceSelection, applicationKey) => {
      if (
        canonicalJson(session) !== canonicalJson(identity.session) ||
        !sameId(sourceSelection.organizationId, address.read.organizationId) ||
        sourceSelection.applicationRootId === undefined ||
        !sameId(sourceSelection.applicationRootId, address.application.applicationRootId)
      )
        return undefined;
      const permitted = await readPermittedApplicationsAtAddress(
        dependencies.releaseCatalogue.permissions,
        session,
        body.tenantShortName,
        body.organizationShortName,
        authorityId,
        applicationKey,
      );
      if (
        permitted.kind !== "available" ||
        !sameId(permitted.organizationId, sourceSelection.organizationId)
      )
        return undefined;
      const targets = permitted.applications.filter((target) => target.key === applicationKey);
      const target = targets[0];
      return targets.length === 1 && target !== undefined
        ? { organizationId: permitted.organizationId, applicationRootId: target.applicationRootId }
        : undefined;
    },
  });
  const executor = createProtectedOperationExecutor({
    accessAdministration: createOrganizationAccessAdministrationService(requestDependencies),
    applicationStore: dependencies.applicationStore,
    tenantGovernance: {
      run: (session, selection, operation) =>
        requests.runAccessChange(session, selection, (transaction, scope) =>
          operation({
            tenantId: scope.tenantId,
            operations: createRequestBoundTenantGovernanceService(transaction, scope),
          }),
        ),
    },
  });
  const stores = createDatabaseFlowStores();
  // #1369, #1370: Save record tasks and named actions run through the record service's own
  // protected paths, under the initiator's verified request and in their own transactions.
  const records = createRecordSaveService(requestDependencies);
  const subjectReader = createPageSubjectReader(requestDependencies);
  const actionRecords = createNamedActionRecordPort(requestDependencies);
  const selectedRecordReadsFor = (installation: InstalledFlowBindings) => ({
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
          !sameId(session.identityId, identity.session.identityId) ||
          !sameId(selection.organizationId, installation.organizationId) ||
          selection.applicationRootId === undefined ||
          !sameId(selection.applicationRootId, installation.applicationRootId) ||
          !sameId(scope.organizationId, installation.organizationId) ||
          scope.applicationRootId === undefined ||
          !sameId(scope.applicationRootId, installation.applicationRootId)
        )
          return { outcome: "unavailable" } as const;

        return selectedRecordReader.readFields(transaction, scope, {
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

  const orchestratorFor = (
    release: FlowRelease,
    runId: string | undefined,
    installation: InstalledFlowBindings,
  ) =>
    createFlowOrchestrator({
      executor,
      records,
      actionRecords,
      subjects: {
        read: async (session, selection, subject) =>
          (await subjectReader.read(session, selection, subject)).kind,
      },
      selectedRecordReads: selectedRecordReadsFor(installation),
      currentRecords: createFlowCurrentRecordReader({
        requests,
        reader: selectedRecordReader,
        installation,
        identityId: identity.session.identityId,
      }),
      recordPins: {
        acquireIdentity: async (session, selection, selector) => {
          if (
            canonicalJson(session) !== canonicalJson(identity.session) ||
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
            const current = await createHumanInstalledPageBundleContextLoader({
              transaction,
              scope: {
                organizationId: scope.organizationId,
                organizationAccountId: scope.organizationAccountId,
                applicationRootId: scope.applicationRootId,
                ...(scope.previewInstallationId === undefined
                  ? {}
                  : { previewInstallationId: scope.previewInstallationId }),
              },
            }).load();
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
          return checked.kind === "available" && checked.value
            ? recordPinService.acquireIdentity(session, selection, selector)
            : { outcome: "unavailable" };
        },
      },
      authorizeInvocation: async (session, selection, flow) => {
        try {
          // Only this request's verified person and captured installed release may ask for a
          // decision. The permission identity comes from the compiled flow, never request JSON.
          if (
            canonicalJson(session) !== canonicalJson(identity.session) ||
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
          if (
            capturedOwner === undefined ||
            canonicalJson(flowSchema.parse(capturedOwner.flow)) !== canonicalJson(flow) ||
            canonicalJson(flowSchema.parse(installation.flows.get(String(flow.id)))) !==
              canonicalJson(flow)
          )
            return false;

          const checked = await requests.run(session, selection, async (transaction, scope) => {
            if (
              !sameId(scope.organizationId, installation.organizationId) ||
              scope.applicationRootId === undefined ||
              !sameId(scope.applicationRootId, installation.applicationRootId)
            )
              return false;
            const current = await createHumanInstalledPageBundleContextLoader({
              transaction,
              scope: {
                organizationId: scope.organizationId,
                organizationAccountId: scope.organizationAccountId,
                applicationRootId: scope.applicationRootId,
                ...(scope.previewInstallationId === undefined
                  ? {}
                  : { previewInstallationId: scope.previewInstallationId }),
              },
            }).load();
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
              canonicalJson(flowSchema.parse(currentOwner.flow)) !== canonicalJson(flow)
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
      continuations: stores.continuations,
      ledger: stores.ledger,
      // The release was read from the trusted installation for this exact request.
      resolveRelease: async () => release,
      ...(runId === undefined ? {} : { newRunId: () => runId }),
    });

  const guidedControls = new Map<
    string,
    Readonly<{
      pageKey: string;
      pageId: string;
      flowId?: string;
      summary: boolean;
    }> | null
  >();

  /** The flow bindings, flows and record types of one trusted installed context. */
  const installedFlowBindings = (installation: InstalledRuntimeContext): InstalledFlowBindings => {
    const releaseSet = installation.releaseSet;
    const application = releaseSet.application;
    guidedControls.clear();
    for (const page of application.content.pages) {
      if (page.type !== "guided_form") continue;
      const controls = dependencies.guidedFormControls(page, application.content.shells);
      if (controls === undefined) throw new Error("INVALID_GUIDED_FORM_CONTROLS");
      const flowId = dependencies.guidedFormFlowId(
        page,
        application.content.flowBindings,
        application.content.shells,
      );
      for (const controlId of controls.all) {
        const key = controlId.toLowerCase();
        guidedControls.set(
          key,
          guidedControls.has(key)
            ? null
            : {
                pageKey: page.key,
                pageId: String(page.pageId),
                ...(flowId === undefined ? {} : { flowId }),
                summary: key === controls.summary,
              },
        );
      }
    }
    const flows = new Map<string, unknown>();
    for (const flow of [
      ...application.content.flows,
      ...releaseSet.modules.flatMap((module) => module.content.flows),
    ]) {
      // One flow per identity: a Module flow never shadows an Application flow, and an
      // ambiguous release is refused rather than run.
      if (flows.has(String(flow.id))) throw new Error("FLOW_IDENTITY_AMBIGUOUS");
      flows.set(String(flow.id), flow);
    }
    const selectedReadContext = installedSelectedRecordReadContext(application, releaseSet.modules);
    if (selectedReadContext === undefined)
      throw new Error("SELECTED_RECORD_READ_BINDING_UNAVAILABLE");
    const installedActions = installedNamedActionDescriptors(application, releaseSet.modules);
    // Each record type's fields by key and by identity, for the values of a Save record task,
    // and the named action that declares it sets each choice option.
    const recordTypes = new Map<string, FlowRecordType>();
    for (const recordType of releaseSet.modules.flatMap((module) => module.content.recordTypes)) {
      const fieldIds = new Map<string, string>();
      const optionActions = new Map<string, ReadonlyMap<string, FlowNamedAction>>();
      for (const field of recordType.fields) {
        fieldIds.set(String(field.key).toLowerCase(), String(field.fieldId));
        fieldIds.set(String(field.fieldId).toLowerCase(), String(field.fieldId));
      }
      for (const { named, setsChoice } of installedActions) {
        if (
          setsChoice === undefined ||
          named.subjectRecordTypeId.toLowerCase() !== String(recordType.recordTypeId).toLowerCase()
        )
          continue;
        const linked = new Map(optionActions.get(setsChoice.fieldId.toLowerCase()));
        linked.set(setsChoice.option, named);
        optionActions.set(setsChoice.fieldId.toLowerCase(), linked);
      }
      recordTypes.set(String(recordType.recordTypeId).toLowerCase(), { fieldIds, optionActions });
    }
    const namedActions = installedNamedActions(application, releaseSet.modules);
    const installed: InstalledFlowBindings = {
      organizationId: installation.organizationId,
      applicationRootId: address.application.applicationRootId,
      installationRevision: installation.applicationReleaseRevision,
      releaseKey: [
        application.releaseVersion,
        application.contentFingerprint,
        application.resolutionFingerprint,
      ].join(":"),
      bindings: application.content.flowBindings,
      flows,
      recordTypes,
      namedActions,
      selectedRecordReadProjections: selectedReadContext.projections,
      selectedRecordReadInputs: selectedReadContext.inputs,
      selectedRecordReadModules: selectedReadContext.modules,
      applicationContent: application.content,
      modules: releaseSet.modules,
    };
    return installed;
  };

  /** The trusted active installation for the initiator's own selection; never from the request. */
  const readInstalled = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
  ): Promise<InstalledFlowBindings | undefined> => {
    // The address resolution of this same request already read the installed context under the
    // person's own verified scope for exactly this organisation and application; it is reused, so
    // the request does not decide the same access twice. The next request reads again.
    const carried = address.installedContext;
    if (
      carried !== undefined &&
      selection.applicationRootId !== undefined &&
      sameId(carried.organizationId, selection.organizationId) &&
      sameId(carried.applicationRootId, selection.applicationRootId)
    )
      return installedFlowBindings(carried);
    const read = await requests.run(session, selection, async (transaction, scope) => {
      if (scope.applicationRootId === undefined)
        throw new Error("INSTALLED_FLOW_BINDINGS_SCOPE_UNAVAILABLE");
      return installedFlowBindings(
        await createHumanInstalledPageBundleContextLoader({
          transaction,
          scope: {
            organizationId: scope.organizationId,
            organizationAccountId: scope.organizationAccountId,
            applicationRootId: scope.applicationRootId,
            ...(scope.previewInstallationId === undefined
              ? {}
              : { previewInstallationId: scope.previewInstallationId }),
          },
        }).load(),
      );
    });
    return read.kind === "available" ? read.value : undefined;
  };

  /**
   * #588: the #544 continuation interface over a fresh orchestrator bound to the trusted release.
   * It re-reads the active installation and checks the caller's target against it before the
   * orchestrator consumes the single-use continuation, so Page never duplicates that validation.
   */
  const continueForm = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    request: FormContinuationRequest,
  ): Promise<FormContinuationOutcome> => {
    const installed = await readInstalled(session, selection);
    if (installed === undefined) {
      logFlowRefusal("FORM_CONTINUATION_INSTALLATION_NOT_CURRENT");
      return { kind: "refused", reason: "unavailable" } as const;
    }
    const release: FlowRelease = {
      releaseKey: installed.releaseKey,
      flows: installed.flows,
      ...(installed.recordTypes === undefined ? {} : { recordTypes: installed.recordTypes }),
      ...(installed.namedActions === undefined ? {} : { namedActions: installed.namedActions }),
      ...(installed.selectedRecordReadProjections === undefined
        ? {}
        : { selectedRecordReadProjections: installed.selectedRecordReadProjections }),
    };
    // The Page request adapter forwards the exact evidence unchanged; the #544 interface is the
    // only place that compares it with trusted state and consumes the single-use continuation.
    const pageFormRequests = createPageFormRequestAdapter({
      continuation: createFormContinuationService({
        orchestrator: orchestratorFor(release, undefined, installed),
        resolveInstallation: async ({ installation, flowId, node }) => {
          // Another application is foreign, not stale: it gets the neutral refusal.
          if (
            installation.applicationRootId.toLowerCase() !==
            installed.applicationRootId.toLowerCase()
          ) {
            logFlowRefusal("FORM_CONTINUATION_FOREIGN_APPLICATION");
            return { kind: "unavailable" };
          }
          if (installation.installationReleaseRevision !== installed.installationRevision) {
            logFlowRefusal("FORM_CONTINUATION_STALE_INSTALLATION");
            return { kind: "stale" };
          }
          const flow = installed.flows.get(flowId);
          if (flow === undefined) {
            logFlowRefusal("FORM_CONTINUATION_FLOW_NOT_INSTALLED");
            return { kind: "unavailable" };
          }
          if (node !== undefined && !declaresPausedNode(flow, node)) {
            logFlowRefusal("FORM_CONTINUATION_NODE_NOT_DECLARED");
            return { kind: "unavailable" };
          }
          return { kind: "current", releaseKey: installed.releaseKey };
        },
      }),
    });
    const answer = request.answer;
    if (request.target.awaiting !== "form") {
      if (answer.kind !== "submit") return pageFormRequests.resume(session, selection, request);
      logFlowRefusal("FORM_CONTINUATION_SUBMIT_WITHOUT_FORM_PAUSE");
      return { kind: "refused", reason: "unavailable" };
    }

    const trustedFormId = request.target.formId;
    if (
      trustedFormId === undefined ||
      request.target.releaseKey !== installed.releaseKey ||
      request.target.installation.applicationRootId.toLowerCase() !==
        installed.applicationRootId.toLowerCase() ||
      request.target.installation.installationReleaseRevision !== installed.installationRevision ||
      !declaresPausedNode(installed.flows.get(request.target.flowId), {
        nodeId: request.target.nodeId,
        formId: trustedFormId,
      })
    ) {
      logFlowRefusal("FORM_CONTINUATION_TARGET_NOT_CURRENT");
      return { kind: "refused", reason: "unavailable" };
    }
    if (
      installed.applicationContent === undefined ||
      installed.modules === undefined ||
      !dependencies.hasAuthoredForm(installed.applicationContent, trustedFormId)
    ) {
      logFlowRefusal("FORM_CONTINUATION_FORM_NOT_AUTHORED");
      return { kind: "refused", reason: "unavailable" };
    }
    const projectedForm = await dependencies.projectForm(session, {
      installationRevision: installed.installationRevision,
      releaseKey: installed.releaseKey,
      formId: trustedFormId,
    });
    if (projectedForm === undefined) {
      logFlowRefusal("FORM_CONTINUATION_FORM_NOT_PROJECTED");
      return { kind: "refused", reason: "unavailable" };
    }
    if (answer.kind !== "submit") return pageFormRequests.resume(session, selection, request);
    const values = await dependencies.resolveFormValues({
      service: referenceChoices,
      session,
      selection,
      application: installed.applicationContent,
      modules: installed.modules,
      formId: trustedFormId,
      projectedFields: projectedForm.fields,
      values: answer.values,
      ...(answer.choiceEvidence === undefined ? {} : { evidence: answer.choiceEvidence }),
    });
    if (values === undefined) {
      logFlowRefusal("FORM_CONTINUATION_VALUES_NOT_RESOLVED");
      return { kind: "refused", reason: "unavailable" };
    }
    return pageFormRequests.resume(session, selection, {
      ...request,
      answer: { kind: "submit", values },
    });
  };

  const invocation = body.invocation;
  const selection = {
    organizationId: address.read.organizationId,
    applicationRootId: address.application.applicationRootId,
    ...(address.application.previewInstallationId === undefined
      ? {}
      : { previewInstallationId: address.application.previewInstallationId }),
  };
  // Use the same installed snapshot for this gate and the endpoint. A crafted action on a
  // guided page must not start a flow before its final form submit is confirmed.
  const bindingInstallation =
    invocation.kind === "binding" ? await readInstalled(identity.session, selection) : undefined;
  if (invocation.kind === "binding") {
    if (bindingInstallation === undefined) {
      logFlowRefusal("BINDING_INSTALLATION_NOT_CURRENT");
      return { kind: "refused" };
    }
    const binding = bindingInstallation.bindings.find(
      (candidate) => candidate.bindingId.toLowerCase() === invocation.bindingId.toLowerCase(),
    );
    const guided =
      binding === undefined ? undefined : guidedControls.get(binding.controlId.toLowerCase());
    if (
      guided !== undefined &&
      (guided === null || !guided.summary || binding?.event !== "form_submit")
    ) {
      logFlowRefusal("BINDING_GUIDED_CONTROL_NOT_CONFIRMED");
      return { kind: "refused" };
    }
    // A Records table row, bulk or inline-edit command runs only for a command the installed
    // placement declares (a grid feature only while it is on) and rows the viewer may use now.
    const featureRefusal =
      binding === undefined
        ? undefined
        : await recordsTableBindingRefusal(
            bindingInstallation,
            binding,
            invocation.callerInputs ?? {},
            invocation.subject,
            (operation) => requests.run(identity.session, selection, operation),
          );
    if (featureRefusal !== undefined) {
      logRecordsTableRequestRefusal(featureRefusal, "flow_dispatch");
      logFlowRefusal("BINDING_GRID_FEATURE_NOT_PROJECTED");
      return { kind: "refused" };
    }
  }

  const adaptFormSubmit = createPrivateFormSubmitAdapter();
  const endpoint = createFlowBindingEndpoint({
    readInstallation:
      invocation.kind === "binding" ? async () => bindingInstallation : readInstalled,
    adaptFormSubmit: async (binding, callerInputs, subject, installation) => {
      const resolveValues = async (values: unknown) => {
        if (installation.applicationContent === undefined || installation.modules === undefined)
          return undefined;
        const projectedForm = await dependencies.projectForm(identity.session, {
          installationRevision: installation.installationRevision,
          releaseKey: installation.releaseKey,
          formId: binding.controlId,
          ...(subject === undefined ? {} : { subjectRecordId: subject.recordId }),
        });
        if (projectedForm === undefined) return undefined;
        const resolvedValues = await dependencies.resolveFormValues({
          service: referenceChoices,
          session: identity.session,
          selection,
          application: installation.applicationContent,
          modules: installation.modules,
          formId: binding.controlId,
          projectedFields: projectedForm.fields,
          values,
          ...(callerInputs.choiceEvidence === undefined
            ? {}
            : { evidence: callerInputs.choiceEvidence }),
        });
        return resolvedValues === undefined
          ? undefined
          : { fields: projectedForm.fields, values: resolvedValues };
      };
      const adaptSelectedReadInputs = (
        adaptedInputs: Readonly<Record<string, unknown>>,
        resolved: NonNullable<Awaited<ReturnType<typeof resolveValues>>>,
      ): Readonly<Record<string, unknown>> | undefined => {
        const selectedReadInputs = installation.selectedRecordReadInputs?.get(
          String(binding.flow.flowId).toLowerCase(),
        );
        if (selectedReadInputs === undefined || selectedReadInputs.size === 0) return adaptedInputs;

        const result: Record<string, unknown> = { ...adaptedInputs };
        const selectedCallerNames = new Set<string>();
        for (const [flowInputName, declaredRecordTypeId] of selectedReadInputs) {
          const flowInput = binding.flow.inputs[flowInputName];
          if (
            !isRecord(flowInput) ||
            flowInput.kind !== "caller" ||
            typeof flowInput.name !== "string"
          )
            return undefined;
          const callerInputName = flowInput.name;
          const matchingCallerInputs = Object.values(binding.flow.inputs).filter(
            (candidate) =>
              isRecord(candidate) &&
              candidate.kind === "caller" &&
              candidate.name === callerInputName,
          );
          if (
            matchingCallerInputs.length !== 1 ||
            selectedCallerNames.has(callerInputName) ||
            !Object.hasOwn(adaptedInputs, callerInputName)
          )
            return undefined;
          selectedCallerNames.add(callerInputName);

          const choiceField = resolved.fields.get(callerInputName);
          if (
            choiceField === undefined ||
            choiceField.command.kind !== "record_reference" ||
            choiceField.command.allowedRecordTypes.length !== 1
          )
            return undefined;
          const choiceRecordType = choiceField.command.allowedRecordTypes[0];
          const selectedReadModule = installation.selectedRecordReadModules?.get(
            declaredRecordTypeId.toLowerCase(),
          );
          if (
            choiceRecordType?.state !== "resolved" ||
            !sameId(choiceRecordType.recordTypeId, declaredRecordTypeId) ||
            selectedReadModule === undefined ||
            !sameId(choiceRecordType.moduleRootId, selectedReadModule.moduleRootId)
          )
            return undefined;

          const selectedValue = resolved.values[callerInputName];
          if (
            !isRecord(selectedValue) ||
            Object.keys(selectedValue).length !== 2 ||
            !Object.hasOwn(selectedValue, "recordTypeId") ||
            !Object.hasOwn(selectedValue, "recordId") ||
            typeof selectedValue.recordTypeId !== "string" ||
            !sameId(selectedValue.recordTypeId, choiceRecordType.recordTypeId) ||
            adaptedInputs[callerInputName] !== selectedValue
          )
            return undefined;
          const recordId = recordIdSchema.safeParse(selectedValue.recordId);
          if (!recordId.success) return undefined;
          result[callerInputName] = {
            recordTypeId: choiceRecordType.recordTypeId,
            recordId: recordId.data,
          };
        }
        return result;
      };
      const guided = guidedControls.get(binding.controlId.toLowerCase());
      if (guided === undefined) {
        if (
          isRecord(callerInputs.values) &&
          Object.hasOwn(callerInputs.values, dependencies.confirmationKey)
        )
          return undefined;
        const resolved = await resolveValues(callerInputs.values);
        if (resolved === undefined) return undefined;
        const adapterInputs: Record<string, unknown> = { ...callerInputs };
        delete adapterInputs.choiceEvidence;
        const adaptedInputs = adaptFormSubmit(
          binding,
          { ...adapterInputs, values: resolved.values },
          subject,
        );
        return adaptedInputs === undefined
          ? undefined
          : adaptSelectedReadInputs(adaptedInputs, resolved);
      }
      if (
        guided === null ||
        !guided.summary ||
        guided.flowId === undefined ||
        guided.flowId.toLowerCase() !== String(binding.flow.flowId).toLowerCase()
      )
        return undefined;
      const submitted = callerInputs.values;
      if (
        !isRecord(submitted) ||
        Object.keys(submitted).length !== 1 ||
        !Object.hasOwn(submitted, dependencies.confirmationKey)
      )
        return undefined;
      const proof = submitted[dependencies.confirmationKey];
      const reference = dependencies.confirmationReference(proof);
      if (reference === undefined) return undefined;
      if (
        !(await dependencies.verifiesConfirmation(proof, {
          pageId: guided.pageId,
          flowId: guided.flowId,
          sessionId: identity.session.sessionId,
          identityId: identity.session.identityId,
          organizationId: address.read.organizationId,
          applicationRootId: address.application.applicationRootId,
          ...(subject === undefined ? {} : { subjectRecordId: subject.recordId }),
        }))
      )
        return undefined;
      const model = await dependencies.loadGuidedPage(identity.session, guided, subject);
      const draft = model?.guidedForm;
      const summary = Array.isArray(model?.page.steps)
        ? model.page.steps.find((step) => isRecord(step) && step.summary === true)
        : undefined;
      if (
        model === undefined ||
        draft === undefined ||
        !isRecord(summary) ||
        typeof summary.id !== "string" ||
        guided.flowId === undefined ||
        String(model.pageId).toLowerCase() !== guided.pageId.toLowerCase() ||
        draft.computedStepId !== summary.id ||
        model.invocation.installationRevision !== body.invocation.installationRevision ||
        model.invocation.releaseKey !== body.invocation.releaseKey ||
        draft.draftId.toLowerCase() !== reference.draftId.toLowerCase() ||
        draft.revision !== reference.revision ||
        draft.flowId.toLowerCase() !== guided.flowId.toLowerCase() ||
        (model.subject?.recordId.toLowerCase() ?? null) !==
          (subject?.recordId.toLowerCase() ?? null) ||
        (subject !== undefined && model.subject?.revision !== subject.revision) ||
        !(model.bindings[binding.controlId] ?? []).some(
          (held) =>
            held.event === "form_submit" &&
            held.bindingId.toLowerCase() === String(binding.bindingId).toLowerCase(),
        )
      )
        return undefined;
      const resolved = await resolveValues(draft.values);
      if (resolved === undefined) return undefined;
      const adaptedInputs = adaptFormSubmit(
        binding,
        {
          values: resolved.values,
          ...(callerInputs.selectedOwnerGroupId === undefined
            ? {}
            : { selectedOwnerGroupId: callerInputs.selectedOwnerGroupId }),
        },
        subject,
      );
      return adaptedInputs === undefined
        ? undefined
        : adaptSelectedReadInputs(adaptedInputs, resolved);
    },
    continueForm,
    orchestratorFor,
  });

  const submittedValues =
    invocation.kind === "binding" ? invocation.callerInputs?.values : undefined;
  const confirmation = isRecord(submittedValues)
    ? dependencies.confirmationReference(submittedValues[dependencies.confirmationKey])
    : undefined;
  const invocationWithStableClick =
    invocation.kind === "binding" && confirmation !== undefined
      ? {
          ...invocation,
          clickId: guidedClickId(confirmation.draftId, confirmation.revision, invocation.bindingId),
        }
      : invocation;
  const result = await endpoint.invoke(identity.session, selection, invocationWithStableClick);
  return result;
}
