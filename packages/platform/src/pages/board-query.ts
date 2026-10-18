import "server-only";

import { formatDecimal, formatMoney } from "./value-format";

import {
  requireInstalledRuntimeContext,
  type InstalledRuntimeContext,
} from "../definition/app-index";
import { placementSettings } from "../definition/application-composition-catalogue";
import {
  arrangeProtectedBoard,
  type createProtectedQueryService,
  type ProtectedBoardArrangementPage,
  type ProtectedBoardArrangementResult,
  type ProtectedQueryPageRow,
  type ProtectedQuerySummaryAggregateResult,
} from "../queries/index";
import {
  boardBlockSourceIsSupported,
  boardColumnContinuationRequestSchema,
  describeFailure,
  exactDecimalTextSchema,
  moneyValueSchema,
  pipelineMovesFrom,
  readBoardPlacementContract,
  richTextDocumentSchema,
  sameId,
  type ProjectedItem,
  type BoardColumnSelector,
  type BoardPlacementContract,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type PipelineStageTone,
} from "../schema";

type ModuleRelease = InstalledRuntimeContext["releaseSet"]["modules"][number];
type ModuleRecordType = ModuleRelease["content"]["recordTypes"][number];
type ModuleField = ModuleRecordType["fields"][number];
type ModuleQuery = ModuleRelease["content"]["queries"][number];
type BoardQueries = Pick<
  ReturnType<typeof createProtectedQueryService>,
  "boardMembers" | "boardInitialPages" | "boardSummary"
>;
type PermissionProjectedPlacement = ProjectedItem;
type SearchParameters = Readonly<Record<string, string | readonly string[] | undefined>>;

const lower = (value: string): string => value.toLowerCase();

const firstParameter = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === "string" ? value : value?.[0];

