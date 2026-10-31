import {
  buildLinkTilesQueryBinding,
  flowEntrySegments,
  formFieldOf,
  installedNamedActions,
  messageActionBindings,
  readOrganizationRuntimeSettings,
  type HumanOrganizationRequestDependencies,
  type InstalledRuntimeContext,
  type FlowPlanSet,
} from "@vortex/platform/server";
import {
  ATTACHMENT_LIST_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  QUERY_NOTICE_BLOCK_RELEASE,
  LINK_TILES_BLOCK_RELEASE,
} from "@vortex/platform/server";
import {
  type BlockPropertyValueContract,
  recordsTableContractOrLog,
  readRecordDetailContract,
  type FlowDefinition,
  type FlowTask,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  flowTaskChildLists,
  type PageDefinition,
  pageSemanticEventKinds,
  sameId,
  isRecord,
} from "@vortex/platform/schema";
import type { collectPlacements } from "./placement-helpers";
import type { PlacementFlowBinding } from "./types";
import { isEditFieldPlacement, selectedReadInputTypes } from "./placement-helpers";
import { isTablePlacement, resolvedQueryRecordTypeId } from "@vortex/platform/server";
import { humanOrganizationRequests } from "../server-composition";

/** Read the bound page's organisation time zone under the same authority as its other reads. */
export const readFlowOrganizationTimeZone = (
  input: Readonly<{
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    dependencies: HumanOrganizationRequestDependencies;
  }>,
) =>
  humanOrganizationRequests(input.dependencies.identityAuthorityId).run(
    input.session,
    input.selection,
    async (transaction, scope) => {
      const settings = await readOrganizationRuntimeSettings(transaction);
      if (settings === undefined) throw new Error("FLOW_ORGANIZATION_TIME_ZONE_UNAVAILABLE");
      return { timeZone: settings.timeZone, accessVersion: scope.accessVersion };
    },
  );

