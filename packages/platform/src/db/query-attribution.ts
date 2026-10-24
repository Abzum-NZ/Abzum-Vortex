import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseRow, DatabaseValue } from "./request-transaction";

export type ProtectedReadFamily =
  | "eligibility_batch"
  | "eligibility_single"
  | "module_query"
  | "record_titles"
  | "installation"
  | "other_protected_read";

export type ProtectedReadMeasurement = Readonly<{
  family: ProtectedReadFamily;
  durationMs: number;
  returnedRows: number;
  failed: boolean;
}>;

/** Observability only: no SQL, bound values, record values or permission evidence leave the driver. */
export type ProtectedReadObserver = (measurement: ProtectedReadMeasurement) => void;
const storage = new AsyncLocalStorage<ProtectedReadObserver>();

export const currentProtectedReadObserver = (): ProtectedReadObserver | undefined =>
  storage.getStore();

export const withProtectedReadObserver = <Result>(
  observer: ProtectedReadObserver,
  operation: () => Promise<Result>,
): Promise<Result> => storage.run(observer, operation);

const familyOf = (strings: TemplateStringsArray): ProtectedReadFamily | undefined => {
  // Only the static template is examined. Interpolated SQL parameters are never inspected.
  const sql = strings.join("?");
  if (!/^\s*(select|with)\b/i.test(sql)) return undefined;
  if (sql.includes("vortex_access.evaluate_organization_permission_eligibility("))
    return sql.includes("jsonb_array_elements(") ? "eligibility_batch" : "eligibility_single";
  if (sql.includes("vortex_record.run_module_query(")) return "module_query";
  if (sql.includes("vortex_record.read_record_titles(")) return "record_titles";
  if (
    /vortex_definition\.(read_(?:current_active_installation|active_installation_bundle_identity|application_installation_bindings|installation_runtime_bundle_(?:index|parts)|prepared_installation_runtime_source|builder_preview_installation)|assert_prepared_installation_runtime_bundle)\(/u.test(
      sql,
    )
  )
    return "installation";
  return "other_protected_read";
};

export const observeProtectedRead = async <ResultRow extends DatabaseRow>(
  observer: ProtectedReadObserver | undefined,
  strings: TemplateStringsArray,
  values: readonly DatabaseValue[],
  query: (
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ) => Promise<readonly ResultRow[]>,
): Promise<readonly ResultRow[]> => {
  const family = observer === undefined ? undefined : familyOf(strings);
  if (observer === undefined || family === undefined) return query(strings, ...values);
  const started = performance.now();
  let returnedRows = 0;
  let failed = true;
  try {
    const rows = await query(strings, ...values);
    // run_module_query returns one JSON envelope: `rows`, or `columns[].rows` for a batched board
    // read. Count its rows, never their contents.
    const envelopeRows = (result: unknown): number => {
      if (typeof result !== "object" || result === null) return 0;
      if ("rows" in result && Array.isArray(result.rows)) return result.rows.length;
      if ("columns" in result && Array.isArray(result.columns))
        return result.columns.reduce(
          (count: number, column: unknown) =>
            count +
            (typeof column === "object" &&
            column !== null &&
            "rows" in column &&
            Array.isArray(column.rows)
              ? column.rows.length
              : 0),
          0,
        );
      return 0;
    };
    returnedRows =
      family === "module_query"
        ? rows.reduce((count, row) => count + envelopeRows(row.result), 0)
        : rows.length;
    failed = false;
    return rows;
  } finally {
    observer({ family, durationMs: performance.now() - started, returnedRows, failed });
  }
};
