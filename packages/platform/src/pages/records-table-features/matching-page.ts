import "server-only";

import type { IdentitySession, OrganizationSelectionCandidate } from "../../access/identity-access";
import type { JsonValue } from "../../catalogue/common";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestResult,
} from "../../access/human-organization-request";
import { sameId } from "../../catalogue/runtime-primitives";
import { createProtectedQueryService } from "../../queries/protected-query-service";
import { openRecordsSelection, recordsSelectionPlacement } from "../records-selection-seal";
import { matchingQueryCommand, type RecordsTableBulkDependencies } from "./bulk-run";
import { loadRecordsTablePlacement } from "./placement";

/** The most records one page of "every matching record" reads. */
const matchingPageSize = 200;

export type MatchingPage = HumanOrganizationRequestResult<
  | Readonly<{
      outcome: "read";
      recordIds: readonly string[];
      /** The same page's selected field values, keyed by field key, for a flow that reads them. */
      rows: readonly Readonly<{
        record: Readonly<{ recordTypeId: string; recordId: string }>;
        values: Readonly<Record<string, JsonValue>>;
      }>[];
      continuation: string;
    }>
  | Readonly<{ outcome: "unavailable" }>
>;

const unavailable = (cause: string): MatchingPage => {
  console.error(`[records-table] matching page unavailable cause=${cause}`);
  return { kind: "available", value: { outcome: "unavailable" } };
};

/**
 * One page of the records a table's sealed "every matching record" descriptor matches now, read
 * under the reader's current access: the descriptor is opened for this person and the installed
 * release, the table's query is rebuilt from the installed placement, and the page follows the
 * given continuation. The records the person unticked are left out; the page never widens.
 */
export const createMatchingPageReader = (dependencies: RecordsTableBulkDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const queries = createProtectedQueryService(dependencies);
  return async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    target: Readonly<{
      queryId: string;
      token: string;
      excluded: ReadonlySet<string>;
      continuation: string;
    }>,
  ): Promise<MatchingPage> => {
    if (selection.applicationRootId === undefined) return unavailable("application_not_selected");
    const addressed = recordsSelectionPlacement(target.token, dependencies.continuationKey);
    if (addressed === undefined) return unavailable("descriptor_not_authentic");
    const address = {
      pageId: addressed.pageId,
      selection: { ...selection, applicationRootId: selection.applicationRootId },
    };
    const placement = await loadRecordsTablePlacement(
      requests,
      session,
      address,
      addressed.placementId,
    );
    if ("refused" in placement) return unavailable(placement.refused);
    const descriptor = openRecordsSelection(target.token, dependencies.continuationKey, {
      session,
      selection,
      installationRevision: placement.installed.applicationReleaseRevision,
      pageId: addressed.pageId,
      placementId: addressed.placementId,
    });
    if (
      descriptor === undefined ||
      !sameId(descriptor.queryId, target.queryId) ||
      !sameId(descriptor.moduleRootId, String(placement.module.rootId)) ||
      !sameId(descriptor.queryId, String(placement.query.queryId))
    )
      return unavailable("descriptor_not_for_this_run");
    const built = matchingQueryCommand(placement, descriptor);
    if (built === undefined) return unavailable("command_unavailable");
    const result = await queries.run(session, selection, {
      ...built.command,
      pageSize: matchingPageSize,
      ...(target.continuation === ""
        ? {}
        : { pageDirection: "forward" as const, continuationToken: target.continuation }),
    });
    if (result.kind !== "available") return result;
    if (result.value.outcome !== "completed") return unavailable(`read_${result.value.reasonCode}`);
    const recordType = placement.module.content.recordTypes.find((type) =>
      sameId(
        type.recordTypeId,
        placement.query.recordType?.state === "resolved"
          ? placement.query.recordType.recordTypeId
          : undefined,
      ),
    );
    const keyOfField = new Map(
      (recordType?.fields ?? []).map((field) => [field.fieldId.toLowerCase(), field.key] as const),
    );
    const kept = result.value.rows.filter(
      (row) => !target.excluded.has(String(row.recordId).toLowerCase()),
    );
    return {
      kind: "available",
      value: {
        outcome: "read",
        recordIds: kept.map((row) => String(row.recordId).toLowerCase()),
        rows: kept.map((row) => ({
          record: {
            recordTypeId: recordType?.recordTypeId ?? "",
            recordId: String(row.recordId),
          },
          values: Object.fromEntries(
            Object.entries(row.values).flatMap(([fieldId, value]) => {
              const key = keyOfField.get(fieldId.toLowerCase());
              return key === undefined ? [] : [[key, value] as const];
            }),
          ),
        })),
        continuation: result.value.nextContinuationToken ?? "",
      },
    };
  };
};