export const projectPlacementRecordTypes = (input: {
  allPlacements: ReturnType<typeof collectPlacements>;
  pageDefinition: PageDefinition;
  pageSubjectRecordTypeId: string | undefined;
  context: InstalledRuntimeContext;
  editFormPlacementIds: ReadonlySet<string>;
  /** The one record type a control on the page selects, for a Record detail showing it. */
  selectedRecordType: (control: string) => string | undefined;
}) => {
  const { allPlacements, pageDefinition, pageSubjectRecordTypeId, context, editFormPlacementIds } =
    input;
  const recordTypeByPlacement = new Map<string, string>();
  const dataPlacementsByRecordType = new Map<string, string[]>();
  const editFormDataPlacementIds = new Map<string, string[]>();
  const addDataPlacement = (recordTypeId: string, placementId: string): void => {
    const key = recordTypeId.toLowerCase();
    const current = dataPlacementsByRecordType.get(key) ?? [];
    if (!current.some((candidate) => sameId(candidate, placementId)))
      dataPlacementsByRecordType.set(key, [...current, placementId]);
  };
  for (const placement of allPlacements) {
    const { placementId } = placement;
    const block = placement.vortex.block;
    const isAttachmentListBlock =
      isRecord(block) &&
      typeof block.blockId === "string" &&
      sameId(block.blockId, ATTACHMENT_LIST_BLOCK_RELEASE.blockId) &&
      block.releaseVersion === ATTACHMENT_LIST_BLOCK_RELEASE.releaseVersion;
    if (isAttachmentListBlock) {
      if (
        pageDefinition.type === "detail" &&
        placement.vortex.queryId === undefined &&
        pageSubjectRecordTypeId !== undefined
      ) {
        recordTypeByPlacement.set(placementId.toLowerCase(), pageSubjectRecordTypeId);
        addDataPlacement(pageSubjectRecordTypeId, placementId);
      }
      continue;
    }
    if (
      pageSubjectRecordTypeId !== undefined &&
      isRecord(block) &&
      typeof block.blockId === "string" &&
      sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
    )
      recordTypeByPlacement.set(placementId.toLowerCase(), pageSubjectRecordTypeId);

    const settings = placement.settings as Readonly<Record<string, BlockPropertyValueContract>>;
    const tableContract = isTablePlacement(placement)
      ? recordsTableContractOrLog(settings, "flow bindings")
      : undefined;
    const detailContract =
      tableContract === undefined ? readRecordDetailContract(settings) : undefined;
    const isQueryNoticeBlock =
      isRecord(block) &&
      typeof block.blockId === "string" &&
      sameId(block.blockId, QUERY_NOTICE_BLOCK_RELEASE.blockId) &&
      block.releaseVersion === QUERY_NOTICE_BLOCK_RELEASE.releaseVersion;
    const isLinkTilesBlock =
      isRecord(block) &&
      typeof block.blockId === "string" &&
      sameId(block.blockId, LINK_TILES_BLOCK_RELEASE.blockId) &&
      block.releaseVersion === LINK_TILES_BLOCK_RELEASE.releaseVersion;
    if (
      tableContract === undefined &&
      detailContract === undefined &&
      !isQueryNoticeBlock &&
      !isLinkTilesBlock
    )
      continue;

    const queryId =
      typeof placement.vortex.queryId === "string" ? placement.vortex.queryId : undefined;
    const recordFrom = settings["record_from"];
    const recordTypeId =
      queryId === undefined
        ? detailContract === undefined || pageDefinition.type === "form"
          ? undefined
          : recordFrom?.kind === "text"
            ? input.selectedRecordType(recordFrom.value)
            : pageSubjectRecordTypeId
        : isLinkTilesBlock
          ? buildLinkTilesQueryBinding(context, queryId, settings, {})?.recordTypeId
          : resolvedQueryRecordTypeId(context, queryId);
    if (recordTypeId === undefined) continue;
    recordTypeByPlacement.set(placementId.toLowerCase(), recordTypeId);
    addDataPlacement(recordTypeId, placementId);
  }
  if (pageSubjectRecordTypeId !== undefined) {
    for (const formId of editFormPlacementIds) {
      const formDataPlacementIds = [formId];
      for (const placement of allPlacements) {
        const { placementId, formId: ownerFormId } = placement;
        if (ownerFormId === undefined || !sameId(ownerFormId, formId)) continue;
        if (!isEditFieldPlacement(placement)) continue;
        recordTypeByPlacement.set(placementId.toLowerCase(), pageSubjectRecordTypeId);
        formDataPlacementIds.push(placementId);
      }
      editFormDataPlacementIds.set(formId.toLowerCase(), formDataPlacementIds);
    }
  }
  return { recordTypeByPlacement, dataPlacementsByRecordType, editFormDataPlacementIds };
};

