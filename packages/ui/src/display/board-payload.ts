import {
  builderKeySchema,
  fieldIdSchema,
  moduleRootIdSchema,
  pipelineStageToneSchema,
  queryIdSchema,
  recordIdSchema,
  stableDefinitionReleaseVersionSchema,
} from "@vortex/platform/schema";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import {
  fail,
  parseFields,
  parseRowCapabilities,
  parseSummaryMetrics,
  requireArray,
  requireExactKeys,
  requireNonEmptyString,
  requirePositiveInteger,
  requireRecord,
  requireString,
  type BoardBucketPayload,
  type BoardPage,
  type BoardPayload,
  type DisplaySummaryMetric,
} from "./projected-data";

/**
 * The strict bounded payload a query-bound board renders: its protected columns in pipeline stage
 * order, each with its colour role, the stages a card in it may move to and the action that owns
 * it, and the unassigned bucket.
 */
const maximumBoardRows = 100_000;
const maximumBoardColumns = 12;
const maximumBoardPageSize = 200;

const parseBoardCount = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximumBoardRows
  )
    return fail(message, location);
  return value;
};

const parseBoardMetrics = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): readonly DisplaySummaryMetric[] => {
  const items = requireArray(value, "Board aggregates must be an array", location);
  if (items.length > 20) fail("A board displays at most twenty declared aggregates", location);
  const metrics = parseSummaryMetrics(items, location);
  if (metrics.some((metric) => metric.label.length > 60))
    fail("A board aggregate label exceeds its bound", location);
  return metrics;
};

const requireMatchingBoardMetrics = (
  expected: readonly DisplaySummaryMetric[],
  actual: readonly DisplaySummaryMetric[],
  location: DefinitionRenderErrorLocation,
): void => {
  if (
    expected.length !== actual.length ||
    expected.some((metric, index) => metric.key !== actual[index]?.key)
  )
    fail("Every board bucket carries the same declared aggregate aliases in order", location);
};

const parseBoardPage = (
  value: unknown,
  declaredCardFields: ReadonlySet<string>,
  seenRecordIds: Set<string>,
  location: DefinitionRenderErrorLocation,
): BoardPage => {
  const record = requireRecord(value, "A board page must be an object", location);
  requireExactKeys(record, ["rows", "nextContinuationToken"], location);
  const candidates = requireArray(record.rows, "Board page rows must be an array", location);
  if (candidates.length > maximumBoardPageSize)
    fail("A board page cannot exceed the protected Query page bound", location);
  const rows = candidates.map((candidate, index) => {
    const rowLocation = { ...location, propertyPath: [`rows[${index}]`] };
    const row = requireRecord(candidate, "A board card must be an object", rowLocation);
    requireExactKeys(row, ["recordId", "revision", "capabilities", "fields"], rowLocation);
    const parsedRecordId = recordIdSchema.safeParse(row.recordId);
    if (!parsedRecordId.success) fail("A board card requires a valid record identity", rowLocation);
    const normalizedRecordId = parsedRecordId.data.toLowerCase();
    if (seenRecordIds.has(normalizedRecordId))
      fail("A record identity appears in at most one fetched board bucket", rowLocation);
    seenRecordIds.add(normalizedRecordId);

    const revision = requirePositiveInteger(
      row.revision,
      "A board card requires the server-projected record revision",
      rowLocation,
    );
    if (!Number.isSafeInteger(revision))
      fail("A board card revision must be a safe integer", rowLocation);
    const capabilities = parseRowCapabilities(row.capabilities, {
      ...rowLocation,
      propertyPath: [`rows[${index}]`, "capabilities"],
    });
    const fields = parseFields(row.fields, rowLocation);
    const seenFields = new Set<string>();
    for (const field of fields) {
      const key = field.key.toLowerCase();
      if (!declaredCardFields.has(key))
        fail("A board card contains a field outside its declared card projection", rowLocation);
      if (seenFields.has(key)) fail("A board card field appears once", rowLocation);
      if (field.label.length > 60) fail("A board card field label exceeds its bound", rowLocation);
      if (field.value.kind === "text" && field.value.text.length > 1_000_000)
        fail("A board card text value exceeds its field contract bound", rowLocation);
      seenFields.add(key);
    }
    return Object.freeze({
      recordId: parsedRecordId.data,
      revision,
      capabilities,
      fields,
    });
  });
  let nextContinuationToken: string | undefined;
  if (record.nextContinuationToken !== undefined) {
    nextContinuationToken = requireNonEmptyString(
      record.nextContinuationToken,
      "A board continuation token must be non-empty",
      location,
    );
    if (nextContinuationToken.length > 65_536)
      fail("A board continuation token exceeds its bound", location);
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    ...(nextContinuationToken === undefined ? {} : { nextContinuationToken }),
  });
};