/** Uses the same URL-to-typed-input coercion as the installed application page. */
const coerceInput = (raw: string, type: string): JsonValue | undefined => {
  switch (type) {
    case "whole_number": {
      const value = Number(raw);
      return raw.trim() !== "" && Number.isSafeInteger(value) ? value : undefined;
    }
    case "yes_no":
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

const recordTypeFor = (module: ModuleRelease, query: ModuleQuery): ModuleRecordType | undefined => {
  if (query.recordType.state !== "resolved") return undefined;
  const recordTypeId = query.recordType.recordTypeId;
  const matches = module.content.recordTypes.filter((recordType) =>
    sameId(String(recordType.recordTypeId), String(recordTypeId)),
  );
  return matches.length === 1 ? matches[0] : undefined;
};

const installedFieldMap = (fields: readonly ModuleField[]): ReadonlyMap<string, ModuleField> =>
  new Map(fields.map((field) => [lower(String(field.fieldId)), field]));

const displayFieldValue = (field: ModuleField, value: JsonValue): BoardCellValue | undefined => {
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
        ? { kind: "number", value, formatted: formatDecimal(value) }
        : undefined;
    case "decimal_number": {
      const decimal = exactDecimalTextSchema.safeParse(value);
      return decimal.success ? { kind: "text", text: formatDecimal(decimal.data) } : undefined;
    }
    case "money": {
      const money = moneyValueSchema.safeParse(value);
      return money.success ? { kind: "text", text: formatMoney(money.data) } : undefined;
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
      const document = richTextDocumentSchema.safeParse(value);
      return document.success ? { kind: "rich_text", document: document.data } : undefined;
    }
    case "choice": {
      if (typeof value !== "string") return undefined;
      const option = field.settings.options.find((candidate) => candidate.value === value);
      return option === undefined ? undefined : { kind: "text", text: option.label };
    }
    case "several_choices": {
      if (typeof value !== "object" || !Array.isArray(value)) return undefined;
      const labels = value.map((candidate) => {
        if (typeof candidate !== "string") return undefined;
        const option = field.settings.options.find((entry) => entry.value === candidate);
        return option?.label;
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
): BoardCardRow => {
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
): BoardPagePayload | null =>
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
      ? { kind: "number", value: result.value, formatted: formatDecimal(result.value) }
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
    case "whole_number":
      if (typeof result.value === "number" && Number.isSafeInteger(result.value))
        return { kind: "number", value: result.value, formatted: formatDecimal(result.value) };
      {
        const exact = exactDecimalTextSchema.safeParse(result.value);
        return exact.success ? { kind: "text", text: formatDecimal(exact.data) } : undefined;
      }
    case "decimal_number": {
      const exact = exactDecimalTextSchema.safeParse(result.value);
      return exact.success ? { kind: "text", text: formatDecimal(exact.data) } : undefined;
    }
    case "money": {
      const money = moneyValueSchema.safeParse(result.value);
      return money.success ? { kind: "text", text: formatMoney(money.data) } : undefined;
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

type BoardCellValue =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "number"; value: number; formatted: string }>
  | Readonly<{ kind: "boolean"; value: boolean }>
  | Readonly<{ kind: "date"; iso: string }>
  | Readonly<{ kind: "rich_text"; document: ReturnType<typeof richTextDocumentSchema.parse> }>
  | Readonly<{ kind: "empty" }>;
type BoardMetric = Readonly<{
  key: string;
  label: string;
  value: BoardCellValue | Readonly<{ kind: "unavailable" }>;
}>;
type BoardCardRow = Readonly<{
  recordId: ProtectedQueryPageRow["recordId"];
  revision: ProtectedQueryPageRow["revision"];
  capabilities: ProtectedQueryPageRow["capabilities"];
  fields: readonly Readonly<{ key: string; label: string; value: BoardCellValue }>[];
}>;
type BoardPagePayload = Readonly<{
  rows: readonly BoardCardRow[];
  nextContinuationToken?: string;
}>;
type BoardBucketValues = Readonly<{
  rowCount: number;
  aggregates: readonly BoardMetric[];
  page: BoardPagePayload | null;
}>;
/** One pipeline stage as a board column: its colour role, where a card may go and who owns it. */
type BoardStageValues = Readonly<{
  value: string;
  label: string;
  tone: PipelineStageTone;
  moves: readonly string[];
  gatedBy?: string;
}>;

/** The board's ready values; the caller validates them with the board payload parser. */
export type BoardPlacementValues = Readonly<{
  kind: "board";
  title?: string;
  plan: Extract<ProtectedBoardArrangementResult, { arrangement: "board" }>["plan"];
  choiceFieldId: string;
  /** The key the record save names the choice field by when a card moves to another column. */
  choiceFieldKey: string;
  cardTitleFieldId: string;
  cardFieldIds: readonly string[];
  totalRowCount: number;
  aggregates: readonly BoardMetric[];
  columns: readonly (BoardBucketValues & BoardStageValues)[];
  unassigned: BoardBucketValues;
}>;

export type BoardPlacementFailureCause =
  | "board_context_refused"
  | "board_selection_mismatch"
  | "board_placement_unavailable"
  | "board_query_not_bound"
  | "board_settings_invalid"
  | "board_query_unsupported"
  | "board_continuation_invalid"
  | "board_query_unavailable"
  | "board_query_refused"
  | "board_arrangement_mismatch"
  | "board_metrics_invalid"
  | "board_projection_failed";

/**
 * One board placement read. A refusal names its cause for the server log; `unavailable` is a
 * temporary, structural or malformed-request failure (a scope mismatch or a malformed continuation
 * is never a permission refusal), `refused` a settled permission refusal.
 */
export type BoardPlacementProjection =
  | Readonly<{ outcome: "ready"; values: BoardPlacementValues }>
  | Readonly<{
      outcome: "refused" | "unavailable";
      cause: BoardPlacementFailureCause;
      /** The underlying failure text, present only when the cause was a thrown error. */
      detail?: string;
    }>;

/**
 * Adapts one permission-projected placement and installed Query into the board's ready values.
 * Caller, selection, parameters and optional continuation are inputs; module/query identities,
 * field projections, options and page bounds are always rebound here.
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
): Promise<BoardPlacementProjection> => {
  const refused = (cause: BoardPlacementFailureCause) => ({ outcome: "refused", cause }) as const;
  const unavailable = (cause: BoardPlacementFailureCause, detail?: string) =>
    ({ outcome: "unavailable", cause, ...(detail === undefined ? {} : { detail }) }) as const;
  try {
    let context: InstalledRuntimeContext;
    try {
      context = requireInstalledRuntimeContext(input.context);
    } catch (error) {
      return unavailable("board_context_refused", describeFailure(error));
    }
    if (
      !sameId(String(input.selection.organizationId), String(context.organizationId)) ||
      input.selection.applicationRootId === undefined ||
      !sameId(String(input.selection.applicationRootId), String(context.applicationRootId))
    )
      return unavailable("board_selection_mismatch");
    if (input.placement.props.vortex.availability === "unavailable")
      return refused("board_placement_unavailable");
    if (input.placement.props.vortex.queryId === undefined)
      return unavailable("board_query_not_bound");

    const contract = readBoardPlacementContract(placementSettings(input.placement.props));
    const binding = findInstalledQuery(context, String(input.placement.props.vortex.queryId));
    if (contract === undefined || binding === undefined)
      return unavailable("board_settings_invalid");
    const recordType = recordTypeFor(binding.module, binding.query);
    if (
      recordType === undefined ||
      !boardBlockSourceIsSupported(binding.query, recordType.fields, recordType.pipelines, contract)
    )
      return unavailable("board_query_unsupported");
    const fields = recordType.fields;
    const pipeline = recordType.pipelines.find((candidate) =>
      sameId(String(candidate.stageFieldId), String(contract.choiceField)),
    )!;

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
      if (!continuation.success) return unavailable("board_continuation_invalid");
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
    if (result.kind !== "available") return unavailable("board_query_unavailable");
    if (result.value.outcome === "refused") return refused("board_query_refused");

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
      return unavailable("board_arrangement_mismatch");

    const aggregates = projectMetrics(
      binding.query.aggregates,
      contract.aggregateMetrics,
      board.aggregates,
      fieldsById,
    );
    // Columns follow the pipeline's stage order; each carries its colour role, the stages a card
    // in it may move to and the named action that owns it, if one does.
    const stageOrder = new Map(pipeline.stages.map((stage, index) => [stage.option, index]));
    const owners = binding.module.content.actions.filter(
      (action) =>
        sameId(String(action.subjectRecordTypeId), String(recordType.recordTypeId)) &&
        action.setsChoiceFieldId !== undefined &&
        sameId(String(action.setsChoiceFieldId), String(contract.choiceField)),
    );
    const columns = [...board.columns]
      .sort(
        (left, right) =>
          (stageOrder.get(left.value) ?? Number.MAX_SAFE_INTEGER) -
          (stageOrder.get(right.value) ?? Number.MAX_SAFE_INTEGER),
      )
      .flatMap((column) => {
        const stage = pipeline.stages.find((candidate) => candidate.option === column.value);
        const bucketAggregates = projectMetrics(
          binding.query.aggregates,
          contract.aggregateMetrics,
          column.aggregates,
          fieldsById,
        );
        if (stage === undefined || bucketAggregates === undefined) return [];
        const owner = owners.find((action) => action.setsChoiceOption === column.value);
        return [
          {
            value: column.value,
            label: column.label,
            tone: stage.tone,
            moves: pipelineMovesFrom(pipeline, column.value).filter((target) =>
              board.columns.some((candidate) => candidate.value === target),
            ),
            ...(owner === undefined ? {} : { gatedBy: owner.label }),
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
      return unavailable("board_metrics_invalid");

    const choiceField = fieldsById.get(lower(String(contract.choiceField)));
    if (choiceField === undefined) return unavailable("board_arrangement_mismatch");

    return {
      outcome: "ready",
      values: {
        kind: "board",
        ...(contract.title === undefined ? {} : { title: contract.title }),
        plan: board.plan,
        choiceFieldId: contract.choiceField,
        choiceFieldKey: String(choiceField.key),
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
      },
    };
  } catch (error) {
    return unavailable("board_projection_failed", describeFailure(error));
  }
};