export const projectFlowBindingTargets = (input: {
  application: InstalledRuntimeContext["releaseSet"]["application"];
  context: InstalledRuntimeContext;
  allPlacements: ReturnType<typeof collectPlacements>;
  recordTypeByPlacement: Map<string, string>;
  pageSubjectRecordTypeId: string | undefined;
  editFormPlacementIds: ReadonlySet<string>;
  dataPlacementsByRecordType: Map<string, string[]>;
  editFormDataPlacementIds: Map<string, string[]>;
}) => {
  const {
    application,
    context,
    allPlacements,
    recordTypeByPlacement,
    pageSubjectRecordTypeId,
    editFormPlacementIds,
    dataPlacementsByRecordType,
    editFormDataPlacementIds,
  } = input;
  const refreshPlacementsByBinding: Record<string, readonly string[]> = {};
  const flowsById = new Map(
    application.content.flows.map((flow) => [String(flow.id).toLowerCase(), flow] as const),
  );
  const selectedReadTypesByFlow = new Map<string, ReadonlyMap<string, string>>();
  const ambiguousSelectedReadFlowIds = new Set<string>();
  for (const flow of [
    ...application.content.flows,
    ...context.releaseSet.modules.flatMap((module) => module.content.flows),
  ]) {
    const flowId = String(flow.id).toLowerCase();
    if (ambiguousSelectedReadFlowIds.has(flowId)) continue;
    if (selectedReadTypesByFlow.has(flowId)) {
      selectedReadTypesByFlow.delete(flowId);
      ambiguousSelectedReadFlowIds.add(flowId);
      continue;
    }
    selectedReadTypesByFlow.set(flowId, selectedReadInputTypes(flow));
  }
  const actionRecordTypes = new Map(
    [
      ...application.content.actions,
      ...context.releaseSet.modules.flatMap((module) => module.content.actions),
    ].map(
      (action) =>
        [
          String(action.key).toLowerCase(),
          [
            String(action.subjectRecordTypeId),
            ...(action.writePolicy?.creates.map((create) => String(create.recordTypeId)) ?? []),
          ],
        ] as const,
    ),
  );
  const flowWrittenRecordTypes = (flowId: string): readonly string[] => {
    const types = new Set<string>();
    const visited = new Set<string>();
    const literal = (task: FlowTask, name: string): string | undefined => {
      const properties = "properties" in task ? task.properties : undefined;
      const value = properties?.[name];
      return isRecord(value) &&
        value.kind === "literal" &&
        isRecord(value.literal) &&
        value.literal.type === "text" &&
        typeof value.literal.value === "string"
        ? value.literal.value
        : undefined;
    };
    const visitFlow = (id: string): void => {
      const key = id.toLowerCase();
      if (visited.has(key)) return;
      visited.add(key);
      const flow = flowsById.get(key);
      if (flow === undefined) return;
      const visitTasks = (tasks: readonly FlowTask[]): void => {
        for (const task of tasks) {
          if (task.type === "run_flow")
            visitFlow(String((task as Extract<FlowTask, { type: "run_flow" }>).flowId));
          if (
            [
              "record.save",
              "record.create",
              "record.set_fields",
              "record.delete",
              "record.restore",
              "record.changes",
            ].includes(task.type)
          ) {
            const recordType = literal(task, "record_type");
            if (recordType !== undefined) types.add(recordType);
          } else if (task.type === "operation.call") {
            const operation = literal(task, "operation");
            for (const recordType of operation === undefined
              ? []
              : (actionRecordTypes.get(operation.toLowerCase()) ?? []))
              types.add(recordType);
          }
          for (const child of flowTaskChildLists(task)) visitTasks(child.tasks);
        }
      };
      visitTasks(flow.tasks);
      visitTasks(flow.errors);
      visitTasks(flow.finally);
    };
    visitFlow(flowId);
    return [...types];
  };
  for (const { placementId, formId } of allPlacements) {
    const held = application.content.flowBindings.filter((binding) =>
      sameId(String(binding.controlId), placementId),
    );
    if (held.length === 0) continue;
    const sourceRecordTypeId =
      recordTypeByPlacement.get(placementId.toLowerCase()) ??
      (formId === undefined ? undefined : recordTypeByPlacement.get(formId.toLowerCase())) ??
      pageSubjectRecordTypeId;
    const editFormId = editFormPlacementIds.has(placementId)
      ? placementId
      : formId !== undefined && editFormPlacementIds.has(formId)
        ? formId
        : undefined;
    for (const binding of held) {
      const writtenTypes = flowWrittenRecordTypes(String(binding.flow.flowId));
      const targetTypes =
        writtenTypes.length > 0
          ? writtenTypes
          : sourceRecordTypeId === undefined
            ? []
            : [sourceRecordTypeId];
      const queryTargets = targetTypes.flatMap(
        (recordTypeId) => dataPlacementsByRecordType.get(recordTypeId.toLowerCase()) ?? [],
      );
      const formTargets =
        editFormId === undefined ||
        pageSubjectRecordTypeId === undefined ||
        !targetTypes.some((recordTypeId) => sameId(recordTypeId, pageSubjectRecordTypeId))
          ? []
          : (editFormDataPlacementIds.get(editFormId.toLowerCase()) ?? []);
      const targets = [...new Set([...queryTargets, ...formTargets])];
      if (targets.length > 0) refreshPlacementsByBinding[String(binding.bindingId)] = targets;
    }
  }
  return { refreshPlacementsByBinding, flowsById, selectedReadTypesByFlow };
};

/** The flow bindings one placement holds, projected for the browser by placement identity. */
/** The task types an agent may start only with the person's confirmation. */
const agentConfirmedTaskTypes = new Set(["record.delete", "record.changes", "backend.run"]);

