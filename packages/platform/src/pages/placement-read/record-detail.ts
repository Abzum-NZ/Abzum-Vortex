import "server-only";

import type { JsonValue } from "../../catalogue/common";
import { recordIdSchema } from "../../catalogue/identifiers";
import { sameId } from "../../catalogue/runtime-primitives";
import { readRecordDetailContract } from "../../definition/application-composition/records-display";
import {
  protectedQueryCommandSchema,
  type ProtectedQueryRow,
} from "../../queries/protected-query-contracts";
import { projectRecordDetailData } from "../component-data-projection";
import {
  logPlacementFailure,
  moduleFieldDisplay,
  placementSettingsOf,
  readRecordLinks,
  type PageDataState,
  type PlacementModule,
  type PlacementQuery,
  type PlacementReadEntry,
} from "./shared";
import type { PlacementReadInput } from "./types";
import { controlSelectedRecordType } from "./bindings";
import type { PageSubjectReadResult } from "../page-subject-read";

const detailState = (display: ReturnType<typeof projectRecordDetailData>): PageDataState =>
  display === undefined
    ? { status: "refused", reason: "not_found" }
    : display.status === "empty"
      ? { status: "empty" }
      : { status: "ready", values: display.values };

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
  const requestedFieldIds = [
    ...new Set(
      [
        ...contract.fields.map((field) => field.field),
        ...(contract.headingField === undefined ? [] : [contract.headingField]),
      ].map((field) => field.toLowerCase()),
    ),
  ];
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
  const recordLinks = await readRecordLinks(read.services.resolveRecordLinks, [record.row]);
  read.data[placementId] = detailState(
    projectRecordDetailData(
      {
        settings: placementSettingsOf(placement),
        ...(recordLinks === undefined ? {} : { recordLinks }),
        ...(recordModule === undefined ? {} : moduleFieldDisplay(recordModule)),
        ...(readableFieldIds === undefined ? {} : { readableFieldIds }),
      },
      [record.row],
    ),
  );
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
  const fieldIds = [
    ...new Set([
      ...detailContract.fields.map((field) => field.field),
      ...(detailContract.headingField === undefined ? [] : [detailContract.headingField]),
    ]),
  ];
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
  const detailLinks = await readRecordLinks(read.services.resolveRecordLinks, rows);
  read.data[placementId] = detailState(
    projectRecordDetailData(
      {
        settings,
        ...(detailLinks === undefined ? {} : { recordLinks: detailLinks }),
        ...moduleFieldDisplay(detailModule),
      },
      rows,
    ),
  );
};
