import { buildLinkTilesQueryBinding, type InstalledRuntimeContext } from "@web/platform-server";
import {
  ATTACHMENT_LIST_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  QUERY_NOTICE_BLOCK_RELEASE,
  LINK_TILES_BLOCK_RELEASE,
  RECORD_PIN_LINK_TILES_BLOCK_RELEASE,
  APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE,
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
import type {
  collectPlacements} from "./placement-helpers";
import {
  isBoardPlacement,
  isEditFieldPlacement,
  selectedReadInputTypes
} from "./placement-helpers";
import { resolvedQueryRecordTypeId } from "./query-helpers";

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
  for (const { placementId, placement } of allPlacements) {
    if (placement.readModel !== undefined) continue;
    const block = placement.block;
    const isAttachmentListBlock =
      isRecord(block) &&
      typeof block.blockId === "string" &&
      sameId(block.blockId, ATTACHMENT_LIST_BLOCK_RELEASE.blockId) &&
      block.releaseVersion === ATTACHMENT_LIST_BLOCK_RELEASE.releaseVersion;
    if (isAttachmentListBlock) {
      if (
        pageDefinition.type === "detail" &&
        placement.queryId === undefined &&
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
    const isBoardBlock = isBoardPlacement(placement);
    const isQueryNoticeBlock =
      isRecord(block) &&
      typeof block.blockId === "string" &&
      sameId(block.blockId, QUERY_NOTICE_BLOCK_RELEASE.blockId) &&
      block.releaseVersion === QUERY_NOTICE_BLOCK_RELEASE.releaseVersion;
    const isLinkTilesBlock =
      isRecord(block) &&
      typeof block.blockId === "string" &&
      sameId(block.blockId, LINK_TILES_BLOCK_RELEASE.blockId) &&
      (block.releaseVersion === LINK_TILES_BLOCK_RELEASE.releaseVersion ||
        block.releaseVersion === RECORD_PIN_LINK_TILES_BLOCK_RELEASE.releaseVersion ||
        block.releaseVersion === APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE.releaseVersion);
    if (
      tableContract === undefined && detailContract === undefined &&
      !isBoardBlock && !isQueryNoticeBlock && !isLinkTilesBlock
    ) continue;

    const queryId = typeof placement.queryId === "string" ? placement.queryId : undefined;
    const recordTypeId =
      queryId === undefined
        ? detailContract === undefined || pageDefinition.type === "form"
          ? undefined
          : pageSubjectRecordTypeId
        : isLinkTilesBlock
          ? buildLinkTilesQueryBinding(context, queryId, settings, {},
              isRecord(block) && typeof block.releaseVersion === "string" ? block.releaseVersion : "")?.recordTypeId
          : resolvedQueryRecordTypeId(context, queryId);
    if (recordTypeId === undefined) continue;
    recordTypeByPlacement.set(placementId.toLowerCase(), recordTypeId);
    addDataPlacement(recordTypeId, placementId);
  }
  if (pageSubjectRecordTypeId !== undefined) {
    for (const formId of editFormPlacementIds) {
      const formDataPlacementIds = [formId];
      for (const { placementId, placement, formId: ownerFormId } of allPlacements) {
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
    ].map((action) => [String(action.key).toLowerCase(), String(action.subjectRecordTypeId)] as const),
  );
  const flowWrittenRecordTypes = (flowId: string): readonly string[] => {
    const types = new Set<string>();
    const visited = new Set<string>();
    const literal = (task: FlowTask, name: string): string | undefined => {
      const properties = "properties" in task ? task.properties : undefined;
      const value = properties?.[name];
      return isRecord(value) && value.kind === "literal" && isRecord(value.literal) &&
        value.literal.type === "text" && typeof value.literal.value === "string"
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
            const recordType =
              operation === undefined ? undefined : actionRecordTypes.get(operation.toLowerCase());
            if (recordType !== undefined) types.add(recordType);
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
    const editFormId =
      editFormPlacementIds.has(placementId)
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
      const queryTargets = targetTypes.flatMap((recordTypeId) =>
        dataPlacementsByRecordType.get(recordTypeId.toLowerCase()) ?? [],
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
