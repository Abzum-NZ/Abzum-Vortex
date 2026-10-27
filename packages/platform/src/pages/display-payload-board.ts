import { z } from "zod";
import {
  builderKeySchema,
  fieldIdSchema,
  moduleRootIdSchema,
  queryIdSchema,
  recordIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
} from "../catalogue/identifiers";
import { recordsTableFilterFieldsSchema } from "../definition/application-composition/records-table-features/projections/column-filters";
import { conditionalFormatStylesSchema } from "../definition/application-composition/records-table-features/projections/conditional-formatting";
import { pipelineStageToneSchema } from "../definition/record-type-pipelines";
import { displayFieldsSchema, displayTextSchema, refineUniqueKeys } from "./display-payload-parts";
import { displayRowCapabilitiesSchema } from "./display-payload-rows";
import { displaySummaryMetricsSchema } from "./display-payload-summary";
import { displayTableFiltersSchema } from "./display-payload-table";

/*
 * The ready values a Data grid in Board mode renders: its protected columns in pipeline stage
 * order, each with its colour role, the stages a card in it may move to, the action that owns it
 * and whether a new record may start in it, and the unassigned bucket. The server validates the
 * board with these schemas where it builds it; the browser checks its envelope and renders it.
 */

const maximumBoardRows = 100_000;
const maximumBoardColumns = 12;
const maximumBoardPageSize = 200;
const maximumBoardLabelLength = 60;

const boundedLabelSchema = displayTextSchema.pipe(z.string().max(maximumBoardLabelLength));

/** One card: its record, the revision a move sends, what the viewer may do and its fields. */
const boardCardSchema = z
  .object({
    recordId: recordIdSchema,
    revision: revisionSchema,
    capabilities: displayRowCapabilitiesSchema,
    /** Only currently readable declared card fields are present, each with its safe label. */
    fields: displayFieldsSchema.superRefine((fields, context) =>
      fields.forEach((field, index) => {
        if (field.label.length > maximumBoardLabelLength)
          context.addIssue({
            code: "custom",
            path: [index, "label"],
            message: "A board card field label exceeds its bound",
          });
        if (field.value.kind === "text" && field.value.text.length > 1_000_000)
          context.addIssue({
            code: "custom",
            path: [index, "value"],
            message: "A board card text value exceeds its field contract bound",
          });
      }),
    ),
    /** The key of the Formatting rule that styles the whole card, decided by the server. */
    format: z.object({ row: displayTextSchema }).strict().readonly().exactOptional(),
  })
  .strict()
  .readonly();

/** One fetched page of cards in a protected board bucket. */
const boardPageSchema = z
  .object({
    rows: z.array(boardCardSchema).max(maximumBoardPageSize).readonly(),
    nextContinuationToken: displayTextSchema.pipe(z.string().max(65_536)).exactOptional(),
  })
  .strict()
  .readonly();
export type BoardPage = z.output<typeof boardPageSchema>;

/** A bucket not read yet, or being read: no counts, totals or cards. */
const unreadBucketShape = (state: "unread" | "reading") => ({
  state: z.literal(state),
  rowCount: z.null(),
  aggregates: z.tuple([]).readonly(),
  page: z.null(),
});

/** A read bucket: its exact current protected count, its totals and a bounded page of cards. */
const readBucketShape = {
  state: z.literal("read"),
  rowCount: z.number().int().min(0).max(maximumBoardRows),
  aggregates: displaySummaryMetricsSchema
    .refine((metrics) => metrics.length <= 20, "A board displays at most twenty aggregates")
    .refine(
      (metrics) => metrics.every((metric) => metric.label.length <= maximumBoardLabelLength),
      "A board aggregate label exceeds its bound",
    ),
  page: boardPageSchema,
};

/** A bucket in each of its read states, with the parts that describe where it sits. */
const boardBucketSchema = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.discriminatedUnion("state", [
    z
      .object({ ...shape, ...unreadBucketShape("unread") })
      .strict()
      .readonly(),
    z
      .object({ ...shape, ...unreadBucketShape("reading") })
      .strict()
      .readonly(),
    z
      .object({ ...shape, ...readBucketShape })
      .strict()
      .readonly(),
  ]);

/**
 * One installed choice column in its pipeline's stage order: its colour role from the theme, the
 * stages a card in it may move to, the named action that owns it, if one does, and whether a new
 * record may start in it.
 */
const boardColumnSchema = boardBucketSchema({
  value: z.string().min(1).max(120),
  label: boundedLabelSchema,
  tone: pipelineStageToneSchema,
  moves: z
    .array(z.string())
    .max(maximumBoardColumns - 1)
    .readonly(),
  gatedBy: boundedLabelSchema.exactOptional(),
  /** A new record may start in this stage, so quick add offers it. */
  addable: z.boolean(),
}).superRefine((column, context) => {
  if (column.addable && column.gatedBy !== undefined)
    context.addIssue({
      code: "custom",
      path: ["addable"],
      message: "A new record never starts in a column an action owns",
    });
  if (column.moves.includes(column.value) || new Set(column.moves).size !== column.moves.length)
    context.addIssue({
      code: "custom",
      path: ["moves"],
      message: "A board column moves to other columns, each once",
    });
});
export type BoardColumnPayload = z.output<typeof boardColumnSchema>;

