import type {
  ProtectedQuerySummaryAggregateResult,
  InstalledRuntimeContext,
  PermittedApplication,
  LinkFieldType,
} from "@vortex/platform/server";
import type { DisplayCellValue } from "@vortex/ui";
import {
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  type BoardPlacementFailureCause,
} from "@vortex/platform/server";
import {
  type JsonValue,
  jsonValueSchema,
  exactDecimalTextSchema,
  moneyValueSchema,
  type BlockPropertyValueContract,
  sameId,
  isRecord,
} from "@vortex/platform/schema";
import type { ModuleRelease, ModuleField, SearchParameters } from "./types";
import { first } from "./placement-helpers";

/**
 * A query-string value typed to the declared input it fills. A value the type cannot hold is
 * dropped, so the Query engine refuses the request instead of receiving a guess.
 */
export const coerceInput = (raw: string, type: string): JsonValue | undefined => {
  switch (type) {
    case "number": {
      const value = Number(raw);
      return raw.trim() !== "" && Number.isFinite(value) ? value : undefined;
    }
    case "boolean":
      return raw === "true" ? true : raw === "false" ? false : undefined;
    default:
      return raw;
  }
};

/** Structured Notice-query inputs are plain JSON; the Query service validates their declared type. */
export const noticeQueryInput = (raw: string, type: string): JsonValue | undefined => {
  if (
    type === "formatted_text" || type === "money" ||
    type === "record_reference" || type === "organization_account_reference"
  ) {
    try {
      const parsed = jsonValueSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  return coerceInput(raw, type);
};

type ModuleQuery = ModuleRelease["content"]["queries"][number];

export const summaryAggregateLabel = (alias: string): string =>
  alias
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());

/** Projects one already-authorised Query aggregate into the closed summary cell contract. */
export const summaryAggregateCellValue = (
  aggregate: ModuleQuery["aggregates"][number],
  field: ModuleField | undefined,
  result: ProtectedQuerySummaryAggregateResult,
): DisplayCellValue | Readonly<{ kind: "unavailable" }> | undefined => {
  if (result.outcome === "refused") return { kind: "unavailable" };
  if (aggregate.operation === "count")
    return typeof result.value === "number" && Number.isSafeInteger(result.value)
      ? { kind: "number", value: result.value }
      : undefined;
  if (result.value === null || result.valueCount === 0) return { kind: "empty" };
  if (field === undefined) return undefined;

  const fieldType =
    field.type === "calculation"
      ? field.settings.expression.kind === "numeric" &&
        field.settings.evaluation === "stored" &&
        (field.settings.resultType === "whole_number" ||
          field.settings.resultType === "decimal_number")
        ? field.settings.resultType
        : undefined
      : field.type;
  if (fieldType === undefined) return undefined;

  switch (fieldType) {
    case "text":
      return (aggregate.operation === "minimum" || aggregate.operation === "maximum") &&
        typeof result.value === "string"
        ? { kind: "text", text: result.value }
        : undefined;
    case "yes_no":
      return (aggregate.operation === "minimum" || aggregate.operation === "maximum") &&
        typeof result.value === "boolean"
        ? { kind: "boolean", value: result.value }
        : undefined;
    case "whole_number": {
      if (typeof result.value === "number" && Number.isSafeInteger(result.value))
        return { kind: "number", value: result.value };
      const exactValue = exactDecimalTextSchema.safeParse(result.value);
      return exactValue.success ? { kind: "text", text: exactValue.data } : undefined;
    }
    case "decimal_number": {
      const exactValue = exactDecimalTextSchema.safeParse(result.value);
      return exactValue.success ? { kind: "text", text: exactValue.data } : undefined;
    }
    case "money": {
      const moneyValue = moneyValueSchema.safeParse(result.value);
      return moneyValue.success
        ? { kind: "text", text: `${moneyValue.data.currency} ${moneyValue.data.amount}` }
        : undefined;
    }
    case "date":
    case "date_time":
      return typeof result.value === "string"
        ? { kind: "date", iso: result.value }
        : undefined;
    default:
      return undefined;
  }
};

export const MAXIMUM_LAUNCHER_QUERY_ROWS = 10_000;

export const findModuleQuery = (
  context: InstalledRuntimeContext,
  queryId: string,
): Readonly<{ module: ModuleRelease; query: ModuleQuery }> | undefined => {
  for (const module of context.releaseSet.modules) {
    const query = module.content.queries.find((candidate) => sameId(candidate.queryId, queryId));
    if (query !== undefined) return { module, query };
  }
  return undefined;
};

export const resolvedQueryRecordTypeId = (
  context: InstalledRuntimeContext,
  queryId: string,
): string | undefined => {
  const recordType = findModuleQuery(context, queryId)?.query.recordType;
  return recordType?.state === "resolved" ? String(recordType.recordTypeId) : undefined;
};

export const fieldLabelsOf = (module: ModuleRelease): Record<string, string> =>
  Object.fromEntries(
    module.content.recordTypes.flatMap((recordType) =>
      recordType.fields.map((field) => [String(field.fieldId).toLowerCase(), field.label] as const),
    ),
  );

export const fieldDateTypesOf = (
  module: ModuleRelease,
): Record<string, "date" | "date_time"> =>
  Object.fromEntries(
    module.content.recordTypes.flatMap((recordType) =>
      recordType.fields.flatMap((field) => {
        const valueType =
          field.type === "calculation" || field.type === "total"
            ? field.settings.resultType
            : field.type;
        return valueType === "date" || valueType === "date_time"
          ? [[String(field.fieldId).toLowerCase(), valueType] as const]
          : [];
      }),
    ),
  );

export const fieldLinkTypesOf = (module: ModuleRelease): Record<string, LinkFieldType> =>
  Object.fromEntries(
    module.content.recordTypes.flatMap((recordType) =>
      recordType.fields.flatMap((field) =>
        field.type === "web_address" ||
        field.type === "email_address" ||
        field.type === "phone_number"
          ? [[String(field.fieldId).toLowerCase(), field.type] as const]
          : [],
      ),
    ),
  );

export const isApplicationLauncherPlacement = (placement: unknown): boolean => {
  if (!isRecord(placement) || !isRecord(placement.block)) return false;
  return (
    typeof placement.block.blockId === "string" &&
    sameId(placement.block.blockId, APPLICATION_LAUNCHER_BLOCK_RELEASE.blockId)
  );
};

export const launcherCellKey = (
  settings: Readonly<Record<string, BlockPropertyValueContract>>,
  settingKey: string,
  fallback: string,
): string => {
  const value = settings[settingKey];
  return isRecord(value) && value.kind === "text" && typeof value.value === "string"
    ? value.value
    : fallback;
};

export const fieldChoiceLabelsOf = (
  module: ModuleRelease,
  allowedPermissions: ReadonlySet<string>,
): Record<string, readonly Readonly<{ value: string; label: string }>[]> =>
  Object.fromEntries(
    module.content.recordTypes.flatMap((recordType) =>
      recordType.fields.flatMap((field) => {
        if (field.type !== "several_choices" && field.type !== "choice") return [];
        const labels = field.settings.options.flatMap((option) => {
          const permissionId = option.requiredPermissionId;
          const permissionKey =
            permissionId === undefined
              ? undefined
              : `${String(module.rootId).toLowerCase()}:${String(permissionId).toLowerCase()}`;
          return permissionKey === undefined || allowedPermissions.has(permissionKey)
            ? [{ value: option.value, label: option.label }]
            : [];
        });
        return [[String(field.fieldId).toLowerCase(), labels] as const];
      }),
    ),
  );

/**
 * Logs one data placement that could not be loaded, server side only: the application, page and
 * placement identities that are already in the address, and a fixed reason code. Never a message,
 * value, row, query input or secret, so the log names the failing step without leaking data.
 */
export const logPlacementFailure = (
  address: Readonly<{ application: PermittedApplication; pageKey: string }>,
  placementId: string,
  reason:
    | "query_not_bound"
    | "summary_query_threw"
    | "subject_unavailable"
    | "detail_record_type_unavailable"
    | "detail_command_invalid"
    | "detail_query_unavailable"
    | "detail_query_refused"
    | "launcher_query_invalid"
    | "launcher_query_unavailable"
    | "launcher_query_refused"
    | "calendar_settings_invalid"
    | "calendar_time_zone_unavailable"
    | "calendar_query_invalid"
    | "calendar_query_unavailable"
    | "calendar_query_refused"
    | "calendar_arrangement_refused"
    | "summary_query_invalid"
    | "summary_query_unavailable"
    | "summary_query_refused"
    | "summary_dataset_limit_exceeded"
    | "summary_result_invalid"
    | "chart_settings_invalid"
    | "chart_group_invalid"
    | "chart_measure_invalid"
    | "placement_read_failed"
    | BoardPlacementFailureCause
    | "board_payload_invalid",
  detail?: string,
): void => {
  console.error(
    `[page] data placement not loaded: application=${address.application.key} page=${address.pageKey} placement=${placementId} reason=${reason}${detail === undefined ? "" : ` cause=${detail}`}`,
  );
};

export const requestState = (
  placementId: string,
  parameters: SearchParameters,
): Readonly<{
  sort: { fieldId: string; direction: "ascending" | "descending" } | null;
  filters: { fieldId: string; value: string }[];
  search: string | null;
}> => {
  const sortText = first(parameters[`sort.${placementId}`]);
  const separator = sortText?.lastIndexOf(":") ?? -1;
  const direction = sortText?.slice(separator + 1);
  const sort: { fieldId: string; direction: "ascending" | "descending" } | null =
    sortText !== undefined && separator > 0 && direction === "ascending"
      ? { fieldId: sortText.slice(0, separator), direction: "ascending" }
      : sortText !== undefined && separator > 0 && direction === "descending"
        ? { fieldId: sortText.slice(0, separator), direction: "descending" }
        : null;
  const filterPrefix = `filter.${placementId}.`;
  const filters = Object.entries(parameters).flatMap(([name, value]) => {
    const text = first(value);
    return name.startsWith(filterPrefix) && text !== undefined
      ? [{ fieldId: name.slice(filterPrefix.length), value: text }]
      : [];
  });
  return { sort, filters, search: first(parameters[`search.${placementId}`]) ?? null };
};