/** The named action a Call protected operation task names, when it is a literal one. */
const calledOperationKey = (task: FlowTask): string | undefined => {
  if (task.type !== "operation.call") return undefined;
  const operation = (task.properties as Readonly<Record<string, unknown>>).operation;
  return isRecord(operation) &&
    operation.kind === "literal" &&
    isRecord(operation.literal) &&
    typeof operation.literal.value === "string"
    ? operation.literal.value
    : undefined;
};

/**
 * Whether a flow reaches a delete, a set of record changes or a back-end run, itself or through a
 * named action it calls, before its own steps ask the person to confirm. Only a confirmation that
 * always runs first counts: one in a branch may be skipped.
 */
const changesBeforeConfirming = (
  tasks: readonly FlowTask[],
  namedFlow: (operationKey: string) => FlowDefinition | undefined,
): boolean => {
  const seen = new Set<string>();
  const changes = (list: readonly FlowTask[]): boolean =>
    list.some((task) => {
      if (agentConfirmedTaskTypes.has(task.type)) return true;
      const key = calledOperationKey(task);
      const called = key === undefined || seen.has(key) ? undefined : namedFlow(key);
      if (key !== undefined) seen.add(key);
      if (called !== undefined && changes(called.tasks)) return true;
      return flowTaskChildLists(task).some((child) => changes(child.tasks));
    });
  for (const task of tasks) {
    if (task.type === "interface.confirm") return false;
    if (changes([task])) return true;
  }
  return false;
};

/** The named actions of one installed context, read once per context. */
const namedActionsByContext = new WeakMap<
  InstalledRuntimeContext,
  ReturnType<typeof installedNamedActions>
>();
const namedActionsOf = (context: InstalledRuntimeContext) => {
  const held = namedActionsByContext.get(context);
  if (held !== undefined) return held;
  const actions = installedNamedActions(
    context.releaseSet.application,
    context.releaseSet.modules,
    context.recordContributions,
  );
  namedActionsByContext.set(context, actions);
  return actions;
};

