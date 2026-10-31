import "server-only";

import type { JsonValue } from "../../catalogue/common";
import { recordIdSchema } from "../../catalogue/identifiers";
import { sameId } from "../../catalogue/runtime-primitives";
import { readRecordDetailContract } from "../../definition/application-composition/records-display";
import {
  protectedQueryCommandSchema,
  type ProtectedQueryRow,
} from "../../queries/protected-query-contracts";
import { projectRecordDetailData, projectRecordRelatedList } from "../component-data-projection";
import {
  fieldPipelinesOf,
  findModuleQuery,
  logPlacementFailure,
  moduleFieldDisplay,
  queryRecordType,
  readyPlacementData,
  placementSettingsOf,
  readRecordLinks,
  type PageDataState,
  type PlacementModule,
  type PlacementQuery,
  type PlacementReadEntry,
} from "./shared";
import type { PlacementReadInput } from "./types";
import {
  recordDetailPayloadSchema,
  type RecordDetailPayload,
} from "../display-payload-record-detail";
import { controlSelectedRecordType } from "./bindings";
import type { PageSubjectReadResult } from "../page-subject-read";

/** The declared shape of a Record detail placement, read by the same reader the renderer uses. */
type RecordDetailContract = NonNullable<ReturnType<typeof readRecordDetailContract>>;

const detailState = (
  read: PlacementReadInput,
  placementId: string,
  display: ReturnType<typeof projectRecordDetailData>,
): PageDataState =>
  display === undefined
    ? { status: "refused", reason: "not_found" }
    : display.status === "empty"
      ? { status: "empty" }
      : readyPlacementData(read.address, placementId, recordDetailPayloadSchema, display.values);

/**
 * A Record detail on a detail or public page that binds no query reads its page subject: the one
 * record the page's own address names, of the page's declared record type, through the record read
 * path under the viewer's own authority. A public page shows no more than its declared public
 * fields. Nothing here comes from the browser except the id.
 */
export const readSubjectDetail = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
): Promise<void> => {
  const { placementId } = placement;
  const { pageDefinition, subjectType } = read;
  const subjectFieldIds =
    pageDefinition.type === "public" ? pageDefinition.publicFieldIds.map(String) : undefined;
  if (subjectType === undefined || pageDefinition.type === "form") {
    logPlacementFailure(read.address, placementId, "query_not_bound");
    read.data[placementId] = { status: "error" };
    return;
  }
  if (read.subjectId === undefined) {
    read.markSubjectUnreadable();
    read.data[placementId] = { status: "refused", reason: "not_found" };
    return;
  }
  const subjectId = read.subjectId;
  await readRecordForDetail(
    read,
    placement,
    String(subjectType.recordTypeId),
    () => read.services.readSubject(String(subjectType.recordTypeId), subjectId),
    subjectFieldIds,
    () => read.markSubjectUnreadable(),
  );
};

/**
 * A query-less Record detail with Record from shows the record its control selects: the record
 * identity that control publishes in the address, read as the control's one record type through
 * the same record read path under the viewer's own authority. With no selection it reads nothing.
 */
export const readSelectedDetail = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
  control: string,
): Promise<void> => {
  const { placementId } = placement;
  const name = read.bindings.controls.get(control.toLowerCase());
  const recordTypeId = controlSelectedRecordType(read.bindings, control);
  if (name === undefined || recordTypeId === undefined) {
    logPlacementFailure(read.address, placementId, "detail_selection_unbound");
    read.data[placementId] = { status: "error" };
    return;
  }
  const held = read.bindings.address[name];
  const raw = typeof held === "string" ? held : held?.[0];
  if (raw === undefined || raw === "") {
    read.data[placementId] = { status: "empty" };
    return;
  }
  const recordId = recordIdSchema.safeParse(raw);
  const contract = readRecordDetailContract(placementSettingsOf(placement));
  if (!recordId.success || contract === undefined) {
    read.data[placementId] = { status: "refused", reason: "not_found" };
    return;
  }
  // Only the fields the detail shows are requested; the record read withholds the unreadable ones.
  const requestedFieldIds = detailRequestedFieldIds(contract);
  await readRecordForDetail(
    read,
    placement,
    recordTypeId,
    () =>
      read.services.records.read(read.session, read.selection, {
        recordTypeId,
        recordId: recordId.data,
        requestedFieldIds,
      }),
    undefined,
    () => {},
  );
};

