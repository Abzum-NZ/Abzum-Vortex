import { z } from "zod";
import type { fieldTypeKeys } from "./catalogues";
import { safeHttpsUrlSchema } from "./common";
import {
  compareExactDecimals,
  exactDecimalDigitCounts,
  normalizeExactDecimal,
  parseExactDecimal,
  type ExactDecimal,
} from "./exact-decimal";
import {
  builderKeySchema,
  fileIdSchema,
  organizationAccountIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
} from "./identifiers";
import { sourceQualifiedRecordTypeSchema } from "./definition-source-common";
import { richTextBlockV2Schema, richTextInlineV2Schema, type RichTextInlineV2 } from "./rich-text";

const exactDecimalMessage = "Use exact base-10 text without exponent notation";
const normalizedExactDecimalMessage = "Use normalized exact base-10 text";

/** Authored exact text is preserved until compilation normalizes it. */
export const sourceExactDecimalTextV2Schema = z
  .string()
  .refine((value) => parseExactDecimal(value) !== undefined, exactDecimalMessage);

/** Canonical exact text has one representation for each base-10 value. */
export const exactDecimalTextV2Schema = sourceExactDecimalTextV2Schema.refine(
  (value) => normalizeExactDecimal(value) === value,
  normalizedExactDecimalMessage,
);

export const currencyCodeV2Schema = z
  .string()
  .regex(/^[A-Z]{3}$/, "Use an uppercase currency code");

export const sourceMoneyValueV2Schema = z
  .object({ amount: sourceExactDecimalTextV2Schema, currency: currencyCodeV2Schema })
  .strict();

export const moneyValueV2Schema = z
  .object({ amount: exactDecimalTextV2Schema, currency: currencyCodeV2Schema })
  .strict();

export const sourceRecordLinkValueV2Schema = z
  .object({ record_type: sourceQualifiedRecordTypeSchema, record_id: recordIdSchema })
  .strict();

export const recordLinkValueV2Schema = z
  .object({ recordTypeId: recordTypeIdSchema, recordId: recordIdSchema })
  .strict();

export const sourcePersonLinkValueV2Schema = z
  .object({ organization_account_id: organizationAccountIdSchema })
  .strict();

export const personLinkValueV2Schema = z
  .object({ organizationAccountId: organizationAccountIdSchema })
  .strict();

/** Attachment order is meaningful for both single-file and multiple-file fields. */
export const attachmentValueV2Schema = z.array(fileIdSchema);

const recordRichTextCellV2Schema = z
  .object({ children: z.array(richTextInlineV2Schema).min(1) })
  .strict();
const recordRichTextRowV2Schema = z
  .object({ cells: z.array(recordRichTextCellV2Schema).min(1) })
  .strict();
const recordRichTextTableBlockV2Schema = z
  .object({ kind: z.literal("table"), rows: z.array(recordRichTextRowV2Schema).min(1) })
  .strict();
const recordRichTextFileBlockV2Schema = z
  .object({ kind: z.literal("file"), fileId: fileIdSchema })
  .strict();

/** Record-only blocks extend, but never mutate, the neutral Page-safe grammar. */
export const recordRichTextBlockV2Schema = z.union([
  richTextBlockV2Schema,
  recordRichTextTableBlockV2Schema,
  recordRichTextFileBlockV2Schema,
]);

export const recordRichTextDocumentV2Schema = z
  .object({ blocks: z.array(recordRichTextBlockV2Schema) })
  .strict();

export type RecordRichTextDocumentV2 = z.infer<typeof recordRichTextDocumentV2Schema>;
export type FormattedTextAllowedBlockV2 =
  "paragraph" | "heading" | "list" | "table" | "link" | "attachment";