const parseBoardBucket = (
  value: unknown,
  declaredCardFields: ReadonlySet<string>,
  seenRecordIds: Set<string>,
  location: DefinitionRenderErrorLocation,
): BoardBucketPayload => {
  const record = requireRecord(value, "A board bucket must be an object", location);
  requireExactKeys(record, ["state", "rowCount", "aggregates", "page"], location);
  if (record.state !== "unread" && record.state !== "reading" && record.state !== "read")
    return fail("A board bucket requires an explicit read state", location);
  if (record.state !== "read") {
    if (
      record.rowCount !== null ||
      record.page !== null ||
      !Array.isArray(record.aggregates) ||
      record.aggregates.length !== 0
    )
      return fail("An unread board bucket carries no counts, totals or cards", location);
    return Object.freeze({ state: record.state, rowCount: null, aggregates: [], page: null });
  }
  if (record.page === null) return fail("A read board bucket requires its page", location);
  const rowCount = parseBoardCount(
    record.rowCount,
    "A board bucket requires a safe protected row count",
    location,
  );
  const aggregates = parseBoardMetrics(record.aggregates, location);
  const page =
    record.page === null
      ? null
      : parseBoardPage(record.page, declaredCardFields, seenRecordIds, location);
  return Object.freeze({ state: "read", rowCount, aggregates, page });
};

