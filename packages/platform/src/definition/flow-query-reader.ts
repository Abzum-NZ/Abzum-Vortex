import "server-only";

import { sameId } from "../catalogue/runtime-primitives";
import { createProtectedQueryService } from "../queries/protected-query-service";
import type { ProtectedQueryServiceDependencies } from "../queries/protected-query-types";
import type { InstalledFlowBindings } from "./flow-binding-endpoint";
import type { FlowOrchestratorDependencies } from "./flow-orchestrator-types";

/** A declared query's first bounded page, read under the segment's current authority. */
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
        pageSize: 200,
      });
      if (result.kind !== "available") return result;
      if (result.value.outcome !== "completed")
        return { kind: "available", value: { outcome: "unavailable" } };
      // Field values and the reader's continuation stay inside the protected read. The authored
      // task currently returns only record references, never a projection or an unbounded set.
      return {
        kind: "available",
        value: { outcome: "read", recordIds: result.value.rows.map((row) => row.recordId) },
      };
    },
  };
};