/** Cards with no stage yet, and the stages they may move to: the start stage and its moves. */
const boardUnassignedSchema = boardBucketSchema({
  moves: z.array(z.string()).max(maximumBoardColumns).readonly(),
});
export type BoardBucketPayload = z.output<typeof boardUnassignedSchema>;

/** The ready values a Data grid in Board mode renders. */
export const boardPayloadSchema = z
  .object({
    kind: z.literal("board"),
    plan: z
      .object({
        moduleRootId: moduleRootIdSchema,
        moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
        queryId: queryIdSchema,
      })
      .strict()
      .readonly(),
    choiceFieldId: fieldIdSchema,
    /** The key a card move names the choice field by when it asks for the record to be saved. */
    choiceFieldKey: builderKeySchema,
    choiceFieldRequired: z.boolean(),
    /** The cards a column should not exceed; a column holding more warns. */
    wipLimit: z.number().int().min(1).max(1_000).exactOptional(),
    /** Each stage column offers adding a card there. */
    quickAdd: z.boolean(),
    /**
     * The fields people may filter the cards by and the filters this read applied; absent when the
     * board offers no filters. The board shows them and reports changes; the server narrows.
     */
    filters: z
      .object({
        fields: recordsTableFilterFieldsSchema.readonly(),
        applied: displayTableFiltersSchema,
      })
      .strict()
      .readonly()
      .refine(
        (filters) =>
          filters.applied.every((filter) =>
            filters.fields.some(
              (field) => field.fieldId.toLowerCase() === filter.fieldId.toLowerCase(),
            ),
          ),
        "A board applies only filters it offers",
      )
      .exactOptional(),
    /** The styles cards name through `format`; absent when the board has no Formatting. */
    formatting: z
      .object({ styles: conditionalFormatStylesSchema })
      .strict()
      .readonly()
      .exactOptional(),
    cardTitleFieldId: fieldIdSchema,
    /** The only field identities a card may carry; readable values and labels may be omitted. */
    cardFieldIds: z.array(fieldIdSchema).min(1).max(4).readonly(),
    columns: z.array(boardColumnSchema).min(1).max(maximumBoardColumns).readonly(),
    unassigned: boardUnassignedSchema,
  })
  .strict()
  .readonly()
  .superRefine((board, context) => {
    const issue = (message: string, path: readonly PropertyKey[] = []) =>
      context.addIssue({ code: "custom", path: [...path], message });
    const declaredCardFields = new Set(board.cardFieldIds.map((fieldId) => fieldId.toLowerCase()));
    if (
      declaredCardFields.size !== board.cardFieldIds.length ||
      board.cardFieldIds[0]?.toLowerCase() !== board.cardTitleFieldId.toLowerCase()
    )
      issue("Board card field identities are unique and start with the card title", [
        "cardFieldIds",
      ]);
    refineUniqueKeys(
      board.columns,
      (column) => column.value,
      context,
      "Board option values are unique",
      ["columns"],
    );
    const options = new Set(board.columns.map((column) => column.value));
    board.columns.forEach((column, index) => {
      if (column.moves.some((move) => !options.has(move)))
        issue("A board column moves only to columns of the board", ["columns", index, "moves"]);
    });
    if (
      board.unassigned.moves.some((move) => !options.has(move)) ||
      new Set(board.unassigned.moves).size !== board.unassigned.moves.length
    )
      issue("Unassigned cards move only to columns of the board, each once", [
        "unassigned",
        "moves",
      ]);
    const buckets = [...board.columns, board.unassigned];
    const seenRecordIds = new Set<string>();
    for (const bucket of buckets)
      for (const row of bucket.page?.rows ?? []) {
        const recordId = row.recordId.toLowerCase();
        if (seenRecordIds.has(recordId))
          issue("A record identity appears in at most one fetched board bucket");
        seenRecordIds.add(recordId);
        if (row.fields.some((field) => !declaredCardFields.has(field.key.toLowerCase())))
          issue("A board card contains a field outside its declared card projection");
        if (new Set(row.fields.map((field) => field.key.toLowerCase())).size !== row.fields.length)
          issue("A board card field appears once");
        if (row.format !== undefined && board.formatting?.styles[row.format.row] === undefined)
          issue("A board card names a style the board does not carry");
      }
    const readBuckets = buckets.filter((bucket) => bucket.state === "read");
    const expected = readBuckets[0]?.aggregates.map((metric) => metric.key) ?? [];
    for (const bucket of readBuckets.slice(1))
      if (
        bucket.aggregates.length !== expected.length ||
        bucket.aggregates.some((metric, index) => metric.key !== expected[index])
      )
        issue("Every board bucket carries the same declared aggregate aliases in order");
  });
export type BoardPayload = z.output<typeof boardPayloadSchema>;
