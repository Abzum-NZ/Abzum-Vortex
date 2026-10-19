import "server-only";

import { readRecordDetailContract, sameId, type JsonValue } from "../../schema";
import { protectedQueryCommandSchema, type ProtectedQueryRow } from "../../queries/index";
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
  const { pageDefinition, subjectType, context } = read;
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
  const subjectModule = context.releaseSet.modules.find((module) =>
    sameId(String(module.rootId), String(subjectType.moduleRootId)),
  );
  const subject = await read.services.readSubject(String(subjectType.recordTypeId), read.subjectId);
  if (subject.kind === "temporarily_unavailable") {
    logPlacementFailure(read.address, placementId, "subject_unavailable");
    read.data[placementId] = { status: "error" };
    return;
  }
  if (subject.kind === "refused") {
    read.markSubjectUnreadable();
    read.data[placementId] = { status: "refused", reason: "not_found" };
    return;
  }
  const subjectLinks = await readRecordLinks(read.services.resolveRecordLinks, [subject.row]);
  read.data[placementId] = detailState(
    projectRecordDetailData(
      {
        settings: placementSettingsOf(placement),
        ...(subjectLinks === undefined ? {} : { recordLinks: subjectLinks }),
        ...(subjectModule === undefined ? {} : moduleFieldDisplay(subjectModule)),
        ...(subjectFieldIds === undefined ? {} : { readableFieldIds: subjectFieldIds }),
      },
      [subject.row],
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
