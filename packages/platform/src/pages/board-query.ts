import "server-only";

import type { z } from "zod";
import type { boardPayloadSchema } from "./display-payload-board";

import { formatDecimal, formatMoney } from "./value-format";

import {
  requireInstalledRuntimeContext,
  type InstalledRuntimeContext,
} from "../definition/installed-runtime-context";
import type {
  ProtectedBoardArrangementPage,
  ProtectedBoardArrangementCommand,
  ProtectedBoardArrangementResult,
} from "../queries/arrangement-contracts";
import { arrangeProtectedBoard } from "../queries/arrangements";
import type {
  ProtectedQueryPageRow,
  ProtectedQuerySummaryAggregateResult,
} from "../queries/protected-query-contracts";
import type { createProtectedQueryService } from "../queries/protected-query-service";
import {
  collectRecordLinkValues,
  recordLinkPlainText,
  type ProjectedRecordLinks,
  type RecordLinkResolver,
} from "./component-data-projection";
import {
  conditionalFormattingFieldIds,
  evaluateConditionalFormatting,
  type ConditionalFormattingContext,
} from "./records-table-features";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import type { JsonValue } from "../catalogue/common";
import { describeFailure, sameId } from "../catalogue/runtime-primitives";
import type { ProjectedItem } from "../definition/application-composition/page-composition";
import type { RecordsTableContract } from "../definition/application-composition/records-display";
import type { RecordsTableBoardMode } from "../definition/application-composition/records-table-features";
import {
  boardProblem,
  recordsTableBoardFactsOf,
} from "../definition/application-composition/records-table-features/board";
import { boardFilterProblem } from "../definition/application-composition/records-table-features/column-filters";
import type { RecordsTableFilterField } from "../definition/application-composition/records-table-features/projections/column-filters";
import type { ConditionalFormatStyle } from "../definition/application-composition/records-table-features/conditional-formatting";
import { boardColumnReadRequestSchema } from "../definition/application-contracts";
import { pipelineMovesFrom } from "../definition/record-type-pipelines";
import { exactDecimalTextSchema, moneyValueSchema } from "../records/module-field-values";
import { richTextDocumentSchema } from "../records/rich-text";
import type { RecordsTableFilterValue } from "./records-table-filters";

type ModuleRelease = InstalledRuntimeContext["releaseSet"]["modules"][number];
type ModuleRecordType = ModuleRelease["content"]["recordTypes"][number];
type ModuleField = ModuleRecordType["fields"][number];
type ModuleQuery = ModuleRelease["content"]["queries"][number];
type BoardQueries = Pick<
  ReturnType<typeof createProtectedQueryService>,
  "boardMembers" | "boardColumnPages" | "boardSummary"
>;
type PermissionProjectedPlacement = ProjectedItem;

const lower = (value: string): string => value.toLowerCase();

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

const displayFieldValue = (
  field: ModuleField,
  value: JsonValue,
  recordLinks: ProjectedRecordLinks | undefined,
): BoardCellValue | undefined => {
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
    case "link": {
      // A card shows the linked record's label from the read the viewer may make, never its id.
      const text = recordLinkPlainText(value, recordLinks);
      return text === undefined ? undefined : { kind: "text", text };
    }
    default:
      // Other structured and identity-bearing values have no matching closed display cell.
      return undefined;
  }
};

const projectBoardRow = (
  row: ProtectedQueryPageRow,
  requestedFieldIds: readonly string[],
  fieldsById: ReadonlyMap<string, ModuleField>,
  format: string | undefined,
  recordLinks: ProjectedRecordLinks | undefined,
): BoardCardRow => {
  const declared = requestedFieldIds.map((fieldId) => ({ fieldId }));
  const valuesById = new Map(
    Object.entries(row.values).map(([fieldId, value]) => [lower(fieldId), value] as const),
  );
  const displayFields = declared.flatMap(({ fieldId }) => {
    const field = fieldsById.get(lower(fieldId));
    const stored = valuesById.get(lower(fieldId));
    if (field === undefined || stored === undefined) return [];
    const value = displayFieldValue(field, stored, recordLinks);
    if (value === undefined) return [];
    return [{ key: String(field.fieldId), label: field.label, value }];
  });
  return {
    recordId: row.recordId,
    revision: row.revision,
    capabilities: row.capabilities,
    fields: displayFields,
    ...(format === undefined ? {} : { format: { row: format } }),
  };
};

