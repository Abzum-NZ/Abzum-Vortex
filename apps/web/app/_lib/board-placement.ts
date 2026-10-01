import "server-only";

import {
  boardBlockSourceIsSupported,
  boardColumnContinuationRequestSchema,
  exactDecimalTextV2Schema,
  moneyValueV2Schema,
  readBoardPlacementContract,
  richTextDocumentV2Schema,
  sameId,
  type BlockPlacementV2Contract,
  type BoardColumnSelector,
  type BoardPlacementContract,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import { requireInstalledRuntimeContext, type InstalledRuntimeContext } from "@vortex/app";
import {
  arrangeProtectedBoard,
  createProtectedQueryService,
  type ProtectedBoardArrangementPage,
  type ProtectedBoardArrangementResult,
  type ProtectedQueryPageRow,
  type ProtectedQuerySummaryAggregateResult,
} from "@vortex/query";
import {
  parseBoardPayload,
  parseDisplayData,
  type BoardBucketPayload,
  type BoardPage,
  type BoardData,
  type BoardPayload,
  type DisplayCellValue,
} from "@vortex/ui";

type ModuleRelease = InstalledRuntimeContext["releaseSet"]["modules"][number];
type ModuleField = ModuleRelease["content"]["recordTypes"][number]["fields"][number];
type ModuleQuery = ModuleRelease["content"]["queries"][number];
type BoardMetric = BoardPayload["aggregates"][number];
type BoardQueries = Pick<
  ReturnType<typeof createProtectedQueryService>,
  "boardMembers" | "boardSummary"
>;
type PermissionProjectedPlacement = BlockPlacementV2Contract &
  Readonly<{
    availability?: "unavailable";
    unavailableReason?: "operation_unavailable";
  }>;
type SearchParameters = Readonly<Record<string, string | readonly string[] | undefined>>;

const lower = (value: string): string => value.toLowerCase();

const firstParameter = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === "string" ? value : value?.[0];

/** Uses the same URL-to-typed-input coercion as the installed application page. */
const coerceInput = (raw: string, type: string): JsonValue | undefined => {
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

const findInstalledQuery = (
  context: InstalledRuntimeContext,
  queryId: string,
): Readonly<{ module: ModuleRelease; query: ModuleQuery }> | undefined => {
  const matches = context.releaseSet.modules.flatMap((module) =>
    module.content.queries
      .filter((query) => sameId(String(query.queryId), queryId))
      .map((query) => ({ module, query })),
  );
  return matches.length === 1 ? matches[0] : undefined;
};

const fieldsFor = (
  module: ModuleRelease,
  query: ModuleQuery,
): readonly ModuleField[] | undefined => {
  if (query.recordType.state !== "resolved") return undefined;
  const recordTypeId = query.recordType.recordTypeId;
  const matches = module.content.recordTypes.filter((recordType) =>
    sameId(String(recordType.recordTypeId), String(recordTypeId)),
  );
  return matches.length === 1 && matches[0] !== undefined ? matches[0].fields : undefined;
};

const installedFieldMap = (fields: readonly ModuleField[]): ReadonlyMap<string, ModuleField> =>
  new Map(fields.map((field) => [lower(String(field.fieldId)), field]));

const displayFieldValue = (field: ModuleField, value: JsonValue): DisplayCellValue | undefined => {
  if (value === null) return { kind: "empty" };
  switch (field.type) {
    case "text":
    case "long_text":
    case "email_address":
    case "phone_number":
    case "reference_number":
      return typeof value === "string" ? { kind: "text", text: value } : undefined;
    case "whole_number":
      return typeof value === "number" && Number.isSafeInteger(value)
        ? { kind: "number", value }
        : undefined;
    case "decimal_number": {
      const decimal = exactDecimalTextV2Schema.safeParse(value);
      return decimal.success ? { kind: "text", text: decimal.data } : undefined;
    }
    case "money": {
      const money = moneyValueV2Schema.safeParse(value);
      return money.success
        ? { kind: "text", text: `${money.data.currency} ${money.data.amount}` }
        : undefined;
    }
    case "yes_no":
      return typeof value === "boolean" ? { kind: "boolean", value } : undefined;
    case "date":
      return typeof value === "string" ? { kind: "date", iso: value } : undefined;
    case "date_time":
      return typeof value === "string" ? { kind: "date", iso: value } : undefined;
    case "web_address":
      return typeof value === "string" ? { kind: "text", text: value } : undefined;
    case "formatted_text": {
      const document = richTextDocumentV2Schema.safeParse(value);
      return document.success ? { kind: "rich_text", document: document.data } : undefined;
    }
    case "choice": {
      if (typeof value !== "string") return undefined;
      const option = field.settings.options.find((candidate) => candidate.value === value);
      return option === undefined || option.requiredPermissionId !== undefined
        ? undefined
        : { kind: "text", text: option.label };
    }
    case "several_choices": {
      if (typeof value !== "object" || !Array.isArray(value)) return undefined;
      const labels = value.map((candidate) => {
        if (typeof candidate !== "string") return undefined;
        const option = field.settings.options.find((entry) => entry.value === candidate);
        return option === undefined || option.requiredPermissionId !== undefined
          ? undefined
          : option.label;
      });
      return labels.every((label): label is string => label !== undefined)
        ? { kind: "text", text: labels.join(", ") }
        : undefined;
    }
    default:
      // Other structured and identity-bearing values have no matching closed display cell.
      return undefined;
  }
};

const projectBoardRow = (
  row: ProtectedQueryPageRow,
  contract: BoardPlacementContract,
  fieldsById: ReadonlyMap<string, ModuleField>,
): BoardPage["rows"][number] => {
  const declared = [
    { fieldId: contract.cardTitleField, label: undefined },
    ...contract.detailFields.map((entry) => ({ fieldId: entry.field, label: entry.label })),
  ];
  const valuesById = new Map(
    Object.entries(row.values).map(([fieldId, value]) => [lower(fieldId), value] as const),
  );
  const displayFields = declared.flatMap(({ fieldId, label }) => {
    const field = fieldsById.get(lower(fieldId));
    const stored = valuesById.get(lower(fieldId));
    if (field === undefined || stored === undefined) return [];
    const value = displayFieldValue(field, stored);
    if (value === undefined) return [];
    return [{ key: String(field.fieldId), label: label ?? field.label, value }];
  });
  return {
    recordId: row.recordId,
    revision: row.revision,
    capabilities: row.capabilities,
    fields: displayFields,
  };
};

const projectPage = (
  page: ProtectedBoardArrangementPage | null,
  contract: BoardPlacementContract,
  fieldsById: ReadonlyMap<string, ModuleField>,
): BoardBucketPayload["page"] =>
  page === null
    ? null
    : {
        rows: page.rows.map((row) => projectBoardRow(row, contract, fieldsById)),
        ...(page.nextContinuationToken === undefined
          ? {}
          : { nextContinuationToken: page.nextContinuationToken }),
      };

const metricValue = (
  aggregate: ModuleQuery["aggregates"][number],
  field: ModuleField | undefined,
  result: ProtectedQuerySummaryAggregateResult | undefined,
): BoardMetric["value"] | undefined => {
  if (result === undefined) return undefined;
  if (result.outcome === "refused") return { kind: "unavailable" };
  if (aggregate.operation === "count")
    return typeof result.value === "number" &&
      Number.isSafeInteger(result.value) &&
      result.value >= 0
      ? { kind: "number", value: result.value }
      : undefined;
  if (result.value === null || result.valueCount === 0) return { kind: "empty" };
  if (field === undefined) return undefined;

  switch (field.type) {
    case "whole_number":
      if (typeof result.value === "number" && Number.isSafeInteger(result.value))
        return { kind: "number", value: result.value };
      {
        const exact = exactDecimalTextV2Schema.safeParse(result.value);
        return exact.success ? { kind: "text", text: exact.data } : undefined;
      }
    case "decimal_number": {
      const exact = exactDecimalTextV2Schema.safeParse(result.value);
      return exact.success ? { kind: "text", text: exact.data } : undefined;
    }
    case "money": {
      const money = moneyValueV2Schema.safeParse(result.value);
      return money.success
        ? { kind: "text", text: `${money.data.currency} ${money.data.amount}` }
        : undefined;
    }
    case "date":
    case "date_time":
      return typeof result.value === "string" ? { kind: "date", iso: result.value } : undefined;
    default:
      return undefined;
  }
};

const projectMetrics = (
  definitions: ModuleQuery["aggregates"],
  declared: BoardPlacementContract["aggregateMetrics"],
  results: ProtectedBoardArrangementResult["aggregates"],
  fieldsById: ReadonlyMap<string, ModuleField>,
): readonly BoardMetric[] | undefined => {
  const aggregatesByAlias = new Map(definitions.map((aggregate) => [aggregate.alias, aggregate]));
  const values: BoardMetric[] = [];
  for (const metric of declared) {
    const aggregate = aggregatesByAlias.get(metric.alias);
    if (aggregate === undefined) return undefined;
    const field =
      aggregate.fieldId === undefined
        ? undefined
        : fieldsById.get(lower(String(aggregate.fieldId)));
    const value = metricValue(aggregate, field, results[metric.alias]);
    if (value === undefined) return undefined;
    values.push({ key: metric.alias, label: metric.label, value });
  }
  return values;
};

const unavailableState = (): BoardData => ({ status: "error" });
const refusedState = (): BoardData => ({ status: "refused", reason: "not_permitted" });

/**
 * Adapts one permission-projected placement and installed Query into the closed board payload.
 * Caller, selection, parameters and optional continuation are inputs to this server-only adapter;
 * module/query identities, field projections, options and page bounds are always rebound here.
 */
export const projectBoardPlacement = async (
  input: Readonly<{
    context: unknown;
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    placement: PermissionProjectedPlacement;
    parameters: SearchParameters;
    queries: BoardQueries;
    continuation?: unknown;
  }>,
): Promise<BoardData> => {
  try {
    const context = requireInstalledRuntimeContext(input.context);
    if (
      !sameId(String(input.selection.organizationId), String(context.organizationId)) ||
      input.selection.applicationRootId === undefined ||
      !sameId(String(input.selection.applicationRootId), String(context.applicationRootId))
    )
      return refusedState();
    if (input.placement.availability === "unavailable") return refusedState();
    if (input.placement.queryId === undefined) return unavailableState();

    const contract = readBoardPlacementContract(input.placement.settings);
    const binding = findInstalledQuery(context, String(input.placement.queryId));
    if (contract === undefined || binding === undefined) return unavailableState();
    const fields = fieldsFor(binding.module, binding.query);
    if (fields === undefined || !boardBlockSourceIsSupported(binding.query, fields, contract))
      return unavailableState();

    const fieldsById = installedFieldMap(fields);
    const requestedFieldIds = [
      contract.cardTitleField,
      ...contract.detailFields.map((field) => field.field),
    ];
    const inputValues: Record<string, JsonValue> = {};
    for (const declared of binding.query.inputs) {
      const raw = firstParameter(input.parameters[declared.key]);
      const value = raw === undefined ? undefined : coerceInput(raw, declared.type);
      if (value !== undefined) inputValues[declared.key] = value;
    }

    let pageRequest:
      | Readonly<{ kind: "initial" }>
      | Readonly<{
          kind: "continue";
          selector: Readonly<{ choiceFieldId: string; column: BoardColumnSelector }>;
          continuationToken: string;
        }> = { kind: "initial" };
    if (input.continuation !== undefined) {
      const continuation = boardColumnContinuationRequestSchema.safeParse(input.continuation);
      if (!continuation.success) return refusedState();
      pageRequest = {
        kind: "continue",
        selector: {
          choiceFieldId: String(contract.choiceField),
          column: continuation.data.column,
        },
        continuationToken: continuation.data.continuationToken,
      };
    }

    const result = await arrangeProtectedBoard(input.queries, input.session, input.selection, {
      moduleRootId: binding.module.rootId,
      queryId: binding.query.queryId,
      inputValues,
      requestedFieldIds,
      requestedSystemFieldKeys: [],
      filterableFieldIds: [],
      choiceFieldId: contract.choiceField,
      pageSize: binding.query.pageSize,
      pageRequest,
    });
    if (result.kind !== "available") return unavailableState();
    if (result.value.outcome === "refused") return refusedState();

    const board = result.value;
    if (
      board.arrangement !== "board" ||
      !sameId(String(board.plan.moduleRootId), String(binding.module.rootId)) ||
      board.plan.moduleReleaseVersion !== binding.module.releaseVersion ||
      !sameId(String(board.plan.queryId), String(binding.query.queryId)) ||
      !sameId(String(board.choiceFieldId), String(contract.choiceField)) ||
      board.declaredSystemFieldKeys.length !== 0 ||
      board.declaredFieldIds.length !== requestedFieldIds.length ||
      requestedFieldIds.some(
        (fieldId, index) => !sameId(String(board.declaredFieldIds[index]), fieldId),
      )
    )
      return unavailableState();

    const aggregates = projectMetrics(
      binding.query.aggregates,
      contract.aggregateMetrics,
      board.aggregates,
      fieldsById,
    );
    const columns = board.columns.flatMap((column) => {
      const bucketAggregates = projectMetrics(
        binding.query.aggregates,
        contract.aggregateMetrics,
        column.aggregates,
        fieldsById,
      );
      return bucketAggregates === undefined
        ? []
        : [
            {
              value: column.value,
              label: column.label,
              rowCount: column.rowCount,
              aggregates: bucketAggregates,
              page: projectPage(column.page, contract, fieldsById),
            },
          ];
    });
    const unassignedAggregates = projectMetrics(
      binding.query.aggregates,
      contract.aggregateMetrics,
      board.unassigned.aggregates,
      fieldsById,
    );
    if (
      aggregates === undefined ||
      unassignedAggregates === undefined ||
      columns.length !== board.columns.length
    )
      return unavailableState();

    const payload: BoardPayload = {
      kind: "board",
      ...(contract.title === undefined ? {} : { title: contract.title }),
      plan: board.plan,
      choiceFieldId: contract.choiceField,
      cardTitleFieldId: contract.cardTitleField,
      cardFieldIds: requestedFieldIds,
      totalRowCount: board.totalRowCount,
      aggregates,
      columns,
      unassigned: {
        rowCount: board.unassigned.rowCount,
        aggregates: unassignedAggregates,
        page: projectPage(board.unassigned.page, contract, fieldsById),
      },
    };
    return parseDisplayData({ status: "ready", values: payload }, parseBoardPayload);
  } catch {
    return unavailableState();
  }
};
