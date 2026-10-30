import "server-only";

import type { JsonValue } from "../catalogue/common";
import { sameId } from "../catalogue/runtime-primitives";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import { createProtectedQueryService } from "../queries/protected-query-service";
import type { ProtectedQueryServiceDependencies } from "../queries/protected-query-types";
import type { OptionMembershipCheck } from "../records/option-membership";
import { runFieldOptionsFlow } from "./field-options-flow";
import { createFlowQueryReader } from "./flow-query-reader";
import type { InstalledFlowBindings } from "./flow-binding-endpoint";

/**
 * The saver's own check that a value is among the options its field's declared source offers now:
 * the field's options flow is run again with the one flow interpreter and the saved values as its
 * inputs, or the declared query is asked about the one record. Both run under the saver's own
 * access and in the save's request; the browser's list is a convenience and never trusted.
 */
export const createOptionMembershipCheck = (
  ports: Readonly<{
    dependencies: ProtectedQueryServiceDependencies;
    installation: Pick<
      InstalledFlowBindings,
      "organizationId" | "applicationRootId" | "modules" | "flows"
    >;
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
  }>,
): OptionMembershipCheck => {
  const queries = createProtectedQueryService(ports.dependencies);
  const queryRecords = createFlowQueryReader(ports.dependencies, ports.installation);
  const library = (flowId: string) =>
    ports.installation.flows.get(flowId) ?? ports.installation.flows.get(flowId.toLowerCase());
  const inputsOf = (
    source: Readonly<{ inputs?: Readonly<Record<string, unknown>> | undefined }>,
    valueOf: (fieldId: string) => unknown,
  ): Record<string, JsonValue> =>
    Object.fromEntries(
      Object.entries(source.inputs ?? {}).map(([name, fieldId]) => [
        name,
        (valueOf(String(fieldId)) ?? null) as JsonValue,
      ]),
    );
  return async ({ field, value, valueOf }) => {
    if (field.type !== "choice" && field.type !== "link") return false;
    const source = field.settings.optionsSource;
    if (source.kind === "flow") {
      const ran = await runFieldOptionsFlow(
        {
          library,
          queryRecords,
          session: ports.session,
          selection: ports.selection,
          now: new Date().toISOString(),
          runId: crypto.randomUUID(),
        },
        String(source.flowId),
        inputsOf(source, valueOf),
      );
      if (ran.kind !== "options") {
        console.error(
          `[record] options flow of ${String(field.fieldId)} could not be run: ${ran.kind === "failed" ? ran.reason : ran.kind}`,
        );
        return false;
      }
      return ran.options.some((option) =>
        typeof option.value === "string"
          ? option.value === value
          : typeof value === "object" &&
            value !== null &&
            "recordTypeId" in value &&
            "recordId" in value &&
            sameId(option.value.recordTypeId, String(value.recordTypeId)) &&
            sameId(option.value.recordId, String(value.recordId)),
      );
    }
    if (source.kind !== "query" || source.queryId === undefined || field.type !== "link")
      return false;
    const record =
      typeof value === "object" && value !== null && "recordId" in value
        ? String(value.recordId)
        : undefined;
    const declared = (ports.installation.modules ?? []).flatMap((module) =>
      module.content.queries
        .filter((query) => sameId(String(query.queryId), String(source.queryId)))
        .map((query) => ({ moduleRootId: module.rootId, query })),
    )[0];
    if (record === undefined || declared === undefined) return false;
    const result = await queries.run(ports.session, ports.selection, {
      moduleRootId: declared.moduleRootId,
      queryId: declared.query.queryId,
      inputValues: inputsOf(source, valueOf),
      requestedFieldIds: declared.query.selectedFieldIds,
      pageSize: 1,
      exactRecordIds: [record],
    });
    return (
      result.kind === "available" &&
      result.value.outcome === "completed" &&
      result.value.rows.some((row) => sameId(row.recordId, record))
    );
  };
};
