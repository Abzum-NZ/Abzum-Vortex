import { z } from "zod";
import type { fieldTypeKeys } from "../catalogue/catalogues";
import { safeHttpsUrlSchema } from "../catalogue/common";
import {
  compareExactDecimals,
  exactDecimalDigitCounts,
  parseExactDecimal,
  type ExactDecimal,
} from "./exact-decimal";
import {
  builderKeySchema,
  fileIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  sourceQualifiedRecordTypeSchema,
} from "../catalogue/identifiers";
import { richTextBlockSchema, richTextInlineSchema, type RichTextInline } from "./rich-text";
import {
  currencyCodePattern,
  isCanonicalExactDecimal,
  isMoneyValue,
  isRecordLinkValue,
} from "./value-predicates";

const exactDecimalMessage = "Use exact base-10 text without exponent notation";
const normalizedExactDecimalMessage = "Use normalized exact base-10 text";

/** Authored exact text is preserved until compilation normalizes it. */
export const sourceExactDecimalTextSchema = z
  .string()
  .refine((value) => parseExactDecimal(value) !== undefined, exactDecimalMessage);

/** Canonical exact text has one representation for each base-10 value. */
export const exactDecimalTextSchema = sourceExactDecimalTextSchema.refine(
  isCanonicalExactDecimal,
  normalizedExactDecimalMessage,
);

export const currencyCodeSchema = z
  .string()
  .regex(currencyCodePattern, "Use an uppercase currency code");

export const sourceMoneyValueSchema = z
  .object({ amount: sourceExactDecimalTextSchema, currency: currencyCodeSchema })
  .strict();

export const moneyValueSchema = z
  .object({ amount: exactDecimalTextSchema, currency: currencyCodeSchema })
  .strict()
  .refine(isMoneyValue);

export const sourceRecordLinkValueSchema = z
  .object({ record_type: sourceQualifiedRecordTypeSchema, record_id: recordIdSchema })
  .strict();

export const recordLinkValueSchema = z
  .object({ recordTypeId: recordTypeIdSchema, recordId: recordIdSchema })
  .strict()
  .refine(isRecordLinkValue);

/** Attachment order is meaningful for both single-file and multiple-file fields. */
export const attachmentValueSchema = z.array(fileIdSchema);

const recordRichTextCellSchema = z
  .object({ children: z.array(richTextInlineSchema).min(1) })
  .strict();
const recordRichTextRowSchema = z
  .object({ cells: z.array(recordRichTextCellSchema).min(1) })
  .strict();
const recordRichTextTableBlockSchema = z
  .object({ kind: z.literal("table"), rows: z.array(recordRichTextRowSchema).min(1) })
  .strict();
const recordRichTextFileBlockSchema = z
  .object({ kind: z.literal("file"), fileId: fileIdSchema })
  .strict();

/** Record-only blocks extend, but never mutate, the neutral Page-safe grammar. */
export const recordRichTextBlockSchema = z.union([
  richTextBlockSchema,
  recordRichTextTableBlockSchema,
  recordRichTextFileBlockSchema,
]);

export const recordRichTextDocumentSchema = z
  .object({ blocks: z.array(recordRichTextBlockSchema) })
  .strict();

export type RecordRichTextDocument = z.infer<typeof recordRichTextDocumentSchema>;
export type FormattedTextAllowedBlock =
  "paragraph" | "heading" | "list" | "table" | "link" | "attachment";

const inspectInlines = (
  inlines: readonly RichTextInline[],
): { visibleTextLength: number; containsLink: boolean } => {
  let visibleTextLength = 0;
  let containsLink = false;
  for (const inline of inlines) {
    if (inline.kind === "text") visibleTextLength += inline.text.length;
    else {
      const child = inspectInlines(inline.children);
      visibleTextLength += child.visibleTextLength;
      containsLink ||= inline.kind === "link" || child.containsLink;
    }
  }
  return { visibleTextLength, containsLink };
};