export const projectPlacementBindings = (
  input: Readonly<{
    application: InstalledRuntimeContext["releaseSet"]["application"];
    context: InstalledRuntimeContext;
    plans: FlowPlanSet;
    recordTypeByPlacement: Map<string, string>;
    bindings: Record<string, PlacementFlowBinding[]>;
    pageDefinition: PageDefinition;
    pageSubjectRecordTypeId: string | undefined;
    selectedReadTypesByFlow: Map<string, ReadonlyMap<string, string>>;
  }>,
  placement: ReturnType<typeof collectPlacements>[number],
): void => {
  const { placementId, formId } = placement;
  const {
    application,
    context,
    plans,
    recordTypeByPlacement,
    bindings,
    pageDefinition,
    pageSubjectRecordTypeId,
    selectedReadTypesByFlow,
  } = input;
  const authored = application.content.flowBindings.filter((binding) =>
    sameId(binding.controlId, placementId),
  );
  const held = authored.flatMap((binding) => [
    { binding, messageAction: undefined },
    ...messageActionBindings(binding, [...plans.flows.values()]).map((derived) => ({
      binding: derived.binding,
      messageAction: {
        authoredBindingId: derived.authoredBindingId,
        sourceFlowId: derived.sourceFlowId,
        taskId: derived.taskId,
      },
    })),
  ]);
  if (held.length > 0) {
    const placementRecordTypeId =
      recordTypeByPlacement.get(placementId.toLowerCase()) ??
      (formId === undefined ? undefined : recordTypeByPlacement.get(formId.toLowerCase()));
    bindings[placementId] = held.map(({ binding, messageAction }) => {
      // An action selects the page subject, so a foreign placement cannot lend it a record type.
      const selectedRecordTypeId =
        binding.event === "action" ||
        pageSemanticEventKinds.some((event) => event === binding.event)
          ? (pageDefinition.type === "detail" || pageDefinition.type === "form") &&
            pageSubjectRecordTypeId !== undefined &&
            (placementRecordTypeId === undefined ||
              sameId(placementRecordTypeId, pageSubjectRecordTypeId))
            ? pageSubjectRecordTypeId
            : undefined
          : placementRecordTypeId;
      const selectedReadTypes =
        selectedReadTypesByFlow.get(String(binding.flow.flowId).toLowerCase()) ??
        new Map<string, string>();
      const selectedReadInputs = Object.entries(binding.flow.inputs).flatMap(
        ([inputName, input]) => {
          const selectedRecordTypeId = selectedReadTypes.get(inputName);
          return selectedRecordTypeId !== undefined &&
            isRecord(input) &&
            input.kind === "caller" &&
            typeof input.name === "string"
            ? [{ callerInputName: input.name, recordTypeId: selectedRecordTypeId }]
            : [];
        },
      );
      const savesValues = (tasks: readonly FlowTask[]): boolean =>
        tasks.some((task) => {
          if (task.type === "record.save") {
            const value = task.properties.values;
            if (
              isRecord(value) &&
              value.kind === "reference" &&
              isRecord(value.reference) &&
              value.reference.source === "input" &&
              typeof value.reference.name === "string"
            ) {
              const input = binding.flow.inputs[value.reference.name];
              if (isRecord(input) && input.kind === "caller" && input.name === "values")
                return true;
            }
          }
          return flowTaskChildLists(task).some((child) => savesValues(child.tasks));
        });
      const flow = plans.flows.get(String(binding.flow.flowId));
      if (flow === undefined) throw new Error("FLOW_BINDING_DEFINITION_UNAVAILABLE");
      // An agent may delete, change records in bulk or start a back-end run only after the person
      // confirms it; a flow whose own steps confirm first needs no second question.
      const agentConfirmation =
        binding.event === "bulk_action" ||
        binding.event === "batch_edit" ||
        changesBeforeConfirming(flow.tasks, (operationKey) => {
          const flowId = namedActionsOf(context).get(operationKey)?.flowId;
          return flowId === undefined ? undefined : plans.flows.get(String(flowId));
        });
      const label = placement.settings.label;
      const recordType = context.releaseSet.modules
        .flatMap((module) => module.content.recordTypes)
        .find(
          (entry) =>
            placementRecordTypeId !== undefined &&
            sameId(entry.recordTypeId, placementRecordTypeId),
        );
      const field = recordType === undefined ? undefined : formFieldOf(placement, recordType);
      const name = placement.settings.name;
      const controlName =
        isRecord(label) &&
        label.kind === "text" &&
        typeof label.value === "string" &&
        label.value.trim()
          ? label.value.trim()
          : (field?.label ??
            (isRecord(name) && name.kind === "text" && typeof name.value === "string"
              ? name.value.replaceAll("_", " ")
              : (flow.labels.name ?? flow.key.replaceAll("_", " "))));
      const fullPlan = plans.plans.get(String(binding.flow.flowId));
      if (fullPlan === undefined) throw new Error("FLOW_BINDING_PLAN_UNAVAILABLE");
      const entrySegments = flowEntrySegments(fullPlan);
      const plan = fullPlan.browser;
      const pageInputs =
        plan === undefined
          ? {}
          : Object.fromEntries(
              Object.entries(binding.flow.inputs).filter(([name]) =>
                Object.hasOwn(plan.inputs, name),
              ),
            );
      return {
        ...(messageAction === undefined ? {} : { messageAction }),
        browser: { plan, inputs: pageInputs },
        savesFormValues: flow !== undefined && savesValues(flow.tasks),
        ...(agentConfirmation ? { agentConfirmation: true } : {}),
        bindingId: binding.bindingId,
        controlId: binding.controlId,
        controlName,
        flowName: flow.labels.name ?? flow.key.replaceAll("_", " "),
        ...(formId === undefined ? {} : { formId }),
        eventId: binding.eventId,
        event: binding.event,
        flowId: binding.flow.flowId,
        settings: binding.settings,
        entrySegments: entrySegments.map((segment) => ({
          segmentId: segment.id,
          fingerprint: segment.fingerprint,
        })),
        callerInputs: Object.values(binding.flow.inputs).flatMap((input) =>
          typeof input === "object" && input !== null && input.kind === "caller"
            ? [input.name]
            : [],
        ),
        ...(selectedRecordTypeId === undefined ? {} : { recordTypeId: selectedRecordTypeId }),
        ...(selectedReadInputs.length === 0 ? {} : { selectedReadInputs }),
      };
    });
  }
};
