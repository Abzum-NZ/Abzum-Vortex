import "server-only";

import {
  readRecordsTableContract,
  recordIdSchema,
  sameId,
  type PageDefinition,
  type RecordsTableContract,
} from "../schema";
import {
  placementSettings,
  TABLE_BLOCK_RELEASE,
  type InstalledRuntimeContext,
} from "../definition/index";
import { isRecord } from "../catalogue/runtime-primitives";
import {
  requireProjectedPlacement,
  type ProjectedPlacementRefusal,
} from "./projected-placement-gate";
import type { PageSubjectReadResult } from "./page-subject-read";
import { pageQueryBindingContext } from "./placement-read/bindings";
import {
  placementSettingsOf,
  resolvedQueryRecordTypeId,
  type AddressParameters,
  type PageSubjectType,
  type PlacementReadEntry,
} from "./placement-read/shared";
import type { QueryBindingContext } from "./query-binding-resolver";

/**
 * Why a Records table cannot be used on the addressed page: the placement gate's reasons, or the
 * placement is on the page but is not a Records table with a readable contract.
 */
export type ProjectedTablePlacementRefusal =
  ProjectedPlacementRefusal | "placement_not_a_table" | "table_contract_invalid";

/** The readers a table read's query bindings take from the request. */
export type ProjectedTableBindingReaders = Readonly<{
  readSubject: (recordTypeId: string, recordId: string) => Promise<PageSubjectReadResult>;
  readTimeZone: () => Promise<string | undefined>;
  readViewerTeams: () => Promise<readonly string[] | undefined>;
}>;

export type ProjectedTablePlacement =
  | Readonly<{
      kind: "resolved";
      placement: PlacementReadEntry;
      /** The table's typed contract, read once from its settings. */
      contract: RecordsTableContract;
      /** The record type the table's query reads, when the query resolves to one. */
      recordTypeId: string | undefined;
      /** The record type the page's own address names the subject of; undefined off a record page. */
      subjectRecordType: PageSubjectType | undefined;
      /** The page address's subject record id, when it is a record identity. */
      subjectRecordId: string | undefined;
      /** The table read's query bindings for one request, reading through the given readers. */
      bindings: (readers: ProjectedTableBindingReaders) => QueryBindingContext;
    }>
  | Readonly<{ kind: "refused"; reason: ProjectedTablePlacementRefusal }>;

/** The record type a record page's own address names the subject of; undefined on other pages. */
export const pageSubjectType = (pageDefinition: PageDefinition): PageSubjectType | undefined =>
  (pageDefinition.type === "detail" ||
    pageDefinition.type === "public" ||
    pageDefinition.type === "form" ||
    pageDefinition.type === "guided_form") &&
  pageDefinition.recordType?.state === "resolved"
    ? pageDefinition.recordType
    : undefined;

/** Whether a placed item is a Records table block. */
export const isTablePlacement = ({ vortex }: Pick<PlacementReadEntry, "vortex">): boolean =>
  isRecord(vortex.block) &&
  typeof vortex.block.blockId === "string" &&
  sameId(vortex.block.blockId, TABLE_BLOCK_RELEASE.blockId);

/**
 * The one resolution of a Records table named by a request: the table must be on the addressed
 * page as projected for the person now, exactly once and usable (the placement gate), be a Records
 * table block with a readable contract, and then carries everything every table read needs: its
 * contract, the record type its query reads, the page's subject type and the query bindings. The
 * page load, the pivot, a row's detail, and the bulk, export and summary routes all resolve their
 * table here; the caller logs the refusal reason and tells the client only that it is refused.
 */
export const resolveProjectedTablePlacement = (
  projectedPage: Readonly<Record<string, unknown>>,
  placementId: string,
  input: Readonly<{
    context: InstalledRuntimeContext;
    pageDefinition: PageDefinition;
    parameters: AddressParameters;
    /** The page address's subject parameter, as the browser sent it. */
    subjectId: string | undefined;
  }>,
): ProjectedTablePlacement => {
  const gate = requireProjectedPlacement(projectedPage, placementId);
  if (gate.kind === "refused") return gate;
  const visited = gate.placement;
  const placement: PlacementReadEntry = {
    placementId: visited.placementId,
    item: visited.item,
    vortex: visited.vortex,
    settings: placementSettings(visited.props),
  };
  if (!isTablePlacement(placement)) return { kind: "refused", reason: "placement_not_a_table" };
  const contract = readRecordsTableContract(placementSettingsOf(placement));
  if (contract === undefined) return { kind: "refused", reason: "table_contract_invalid" };
  const subjectRecordType = pageSubjectType(input.pageDefinition);
  const subjectRecordId = recordIdSchema.safeParse(input.subjectId);
  return {
    kind: "resolved",
    placement,
    contract,
    recordTypeId:
      typeof placement.vortex.queryId === "string"
        ? resolvedQueryRecordTypeId(input.context, placement.vortex.queryId)
        : undefined,
    subjectRecordType,
    subjectRecordId: subjectRecordId.success ? subjectRecordId.data : undefined,
    bindings: (readers) =>
      pageQueryBindingContext({
        context: input.context,
        pageDefinition: input.pageDefinition,
        parameters: input.parameters,
        readSubject:
          subjectRecordType === undefined
            ? undefined
            : () =>
                subjectRecordId.success
                  ? readers.readSubject(
                      String(subjectRecordType.recordTypeId),
                      subjectRecordId.data,
                    )
                  : Promise.resolve({ kind: "refused" }),
        subjectRecordTypeId:
          subjectRecordType === undefined ? undefined : String(subjectRecordType.recordTypeId),
        readTimeZone: readers.readTimeZone,
        readViewerTeams: readers.readViewerTeams,
      }),
  };
};