export const inspectRecordRichText = (
  document: RecordRichTextDocument,
): { visibleTextLength: number; usedBlocks: ReadonlySet<FormattedTextAllowedBlock> } => {
  let visibleTextLength = 0;
  const usedBlocks = new Set<FormattedTextAllowedBlock>();
  for (const block of document.blocks) {
    if (block.kind === "file") {
      usedBlocks.add("attachment");
      continue;
    }
    if (block.kind === "table") {
      usedBlocks.add("table");
      for (const row of block.rows)
        for (const cell of row.cells) {
          const inspected = inspectInlines(cell.children);
          visibleTextLength += inspected.visibleTextLength;
          if (inspected.containsLink) usedBlocks.add("link");
        }
      continue;
    }

    usedBlocks.add(
      block.kind === "bulleted_list" || block.kind === "numbered_list" ? "list" : block.kind,
    );
    const groups = "items" in block ? block.items : [block.children];
    for (const inlines of groups) {
      const inspected = inspectInlines(inlines);
      visibleTextLength += inspected.visibleTextLength;
      if (inspected.containsLink) usedBlocks.add("link");
    }
  }
  return { visibleTextLength, usedBlocks };
};

export const exactDecimalWithinBounds = (
  value: ExactDecimal,
  minimum?: ExactDecimal,
  maximum?: ExactDecimal,
): boolean =>
  (minimum === undefined || compareExactDecimals(value, minimum) >= 0) &&
  (maximum === undefined || compareExactDecimals(value, maximum) <= 0);

export const exactDecimalFitsDigits = (
  value: ExactDecimal,
  digitsBeforeDecimal: number,
  decimalPlaces: number,
): boolean => {
  const counts = exactDecimalDigitCounts(value);
  return counts.digitsBeforeDecimal <= digitsBeforeDecimal && counts.decimalPlaces <= decimalPlaces;
};

const wholeNumberValueSchema = z.number().int();
export const dateValueSchema = z.iso.date();
const dateTimeValueSchema = z.iso.datetime({ offset: true });
const choiceValueSchema = z.string().min(1).max(120);
const severalChoicesValueSchema = z.array(choiceValueSchema);
const referenceNumberValueSchema = z.string();
const emailAddressValueSchema = z.email();
const phoneNumberValueSchema = z.string();
const webAddressValueSchema = safeHttpsUrlSchema;
const sourceTableCellValueSchema = z.union([
  z.string(),
  z.number().int(),
  z.boolean(),
  sourceExactDecimalTextSchema,
  sourceMoneyValueSchema,
]);
const tableCellValueSchema = z.union([
  z.string(),
  z.number().int(),
  z.boolean(),
  exactDecimalTextSchema,
  moneyValueSchema,
]);
const sourceTableValueSchema = z.array(z.record(builderKeySchema, sourceTableCellValueSchema));
const tableValueSchema = z.array(z.record(builderKeySchema, tableCellValueSchema));
const calculatedValueSchema = z.union([
  z.string(),
  wholeNumberValueSchema,
  exactDecimalTextSchema,
  moneyValueSchema,
  z.boolean(),
  dateValueSchema,
  dateTimeValueSchema,
]);

/** Leaf value contracts keyed by all field types. */
export const sourceModuleFieldValueSchemas = {
  text: z.string(),
  long_text: z.string(),
  formatted_text: recordRichTextDocumentSchema,
  whole_number: wholeNumberValueSchema,
  decimal_number: sourceExactDecimalTextSchema,
  money: sourceMoneyValueSchema,
  yes_no: z.boolean(),
  date: dateValueSchema,
  date_time: dateTimeValueSchema,
  choice: choiceValueSchema,
  several_choices: severalChoicesValueSchema,
  reference_number: referenceNumberValueSchema,
  email_address: emailAddressValueSchema,
  phone_number: phoneNumberValueSchema,
  web_address: webAddressValueSchema,
  table: sourceTableValueSchema,
  link: sourceRecordLinkValueSchema,
  link_to_one_of_several: sourceRecordLinkValueSchema,
  calculation: calculatedValueSchema,
  total: calculatedValueSchema,
  attachment: attachmentValueSchema,
} as const satisfies Record<(typeof fieldTypeKeys)[number], z.ZodType>;

export const moduleFieldValueSchemas = {
  ...sourceModuleFieldValueSchemas,
  decimal_number: exactDecimalTextSchema,
  money: moneyValueSchema,
  table: tableValueSchema,
  link: recordLinkValueSchema,
  link_to_one_of_several: recordLinkValueSchema,
} as const satisfies Record<(typeof fieldTypeKeys)[number], z.ZodType>;

/** Cell types already supported by the  table field; values reuse the maps above. */
export const tableCellTypeKeys = [
  "text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "choice",
] as const;

/** The readable heading of a table column: its key in words, the same in the form and on display. */
export const tableColumnLabel = (key: string): string => key.replaceAll("_", " ");