/** What a board's card formatting is evaluated with; supplied only when Formatting is on. */
type BoardFormatting = Readonly<{
  contract: RecordsTableContract;
  context: ConditionalFormattingContext;
}>;

/**
 * The styles of every enabled rule of the board's Formatting. They travel on every read, so the
 * columns of one read and the pages of another always find the style a card names; a style carries
 * no condition and no value.
 */
const boardFormattingStyles = (
  contract: RecordsTableContract,
): Readonly<Record<string, ConditionalFormatStyle>> =>
  contract.features.conditionalFormatting.enabled
    ? Object.fromEntries(
        contract.features.conditionalFormatting.rules
          .filter((rule) => rule.enabled)
          .map((rule) => [rule.id, rule.style]),
      )
    : {};

/**
 * One bucket in its read state: an untouched bucket carries no count, totals or cards; a read one
 * carries all three, and is undefined when its page is missing.
 */
const boardBucket = (
  rowCount: number | null,
  aggregates: readonly BoardMetric[],
  page: BoardPagePayload | null,
) =>
  rowCount === null
    ? { state: "unread" as const, rowCount: null, aggregates: [] as const, page: null }
    : page === null
      ? undefined
      : { state: "read" as const, rowCount, aggregates, page };

/**
 * One page of cards with only the card's own fields. The rules of the board's formatting are
 * evaluated here, on the rows the engine returned under the viewer's field policy; a value read
 * only for a rule never leaves, and a card that withholds a field a rule reads is not styled by it.
 */
const projectPage = (
  page: ProtectedBoardArrangementPage | null,
  cardFieldIds: readonly string[],
  fieldsById: ReadonlyMap<string, ModuleField>,
  formatting: BoardFormatting | undefined,
  recordLinks: ProjectedRecordLinks | undefined,
): BoardPagePayload | null => {
  if (page === null) return null;
  const formats =
    formatting === undefined
      ? undefined
      : evaluateConditionalFormatting(formatting.contract, [], page.rows, formatting.context, [])
          ?.rows;
  return {
    rows: page.rows.map((row) =>
      projectBoardRow(row, cardFieldIds, fieldsById, formats?.get(row.recordId)?.row, recordLinks),
    ),
    ...(page.nextContinuationToken === undefined
      ? {}
      : { nextContinuationToken: page.nextContinuationToken }),
  };
};

