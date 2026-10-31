import "server-only";

import type { JsonValue } from "../catalogue/common";
import { sameId } from "../catalogue/runtime-primitives";
import { createMatchingPageReader } from "../pages/records-table-features/matching-page";
import { createProtectedQueryService } from "../queries/protected-query-service";
import type { ProtectedQueryServiceDependencies } from "../queries/protected-query-types";
import type { InstalledFlowBindings } from "./flow-binding-endpoint";
import type { FlowOrchestratorDependencies } from "./flow-orchestrator-types";

/**
 * A flow holds a record as its id; a query takes a record input as the record and its type. A
 * record id given for a record input names a record of the input's one record type.
 */
const recordReferenceParameters = (
  inputs: readonly Readonly<{ key: string; type: string; recordTypes?: readonly unknown[] }>[],
  parameters: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> =>
  Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => {
      const input = inputs.find((entry) => entry.key === key);
      const types =
        input?.type === "record_reference"
          ? (input.recordTypes ?? []).flatMap((type) =>
              typeof type === "object" &&
              type !== null &&
              "state" in type &&
              type.state === "resolved" &&
              "recordTypeId" in type
                ? [String(type.recordTypeId)]
                : [],
            )
          : [];
      return [
        key,
        typeof value === "string" && types.length === 1
          ? { recordTypeId: types[0]!, recordId: value }
          : value,
      ];
    }),
  );

/** One bounded page of a declared query, read under the segment's current authority. */
export const createFlowQueryReader = (
  dependencies: ProtectedQueryServiceDependencies,
  installation: Pick<InstalledFlowBindings, "organizationId" | "applicationRootId" | "modules">,
): NonNullable<FlowOrchestratorDependencies["queryRecords"]> => {
  const queries = createProtectedQueryService(dependencies);
  const matching = createMatchingPageReader(dependencies);
  return {
    async read(session, selection, target) {
      if (
        !sameId(selection.organizationId, installation.organizationId) ||
        selection.applicationRootId === undefined ||
        !sameId(selection.applicationRootId, installation.applicationRootId)
      )
        return { kind: "unavailable" };
      if (target.matching !== undefined)
        return matching(session, selection, {
          queryId: target.queryId,
          token: target.matching.token,
          excluded: new Set(target.matching.excluded.map((recordId) => recordId.toLowerCase())),
          continuation: target.continuation,
        });
      const matches = (installation.modules ?? []).flatMap((module) =>
        module.content.queries
          .filter((query) => sameId(query.queryId, target.queryId))
          .map((query) => ({ moduleRootId: module.rootId, query })),
      );
      const declared = matches[0];
      if (matches.length !== 1 || declared === undefined) return { kind: "unavailable" };
      const result = await queries.run(session, selection, {
        moduleRootId: declared.moduleRootId,
        queryId: declared.query.queryId,
        inputValues: recordReferenceParameters(declared.query.inputs, target.parameters),
        requestedFieldIds: declared.query.selectedFieldIds,
        // Absent, the query's own declared page size (at most 200) applies.
        pageSize: target.pageSize ?? declared.query.pageSize,
        continuationToken: target.continuation === "" ? undefined : target.continuation,
      });
      if (result.kind !== "available") return result;
      if (result.value.outcome !== "completed")
        return { kind: "available", value: { outcome: "unavailable" } };
      // Field values stay inside the protected read. The task returns one bounded page of record
      // references, the same page's selected field values under their keys, and the reader's
      // opaque continuation for the next page.
      const recordTypeId =
        declared.query.recordType.state === "resolved"
          ? declared.query.recordType.recordTypeId
          : undefined;
      const recordType = (installation.modules ?? [])
        .flatMap((module) => module.content.recordTypes)
        .find((type) => sameId(type.recordTypeId, recordTypeId));
      if (recordType === undefined) return { kind: "unavailable" };
      const keyOfField = new Map(
        recordType.fields.map((field) => [field.fieldId.toLowerCase(), field.key] as const),
      );
      return {
        kind: "available",
        value: {
          outcome: "read",
          recordIds: result.value.rows.map((row) => row.recordId),
          rows: result.value.rows.map((row) => ({
            record: { recordTypeId: recordType.recordTypeId, recordId: row.recordId },
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
    },
  };
};
