import { buildLinkTilesQueryBinding, type InstalledRuntimeContext } from "@vortex/platform/server";
import {
  ATTACHMENT_LIST_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  QUERY_NOTICE_BLOCK_RELEASE,
  LINK_TILES_BLOCK_RELEASE,
} from "@vortex/platform/server";
import {
  type BlockPropertyValueContract,
  readRecordsTableContract,
  readRecordDetailContract,
  type FlowTask,
  flowTaskChildLists,
  type PageDefinition,
  sameId,
  isRecord,
} from "@vortex/platform/schema";
import type { collectPlacements } from "./placement-helpers";
import type { PlacementFlowBinding } from "./types";
import { isEditFieldPlacement, selectedReadInputTypes } from "./placement-helpers";
import { resolvedQueryRecordTypeId } from "@vortex/platform/server";

export const projectPlacementRecordTypes = (input: {
  allPlacements: ReturnType<typeof collectPlacements>;
  pageDefinition: PageDefinition;
  pageSubjectRecordTypeId: string | undefined;
  context: InstalledRuntimeContext;
  editFormPlacementIds: Set<string>;
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
    const tableContract = readRecordsTableContract(settings);
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
    const recordTypeId =
      queryId === undefined
        ? detailContract === undefined || pageDefinition.type === "form"
          ? undefined
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
  editFormPlacementIds: Set<string>;
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
            ...(action.tasks as readonly unknown[]).flatMap((task) => {
              const recordType =
                isRecord(task) && isRecord(task.properties)
                  ? task.properties.recordType
                  : undefined;
              return isRecord(task) && task.type === "record.create" && isRecord(recordType)
                ? [String(recordType.recordTypeId)]
                : [];
            }),
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
export const projectPlacementBindings = (
  input: Readonly<{
    application: InstalledRuntimeContext["releaseSet"]["application"];
    recordTypeByPlacement: Map<string, string>;
    bindings: Record<string, PlacementFlowBinding[]>;
    pageDefinition: PageDefinition;
    pageSubjectRecordTypeId: string | undefined;
    selectedReadTypesByFlow: Map<string, ReadonlyMap<string, string>>;
  }>,
  { placementId, formId }: ReturnType<typeof collectPlacements>[number],
): void => {
  const {
    application,
    recordTypeByPlacement,
    bindings,
    pageDefinition,
    pageSubjectRecordTypeId,
    selectedReadTypesByFlow,
  } = input;
  const held = application.content.flowBindings.filter((binding) =>
    sameId(binding.controlId, placementId),
  );
  if (held.length > 0) {
    const placementRecordTypeId =
      recordTypeByPlacement.get(placementId.toLowerCase()) ??
      (formId === undefined ? undefined : recordTypeByPlacement.get(formId.toLowerCase()));
    bindings[placementId] = held.map((binding) => {
      // An action selects the page subject, so a foreign placement cannot lend it a record type.
      const selectedRecordTypeId =
        binding.event === "action"
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
      const flow = application.content.flows.find((entry) => sameId(entry.id, binding.flow.flowId));
      return {
        savesFormValues: flow !== undefined && savesValues(flow.tasks),
        bindingId: binding.bindingId,
        eventId: binding.eventId,
        event: binding.event,
        flowId: binding.flow.flowId,
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