const metricValue = (
  aggregate: ModuleQuery["aggregates"][number],
  field: ModuleField | undefined,
  result: ProtectedQuerySummaryAggregateResult | undefined,
): BoardMetric["value"] | undefined => {
  if (result === undefined) return undefined;
  if (result.outcome === "refused") {
    console.error("[board] total refused", { part: "aggregate", reason: result.reasonCode });
    return { kind: "unavailable" };
  }
  if (aggregate.operation === "count" || aggregate.operation === "distinct_count")
    return typeof result.value === "number" &&
      Number.isSafeInteger(result.value) &&
      result.value >= 0
      ? { kind: "number", value: result.value, formatted: formatDecimal(result.value) }
      : undefined;
  if (result.value === null || result.valueCount === 0) return { kind: "empty" };
  if (field === undefined) return undefined;

  const fieldType =
    field.type === "calculation"
      ? ["add", "subtract", "multiply", "divide", "round"].includes(field.settings.expression.op) &&
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

const withheldMetrics = (cause: string): undefined => {
  console.error(`[board] metrics withheld where=projection cause=${cause}`);
  return undefined;
};

const projectMetrics = (
  definitions: ModuleQuery["aggregates"],
  declared: RecordsTableBoardMode["totals"],
  results: ProtectedBoardArrangementResult["aggregates"],
  fieldsById: ReadonlyMap<string, ModuleField>,
): readonly BoardMetric[] | undefined => {
  const aggregatesByAlias = new Map(definitions.map((aggregate) => [aggregate.alias, aggregate]));
  const values: BoardMetric[] = [];
  for (const metric of declared) {
    const aggregate = aggregatesByAlias.get(metric.alias);
    if (aggregate === undefined) return withheldMetrics(`aggregate_not_declared ${metric.alias}`);
    const field =
      aggregate.fieldId === undefined
        ? undefined
        : fieldsById.get(lower(String(aggregate.fieldId)));
    const value = metricValue(aggregate, field, results[metric.alias]);
    if (value === undefined) return withheldMetrics(`metric_value_invalid ${metric.alias}`);
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
  /** The rule that formats the whole card, when one matched. */
  format?: Readonly<{ row: string }>;
}>;
type BoardPagePayload = NonNullable<BoardPlacementValues["unassigned"]["page"]>;

/** The board's ready values, typed by the schema the browser parses them with. */
export type BoardPlacementValues = z.input<typeof boardPayloadSchema>;

export type BoardPlacementFailureCause =
  | "board_context_refused"
  | "board_selection_mismatch"
  | "board_placement_unavailable"
  | "board_query_not_bound"
  | "board_settings_invalid"
  | "board_query_unsupported"
  | "board_read_invalid"
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
 * Caller, selection, the query inputs its bindings resolved and optional continuation are inputs;
 * module/query identities, field projections, options and page bounds are always rebound here.
 */
export const projectBoardPlacement = async (
  input: Readonly<{
    context: unknown;
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    placement: PermissionProjectedPlacement;
    /** The query inputs the placement's bindings resolved on the server for this request. */
    inputValues: Readonly<Record<string, JsonValue>>;
    queries: BoardQueries;
    /** The placement's Board feature, as the one Records table reader read it. */
    board: RecordsTableBoardMode;
    /** Titles the linked records the cards show, in one batched read under the viewer's access. */
    resolveRecordLinks: RecordLinkResolver;
    /** The board's Formatting with what its rules are evaluated with; supplied only when it is on. */
    formatting?: BoardFormatting;
    /**
     * The placement's Column filters as the viewer's address narrowed them: the declared fields,
     * the condition every column read and total applies and what the filter controls show.
     */
    filters?: Readonly<{
      fieldIds: readonly string[];
      filter: JsonValue | undefined;
      fields: readonly RecordsTableFilterField[];
      applied: readonly RecordsTableFilterValue[];
    }>;
    /**
     * The columns the browser shows (their first pages), or one column's continuation. Without it
     * the first read covers one leading stage; the browser measures any further visible columns.
     */
    read?: unknown;
  }>,
): Promise<BoardPlacementProjection> => {
  const refused = (cause: BoardPlacementFailureCause, reason: string = cause) =>
    ({ outcome: "refused", cause, detail: JSON.stringify({ part: "board", reason }) }) as const;
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

    const board = input.board;
    const binding = findInstalledQuery(context, String(input.placement.props.vortex.queryId));
    if (
      board.columnField === undefined ||
      board.cardTitleField === undefined ||
      board.quickAdd === undefined ||
      binding === undefined
    )
      return unavailable("board_settings_invalid");
    const recordType = recordTypeFor(binding.module, binding.query);
    const sourceFacts =
      recordType === undefined
        ? undefined
        : recordsTableBoardFactsOf(binding.query, recordType.fields, recordType.pipelines);
    // The one capability check publication and Studio run decides whether the installed query can
    // back this board; a refusal logs its sentence as the cause.
    const problem = sourceFacts === undefined ? undefined : boardProblem(board, sourceFacts);
    if (recordType === undefined || sourceFacts === undefined || problem !== undefined)
      return unavailable("board_query_unsupported", problem?.reason);
    // The one filter check publication and Studio run decides whether the declared filter fields
    // can narrow this board's cards.
    const filterProblem =
      input.filters === undefined
        ? undefined
        : boardFilterProblem(input.filters.fieldIds, sourceFacts);
    if (filterProblem !== undefined)
      return unavailable("board_query_unsupported", filterProblem.reason);
    const choiceFieldId = board.columnField;
    const fields = recordType.fields;
    const pipeline = recordType.pipelines.find((candidate) =>
      sameId(String(candidate.stageFieldId), choiceFieldId),
    )!;

    const fieldsById = installedFieldMap(fields);
    const cardFieldIds = [board.cardTitleField, ...board.cardFields];
    // Fields only the formatting rules read are an optional projection: the engine returns each
    // under the viewer's field policy (absent where withheld) and they are stripped from the cards.
    const requestedFieldIds = [
      ...cardFieldIds,
      ...(input.formatting === undefined
        ? []
        : conditionalFormattingFieldIds(input.formatting.contract, []).filter(
            (fieldId) => !cardFieldIds.some((cardFieldId) => sameId(cardFieldId, fieldId)),
          )),
    ];
    const inputValues = input.inputValues;

    let pageRequest: ProtectedBoardArrangementCommand["pageRequest"];
    if (input.read === undefined) {
      pageRequest = {
        kind: "read",
        columns: pipeline.stages
          .slice(0, 1)
          .map((stage) => ({ kind: "option" as const, value: stage.option })),
      };
    } else {
      const read = boardColumnReadRequestSchema.safeParse(input.read);
      if (!read.success) return unavailable("board_read_invalid");
      pageRequest =
        read.data.continuationToken === undefined
          ? { kind: "read", columns: read.data.columns }
          : {
              kind: "continue",
              selector: { choiceFieldId, column: read.data.columns[0]! },
              continuationToken: read.data.continuationToken,
            };
    }

    const result = await arrangeProtectedBoard(input.queries, input.session, input.selection, {
      moduleRootId: binding.module.rootId,
      queryId: binding.query.queryId,
      inputValues,
      requestedFieldIds,
      requestedSystemFieldKeys: [],
      ...(input.filters?.filter === undefined ? {} : { filter: input.filters.filter }),
      filterableFieldIds: input.filters?.fieldIds.map(lower) ?? [],
      choiceFieldId,
      pageSize: binding.query.pageSize,
      pageRequest,
    });
    if (result.kind !== "available") return unavailable("board_query_unavailable");
    if (result.value.outcome === "refused")
      return refused("board_query_refused", result.value.reasonCode);

    const arranged = result.value;
    if (
      arranged.arrangement !== "board" ||
      !sameId(String(arranged.plan.moduleRootId), String(binding.module.rootId)) ||
      arranged.plan.moduleReleaseVersion !== binding.module.releaseVersion ||
      !sameId(String(arranged.plan.queryId), String(binding.query.queryId)) ||
      !sameId(String(arranged.choiceFieldId), choiceFieldId) ||
      arranged.declaredSystemFieldKeys.length !== 0 ||
      arranged.declaredFieldIds.length !== requestedFieldIds.length ||
      requestedFieldIds.some(
        (fieldId, index) => !sameId(String(arranged.declaredFieldIds[index]), fieldId),
      )
    )
      return unavailable("board_arrangement_mismatch");

    // The linked records every card of this read shows are titled in one batched read.
    const linkFieldIds = cardFieldIds.filter(
      (fieldId) => fieldsById.get(lower(fieldId))?.type === "link",
    );
    const cardLinks = collectRecordLinkValues(
      [...arranged.columns.map((column) => column.page), arranged.unassigned.page].flatMap((page) =>
        (page?.rows ?? []).flatMap((row) =>
          Object.entries(row.values).flatMap(([fieldId, value]) =>
            linkFieldIds.some((linkFieldId) => sameId(linkFieldId, fieldId)) ? [value] : [],
          ),
        ),
      ),
    );
    const recordLinks =
      cardLinks.length === 0 ? undefined : await input.resolveRecordLinks(cardLinks);

    // Columns follow the pipeline's stage order; each carries its colour role, the stages a card
    // in it may move to, the named action that owns it, if one does, and whether a new record may
    // start there: a record with no stage moves as if from the start stage, never into a stage an
    // action owns.
    const starts = pipelineMovesFrom(pipeline, undefined);
    const stageOrder = new Map(pipeline.stages.map((stage, index) => [stage.option, index]));
    const owners = binding.module.content.actions.filter(
      (action) =>
        sameId(String(action.subjectRecordTypeId), String(recordType.recordTypeId)) &&
        action.setsChoiceFieldId !== undefined &&
        sameId(String(action.setsChoiceFieldId), choiceFieldId),
    );
    const columns = [...arranged.columns]
      .sort(
        (left, right) =>
          (stageOrder.get(left.value) ?? Number.MAX_SAFE_INTEGER) -
          (stageOrder.get(right.value) ?? Number.MAX_SAFE_INTEGER),
      )
      .flatMap((column) => {
        const stage = pipeline.stages.find((candidate) => candidate.option === column.value);
        const bucketAggregates =
          column.rowCount === null
            ? []
            : projectMetrics(binding.query.aggregates, board.totals, column.aggregates, fieldsById);
        if (stage === undefined || bucketAggregates === undefined) return [];
        const bucket = boardBucket(
          column.rowCount,
          bucketAggregates,
          projectPage(column.page, cardFieldIds, fieldsById, input.formatting, recordLinks),
        );
        if (bucket === undefined) return [];
        const owner = owners.find((action) => action.setsChoiceOption === column.value);
        return [
          {
            value: column.value,
            label: column.label,
            tone: stage.tone,
            moves: pipelineMovesFrom(pipeline, column.value).filter((target) =>
              arranged.columns.some((candidate) => candidate.value === target),
            ),
            ...(owner === undefined ? {} : { gatedBy: owner.label }),
            addable: owner === undefined && starts.includes(column.value),
            ...bucket,
          },
        ];
      });
    const unassignedAggregates =
      arranged.unassigned.rowCount === null
        ? []
        : projectMetrics(
            binding.query.aggregates,
            board.totals,
            arranged.unassigned.aggregates,
            fieldsById,
          );
    if (unassignedAggregates === undefined || columns.length !== arranged.columns.length)
      return unavailable("board_metrics_invalid");
    const unassignedBucket = boardBucket(
      arranged.unassigned.rowCount,
      unassignedAggregates,
      projectPage(
        arranged.unassigned.page,
        cardFieldIds,
        fieldsById,
        input.formatting,
        recordLinks,
      ),
    );
    if (unassignedBucket === undefined) return unavailable("board_arrangement_mismatch");

    const choiceField = fieldsById.get(lower(choiceFieldId));
    if (choiceField === undefined) return unavailable("board_arrangement_mismatch");

    return {
      outcome: "ready",
      values: {
        kind: "board",
        plan: arranged.plan,
        choiceFieldId,
        choiceFieldKey: String(choiceField.key),
        choiceFieldRequired: choiceField.required,
        ...(board.wipLimit === undefined ? {} : { wipLimit: board.wipLimit }),
        quickAdd: board.quickAdd,
        // Filters the viewer cannot read any field of are not offered at all.
        ...(input.filters === undefined || input.filters.fields.length === 0
          ? {}
          : { filters: { fields: input.filters.fields, applied: input.filters.applied } }),
        ...(input.formatting === undefined
          ? {}
          : { formatting: { styles: boardFormattingStyles(input.formatting.contract) } }),
        cardTitleFieldId: board.cardTitleField,
        cardFieldIds,
        columns,
        unassigned: {
          moves: starts.filter((target) =>
            arranged.columns.some((candidate) => candidate.value === target),
          ),
          ...unassignedBucket,
        },
      },
    };
  } catch (error) {
    return unavailable("board_projection_failed", describeFailure(error));
  }
};