/** One record shown by a Record detail, read by its type and identity under the viewer's authority. */
const readRecordForDetail = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
  recordTypeId: string,
  readRecord: () => Promise<PageSubjectReadResult>,
  readableFieldIds: readonly string[] | undefined,
  markUnreadable: () => void,
): Promise<void> => {
  const { placementId } = placement;
  const recordModule = read.context.releaseSet.modules.find((module) =>
    module.content.recordTypes.some((recordType) =>
      sameId(String(recordType.recordTypeId), recordTypeId),
    ),
  );
  const record = await readRecord();
  if (record.kind === "temporarily_unavailable") {
    logPlacementFailure(read.address, placementId, "subject_unavailable");
    read.data[placementId] = { status: "error" };
    return;
  }
  if (record.kind === "refused") {
    markUnreadable();
    read.data[placementId] = { status: "refused", reason: "not_found" };
    return;
  }
  const contract = readRecordDetailContract(placementSettingsOf(placement));
  // A public page shows only its declared public fields, so it reads no related list.
  const relatedLists =
    contract === undefined || readableFieldIds !== undefined
      ? undefined
      : await readRelatedLists(read, placementId, contract, recordTypeId, record.row.recordId);
  const recordLinks = await readRecordLinks(read.services.resolveRecordLinks, [record.row]);
  read.data[placementId] = detailState(
    read,
    placementId,
    projectRecordDetailData(
      {
        settings: placementSettingsOf(placement),
        ...(recordLinks === undefined ? {} : { recordLinks }),
        ...(recordModule === undefined
          ? {}
          : {
              ...moduleFieldDisplay(recordModule),
              fieldPipelines: fieldPipelinesOf(recordModule),
            }),
        ...(readableFieldIds === undefined ? {} : { readableFieldIds }),
        ...(relatedLists === undefined ? {} : { recordRelatedLists: relatedLists }),
      },
      [record.row],
    ),
  );
};

/** Every field a Record detail requests: its sections, header key facts, stage and heading. */
const detailRequestedFieldIds = (contract: RecordDetailContract): string[] => [
  ...new Set(
    [
      ...contract.sections.flatMap((section) => section.fields).map((field) => field.field),
      ...contract.headerFields,
      ...(contract.stageField === undefined ? [] : [contract.stageField]),
      ...(contract.headingField === undefined ? [] : [contract.headingField]),
    ].map((field) => field.toLowerCase()),
  ),
];

/**
 * Reads every related list a Record detail declares: one installed query per list, narrowed by the
 * record the detail shows through the list's parent input, five rows each. A list whose query is
 * unavailable, refused or unreadable is logged and left out, so one list never blanks the record.
 */
