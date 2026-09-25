import "server-only";

import {
  readRecordsTableContract,
  type BlockPropertyValueV2Contract,
  type IdentitySession,
  type JsonValue,
  type ModuleRootId,
  type OrganizationSelectionCandidate,
  type QueryId,
} from "@vortex/contracts";
import type { HumanOrganizationRequestResult } from "@vortex/access";
import {
  protectedQueryCommandSchema,
  type ProtectedQueryCommand,
  type ProtectedQueryResult,
  type ProtectedQueryRow,
} from "@vortex/query";

/**
 * The one Query engine entry point a Records table reads through. The composition root supplies
 * the protected query service's `run`, which authorises the viewer's current authority itself, so
 * this module adds no authority and reads no tables.
 */
export type RecordsTableQueryRunner = Readonly<{
  run(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: ProtectedQueryCommand,
  ): Promise<HumanOrganizationRequestResult<ProtectedQueryResult>>;
}>;

/**
 * One Records table read. The module, query and compiled settings come from the installed release
 * the request already resolved; `pageParameters` are the values the current page supplies for
 * parameters the table declares as taken from the page. The Query engine runs installed Module
 * queries, so `moduleRootId` and `queryId` must name the exact query the placement is bound to;
 * a caller never substitutes another query for one it cannot resolve.
 */
export type RecordsTableQueryRequest = Readonly<{
  moduleRootId: ModuleRootId;
  queryId: QueryId;
  settings: Readonly<Record<string, BlockPropertyValueV2Contract>>;
  pageParameters?: Readonly<Record<string, JsonValue>>;
  continuationToken?: string;
}>;

/**
 * A neutral refusal never distinguishes an undeclared table, a missing page value, a refused
 * query or a hidden fact, and is never an empty page. `unavailable` is a temporary failure the
 * placement may retry; the component then shows its declared error message.
 */
export type RecordsTableQueryResolution =
  | Readonly<{
      kind: "available";
      /** Declared columns, in order, as field identities; each row's values are keyed by them. */
      fieldIds: readonly string[];
      pageSize: number;
      rows: readonly ProtectedQueryRow[];
      nextContinuationToken?: string;
    }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "unavailable" }>;

const refused = Object.freeze({ kind: "refused" as const });
const unavailable = Object.freeze({ kind: "unavailable" as const });

/**
 * Builds the Query engine command a declared Records table needs: exactly its declared columns,
 * its declared page size and its declared query inputs. Returns undefined when the placement
 * declares no data contract, a page-supplied input is missing or the command is not one the
 * Query engine accepts (for example a column that is not a field identity).
 */
export const buildRecordsTableQueryCommand = (
  request: RecordsTableQueryRequest,
): Readonly<{ command: ProtectedQueryCommand; fieldIds: readonly string[] }> | undefined => {
  const contract = readRecordsTableContract(request.settings);
  if (contract === undefined || contract.columns.length === 0) return undefined;
  const fieldIds = [...new Set(contract.columns.map((column) => column.field))];
  const inputValues: Record<string, JsonValue> = {};
  for (const parameter of contract.parameters) {
    const value =
      parameter.source === "fixed"
        ? parameter.fixedValue
        : parameter.pageParameter === undefined
          ? undefined
          : request.pageParameters?.[parameter.pageParameter];
    if (value === undefined) return undefined;
    inputValues[parameter.input] = value;
  }
  const command = protectedQueryCommandSchema.safeParse({
    moduleRootId: request.moduleRootId,
    queryId: request.queryId,
    inputValues,
    requestedFieldIds: fieldIds,
    requestedSystemFieldKeys: [],
    pageSize: contract.pageSize,
    ...(request.continuationToken === undefined
      ? {}
      : { continuationToken: request.continuationToken }),
  });
  return command.success ? { fieldIds, command: command.data } : undefined;
};

/**
 * Runs a Records table's query directly through the Query engine. The component never fetches
 * data itself, and no data flow is involved unless a builder adds transform or write steps.
 */
export const createRecordsTableQueryResolver = (runner: RecordsTableQueryRunner) => ({
  async resolve(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    request: RecordsTableQueryRequest,
  ): Promise<RecordsTableQueryResolution> {
    const built = buildRecordsTableQueryCommand(request);
    if (built === undefined) return refused;
    try {
      const result = await runner.run(session, selection, built.command);
      if (result.kind === "temporarily_unavailable") return unavailable;
      if (result.kind !== "available" || result.value.outcome !== "completed") return refused;
      return {
        kind: "available",
        fieldIds: built.fieldIds,
        pageSize: built.command.pageSize,
        rows: result.value.rows,
        ...(result.value.nextContinuationToken === undefined
          ? {}
          : { nextContinuationToken: result.value.nextContinuationToken }),
      };
    } catch {
      return unavailable;
    }
  },
});