export const parseBoardPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): BoardPayload => {
  const record = requireRecord(value, "Projected board values must be an object", location);
  if (record.kind !== "board")
    return fail(`Expected 'board' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(
    record,
    [
      "kind",
      "plan",
      "choiceFieldId",
      "choiceFieldKey",
      "choiceFieldRequired",
      "wipLimit",
      "quickAdd",
      "cardTitleFieldId",
      "cardFieldIds",
      "columns",
      "unassigned",
    ],
    location,
  );

  const planRecord = requireRecord(record.plan, "A board requires its exact source plan", location);
  requireExactKeys(planRecord, ["moduleRootId", "moduleReleaseVersion", "queryId"], location);
  const moduleRootId = moduleRootIdSchema.safeParse(planRecord.moduleRootId);
  const moduleReleaseVersion = stableDefinitionReleaseVersionSchema.safeParse(
    planRecord.moduleReleaseVersion,
  );
  const queryId = queryIdSchema.safeParse(planRecord.queryId);
  if (!moduleRootId.success || !moduleReleaseVersion.success || !queryId.success)
    fail("A board source plan requires exact installed identities", location);

  const choiceFieldId = fieldIdSchema.safeParse(record.choiceFieldId);
  const cardTitleFieldId = fieldIdSchema.safeParse(record.cardTitleFieldId);
  const choiceFieldKey = builderKeySchema.safeParse(record.choiceFieldKey);
  if (!choiceFieldKey.success) fail("A board requires the key of its choice field", location);
  if (typeof record.quickAdd !== "boolean") fail("A board's quick add is not a boolean", location);
  if (typeof record.choiceFieldRequired !== "boolean")
    fail("A board requires its stage field's required setting", location);
  let wipLimit: number | undefined;
  if (record.wipLimit !== undefined) {
    wipLimit = requirePositiveInteger(
      record.wipLimit,
      "A board's card limit must be a positive integer",
      location,
    );
    if (wipLimit > 1_000) fail("A board's card limit exceeds its bound", location);
  }
  if (!choiceFieldId.success || !cardTitleFieldId.success)
    fail("A board requires valid choice and card-title field identities", location);
  const cardFieldCandidates = requireArray(
    record.cardFieldIds,
    "A board requires its closed card-field allow-list",
    location,
  );
  if (cardFieldCandidates.length < 1 || cardFieldCandidates.length > 4)
    fail("A board declares one card title and at most three detail fields", location);
  const cardFieldIds = cardFieldCandidates.map((candidate) => {
    const fieldId = fieldIdSchema.safeParse(candidate);
    return fieldId.success
      ? fieldId.data
      : fail("A board card field identity is invalid", location);
  });
  const declaredCardFields = new Set(cardFieldIds.map((fieldId) => fieldId.toLowerCase()));
  if (
    declaredCardFields.size !== cardFieldIds.length ||
    cardFieldIds[0]?.toLowerCase() !== cardTitleFieldId.data.toLowerCase()
  )
    fail("Board card field identities are unique and start with the card title", location);

  const seenRecordIds = new Set<string>();
  const columnCandidates = requireArray(record.columns, "Board columns must be an array", location);
  if (columnCandidates.length < 1 || columnCandidates.length > maximumBoardColumns)
    fail("A board contains one to twelve installed option columns", location);
  const seenOptions = new Set<string>();
  const columns = columnCandidates.map((candidate, index) => {
    const columnLocation = { ...location, propertyPath: [`columns[${index}]`] };
    const column = requireRecord(candidate, "A board column must be an object", columnLocation);
    requireExactKeys(
      column,
      ["value", "label", "tone", "moves", "gatedBy", "state", "rowCount", "aggregates", "page"],
      columnLocation,
    );
    const optionValue = requireString(
      column.value,
      "An installed board option requires its value",
      columnLocation,
    );
    if (optionValue.length < 1 || optionValue.length > 120 || seenOptions.has(optionValue))
      fail("Board option values are bounded and unique", columnLocation);
    seenOptions.add(optionValue);
    const label = requireNonEmptyString(
      column.label,
      "An installed board option requires its current label",
      columnLocation,
    );
    if (label.length > 60)
      fail("An installed board option label exceeds its bound", columnLocation);
    const tone = pipelineStageToneSchema.safeParse(column.tone);
    if (!tone.success) fail("A board column requires its stage's colour role", columnLocation);
    const moves = requireArray(
      column.moves,
      "A board column lists the stages it moves to",
      columnLocation,
    );
    if (
      moves.length >= maximumBoardColumns ||
      moves.some((move) => typeof move !== "string" || move === optionValue) ||
      new Set(moves).size !== moves.length
    )
      fail("A board column moves to other columns, each once", columnLocation);
    let gatedBy: string | undefined;
    if (column.gatedBy !== undefined) {
      gatedBy = requireNonEmptyString(
        column.gatedBy,
        "The action that owns a board column requires its name",
        columnLocation,
      );
      if (gatedBy.length > 60)
        fail("A board column's action name exceeds its bound", columnLocation);
    }
    const bucket = parseBoardBucket(
      {
        state: column.state,
        rowCount: column.rowCount,
        aggregates: column.aggregates,
        page: column.page,
      },
      declaredCardFields,
      seenRecordIds,
      columnLocation,
    );
    return Object.freeze({
      value: optionValue,
      label,
      tone: tone.data,
      moves: Object.freeze(moves as string[]),
      ...(gatedBy === undefined ? {} : { gatedBy }),
      ...bucket,
    });
  });
  // Every move goes to another column of this board.
  for (const column of columns)
    if (column.moves.some((move) => !seenOptions.has(move)))
      fail("A board column moves only to columns of the board", location);
  const unassignedLocation = { ...location, propertyPath: ["unassigned"] };
  const unassignedRecord = requireRecord(
    record.unassigned,
    "A board's unassigned bucket must be an object",
    unassignedLocation,
  );
  requireExactKeys(
    unassignedRecord,
    ["moves", "state", "rowCount", "aggregates", "page"],
    unassignedLocation,
  );
  const unassignedMoves = requireArray(
    unassignedRecord.moves,
    "A board's unassigned bucket lists the stages it moves to",
    unassignedLocation,
  );
  if (
    unassignedMoves.length > maximumBoardColumns ||
    unassignedMoves.some((move) => typeof move !== "string" || !seenOptions.has(move)) ||
    new Set(unassignedMoves).size !== unassignedMoves.length
  )
    fail("Unassigned cards move only to columns of the board, each once", unassignedLocation);
  const unassigned = Object.freeze({
    moves: Object.freeze(unassignedMoves as string[]),
    ...parseBoardBucket(
      {
        state: unassignedRecord.state,
        rowCount: unassignedRecord.rowCount,
        aggregates: unassignedRecord.aggregates,
        page: unassignedRecord.page,
      },
      declaredCardFields,
      seenRecordIds,
      unassignedLocation,
    ),
  });
  const readBuckets = [...columns, unassigned].filter((bucket) => bucket.state === "read");
  for (const bucket of readBuckets.slice(1))
    requireMatchingBoardMetrics(readBuckets[0]!.aggregates, bucket.aggregates, location);

  return Object.freeze({
    kind: "board",
    plan: Object.freeze({
      moduleRootId: moduleRootId.data,
      moduleReleaseVersion: moduleReleaseVersion.data,
      queryId: queryId.data,
    }),
    choiceFieldId: choiceFieldId.data,
    choiceFieldKey: choiceFieldKey.data,
    choiceFieldRequired: record.choiceFieldRequired as boolean,
    ...(wipLimit === undefined ? {} : { wipLimit }),
    quickAdd: record.quickAdd as boolean,
    cardTitleFieldId: cardTitleFieldId.data,
    cardFieldIds: Object.freeze(cardFieldIds),
    columns: Object.freeze(columns),
    unassigned,
  });
};