const inspectInlines = (
  inlines: readonly RichTextInlineV2[],
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

export const inspectRecordRichTextV2 = (
  document: RecordRichTextDocumentV2,
): { visibleTextLength: number; usedBlocks: ReadonlySet<FormattedTextAllowedBlockV2> } => {
  let visibleTextLength = 0;
  const usedBlocks = new Set<FormattedTextAllowedBlockV2>();
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

export const exactDecimalWithinBoundsV2 = (
  value: ExactDecimal,
  minimum?: ExactDecimal,
  maximum?: ExactDecimal,
): boolean =>
  (minimum === undefined || compareExactDecimals(value, minimum) >= 0) &&
  (maximum === undefined || compareExactDecimals(value, maximum) <= 0);

export const exactDecimalFitsDigitsV2 = (
  value: ExactDecimal,
  digitsBeforeDecimal: number,
  decimalPlaces: number,
): boolean => {
  const counts = exactDecimalDigitCounts(value);
  return counts.digitsBeforeDecimal <= digitsBeforeDecimal && counts.decimalPlaces <= decimalPlaces;
};

const wholeNumberValueV2Schema = z.number().int();
const dateValueV2Schema = z.iso.date();
const dateTimeValueV2Schema = z.iso.datetime({ offset: true });
const choiceValueV2Schema = z.string().min(1).max(120);
const severalChoicesValueV2Schema = z.array(choiceValueV2Schema);
const referenceNumberValueV2Schema = z.string();
const emailAddressValueV2Schema = z.email();
const phoneNumberValueV2Schema = z.string();
const webAddressValueV2Schema = safeHttpsUrlSchema;
const sourceTableCellValueV2Schema = z.union([
  z.string(),
  z.number().int(),
  z.boolean(),
  sourceExactDecimalTextV2Schema,
  sourceMoneyValueV2Schema,
]);
const tableCellValueV2Schema = z.union([
  z.string(),
  z.number().int(),
  z.boolean(),
  exactDecimalTextV2Schema,
  moneyValueV2Schema,
]);
const sourceTableValueV2Schema = z.array(z.record(builderKeySchema, sourceTableCellValueV2Schema));
const tableValueV2Schema = z.array(z.record(builderKeySchema, tableCellValueV2Schema));
const calculatedValueV2Schema = z.union([
  z.string(),
  wholeNumberValueV2Schema,
  exactDecimalTextV2Schema,
  moneyValueV2Schema,
  z.boolean(),
  dateValueV2Schema,
  dateTimeValueV2Schema,
]);

/** Leaf value contracts keyed by all twenty-two field types. */
export const sourceModuleFieldValueV2Schemas = {
  text: z.string(),
  long_text: z.string(),
  formatted_text: recordRichTextDocumentV2Schema,
  whole_number: wholeNumberValueV2Schema,
  decimal_number: sourceExactDecimalTextV2Schema,
  money: sourceMoneyValueV2Schema,
  yes_no: z.boolean(),
  date: dateValueV2Schema,
  date_time: dateTimeValueV2Schema,
  choice: choiceValueV2Schema,
  several_choices: severalChoicesValueV2Schema,
  reference_number: referenceNumberValueV2Schema,
  email_address: emailAddressValueV2Schema,
  phone_number: phoneNumberValueV2Schema,
  web_address: webAddressValueV2Schema,
  table: sourceTableValueV2Schema,
  link: sourceRecordLinkValueV2Schema,
  link_to_one_of_several: sourceRecordLinkValueV2Schema,
  link_to_person: sourcePersonLinkValueV2Schema,
  calculation: calculatedValueV2Schema,
  total: calculatedValueV2Schema,
  attachment: attachmentValueV2Schema,
} as const satisfies Record<(typeof fieldTypeKeys)[number], z.ZodType>;

export const moduleFieldValueV2Schemas = {
  ...sourceModuleFieldValueV2Schemas,
  decimal_number: exactDecimalTextV2Schema,
  money: moneyValueV2Schema,
  table: tableValueV2Schema,
  link: recordLinkValueV2Schema,
  link_to_one_of_several: recordLinkValueV2Schema,
  link_to_person: personLinkValueV2Schema,
} as const satisfies Record<(typeof fieldTypeKeys)[number], z.ZodType>;
