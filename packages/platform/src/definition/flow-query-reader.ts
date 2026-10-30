import "server-only";

import { sameId } from "../catalogue/runtime-primitives";
import { createProtectedQueryService } from "../queries/protected-query-service";
import type { ProtectedQueryServiceDependencies } from "../queries/protected-query-types";
import type { InstalledFlowBindings } from "./flow-binding-endpoint";
import type { FlowOrchestratorDependencies } from "./flow-orchestrator-types";

/** One bounded page of a declared query, read under the segment's current authority. */
export const createFlowQueryReader = (
  dependencies: ProtectedQueryServiceDependencies,
  installation: InstalledFlowBindings,
): NonNullable<FlowOrchestratorDependencies["queryRecords"]> => {
  const queries = createProtectedQueryService(dependencies);
  return {
    async read(session, selection, target) {
      if (
        !sameId(selection.organizationId, installation.organizationId) ||
        selection.applicationRootId === undefined ||
        !sameId(selection.applicationRootId, installation.applicationRootId)
      )
        return { kind: "unavailable" };
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
        inputValues: target.parameters,
        requestedFieldIds: declared.query.selectedFieldIds,
        pageSize: target.pageSize,
        continuationToken: target.continuation === "" ? undefined : target.continuation,
      });
      if (result.kind !== "available") return result;
      if (result.value.outcome !== "completed")
        return { kind: "available", value: { outcome: "unavailable" } };
      // Field values stay inside the protected read. The task returns one bounded page of record
      // references and the reader's opaque continuation for the next page.
      return {
        kind: "available",
        value: {
          outcome: "read",
          recordIds: result.value.rows.map((row) => row.recordId),
          continuation: result.value.nextContinuationToken ?? "",
        },
      };
    },
  };
};