const readRelatedLists = async (
  read: PlacementReadInput,
  placementId: string,
  contract: RecordDetailContract,
  parentRecordTypeId: string,
  parentRecordId: string,
): Promise<RecordDetailPayload["relatedLists"]> => {
  const lists: RecordDetailPayload["relatedLists"][number][] = [];
  for (const list of contract.relatedLists) {
    const bound = findModuleQuery(read.context, list.query);
    const recordType = bound === undefined ? undefined : queryRecordType(read.context, bound.query);
    if (bound === undefined || recordType === undefined) {
      logPlacementFailure(read.address, placementId, "related_list_query_unavailable");
      continue;
    }
    const command = protectedQueryCommandSchema.safeParse({
      moduleRootId: bound.module.rootId,
      queryId: bound.query.queryId,
      inputValues: {
        [list.parentInput]: { recordTypeId: parentRecordTypeId, recordId: parentRecordId },
      },
      requestedFieldIds: [
        ...new Set(
          [...list.columns.map((column) => column.field), String(recordType.titleFieldId)].map(
            (field) => field.toLowerCase(),
          ),
        ),
      ],
      requestedSystemFieldKeys: [],
      sort: [],
      sortableFieldIds: [],
      filterableFieldIds: [],
      searchableFieldIds: [],
      pageSize: 5,
    });
    if (!command.success) {
      logPlacementFailure(read.address, placementId, "related_list_command_invalid");
      continue;
    }
    const result = await read.services.queries.run(read.session, read.selection, command.data);
    if (result.kind === "temporarily_unavailable") {
      logPlacementFailure(read.address, placementId, "related_list_unavailable");
      continue;
    }
    if (result.kind !== "available" || result.value.outcome !== "completed") {
      logPlacementFailure(read.address, placementId, "related_list_refused");
      continue;
    }
    const rows: readonly ProtectedQueryRow[] = result.value.rows;
    const links = await readRecordLinks(read.services.resolveRecordLinks, rows);
    lists.push(
      projectRecordRelatedList(
        {
          ...moduleFieldDisplay(bound.module),
          titleFieldId: String(recordType.titleFieldId),
          ...(links === undefined ? {} : { recordLinks: links }),
        },
        {
          key: list.key,
          title: list.title,
          columns: list.columns.map((column) => ({
            field: column.field,
            ...(column.label === undefined ? {} : { label: column.label }),
          })),
          ...(list.addPage === undefined || list.addField === undefined
            ? {}
            : { add: { pageKey: list.addPage, parentFieldId: list.addField } }),
        },
        rows,
      ),
    );
  }
  return lists;
};

/** A Record detail bound to a query shows the first row that query returns for its inputs. */
export const readQueryDetail = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
  bound: Readonly<{ module: PlacementModule; query: PlacementQuery }>,
  inputValues: Readonly<Record<string, JsonValue>>,
): Promise<void> => {
  const { placementId } = placement;
  const settings = placementSettingsOf(placement);
  const detailContract = readRecordDetailContract(settings);
  const queryRecordType = bound.query.recordType;
  const detailModule =
    queryRecordType.state === "resolved"
      ? read.context.releaseSet.modules.find((module) =>
          sameId(String(module.rootId), String(queryRecordType.moduleRootId)),
        )
      : undefined;
  if (detailModule === undefined || detailContract === undefined) {
    logPlacementFailure(read.address, placementId, "detail_record_type_unavailable");
    read.data[placementId] = { status: "error" };
    return;
  }
  const fieldIds = detailRequestedFieldIds(detailContract);
  const command = protectedQueryCommandSchema.safeParse({
    moduleRootId: bound.module.rootId,
    queryId: bound.query.queryId,
    inputValues,
    requestedFieldIds: fieldIds,
    requestedSystemFieldKeys: [],
    sort: [],
    sortableFieldIds: [],
    filterableFieldIds: [],
    searchableFieldIds: [],
    pageSize: 1,
  });
  if (!command.success) {
    logPlacementFailure(read.address, placementId, "detail_command_invalid");
    read.data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const result = await read.services.queries.run(read.session, read.selection, command.data);
  if (result.kind === "temporarily_unavailable") {
    logPlacementFailure(read.address, placementId, "detail_query_unavailable");
    read.data[placementId] = { status: "error" };
    return;
  }
  if (result.kind !== "available" || result.value.outcome !== "completed") {
    logPlacementFailure(read.address, placementId, "detail_query_refused");
    read.data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const rows: readonly ProtectedQueryRow[] = result.value.rows;
  const relatedLists =
    queryRecordType.state === "resolved" && rows[0] !== undefined
      ? await readRelatedLists(
          read,
          placementId,
          detailContract,
          String(queryRecordType.recordTypeId),
          rows[0].recordId,
        )
      : undefined;
  const detailLinks = await readRecordLinks(read.services.resolveRecordLinks, rows);
  read.data[placementId] = detailState(
    read,
    placementId,
    projectRecordDetailData(
      {
        settings,
        ...(detailLinks === undefined ? {} : { recordLinks: detailLinks }),
        ...moduleFieldDisplay(detailModule),
        fieldPipelines: fieldPipelinesOf(detailModule),
        ...(relatedLists === undefined ? {} : { recordRelatedLists: relatedLists }),
      },
      rows,
    ),
  );
};
