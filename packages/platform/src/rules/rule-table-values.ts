import { z } from "zod";
import { builderKeySchema } from "./identifiers";
import {
  moduleFieldValueV2Schemas,
  sourceModuleFieldValueV2Schemas,
  tableCellTypeKeysV2,
} from "./module-field-values-v2";

/** A data shape, not storage settings or permission to write a table field. */
export const ruleTableColumnSchema = z
  .object({
    key: builderKeySchema,
    type: z.enum(tableCellTypeKeysV2),
    required: z.boolean(),
  })
  .strict();
export type RuleTableColumn = z.infer<typeof ruleTableColumnSchema>;
export const maximumRuleTableRows = 1_000;

export const ruleTableColumnsMatch = (
  left: readonly RuleTableColumn[],
  right: readonly RuleTableColumn[],
): boolean => {
  const signature = (columns: readonly RuleTableColumn[]) =>
    JSON.stringify(
      [...columns]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map(({ key, type, required }) => [key, type, required]),
    );
  return signature(left) === signature(right);
};

export const sourceRuleTableColumnsSchema = z
  .array(ruleTableColumnSchema)
  .min(1)
  .max(40)
  .superRefine((columns, context) => {
    if (new Set(columns.map((column) => column.key)).size !== columns.length)
      context.addIssue({ code: "custom", message: "Table column keys must be unique" });
  });
export const ruleTableColumnsSchema = sourceRuleTableColumnsSchema.superRefine(
  (columns, context) => {
    if (columns.some((column, index) => index > 0 && columns[index - 1]!.key >= column.key))
      context.addIssue({ code: "custom", message: "Canonical table columns must use key order" });
  },
);

export const validateRuleTableDeclaration = (
  value: { type: string; columns?: readonly RuleTableColumn[] | undefined },
  context: z.RefinementCtx,
): void => {
  if ((value.type === "table") !== (value.columns !== undefined))
    context.addIssue({
      code: "custom",
      path: ["columns"],
      message: "Only table values require declared columns",
    });
};

/** Checks cell formats without importing or duplicating owning Record-field policy. */
export const validateRuleTableRows = (
  columns: readonly RuleTableColumn[],
  rows: readonly Record<string, unknown>[],
  context: z.RefinementCtx,
  source: boolean,
): void => {
  const codecs = source ? sourceModuleFieldValueV2Schemas : moduleFieldValueV2Schemas;
  const declared = new Map(columns.map((column) => [column.key, column]));
  for (const [index, row] of rows.entries()) {
    for (const key of Object.keys(row))
      if (!declared.has(key))
        context.addIssue({
          code: "custom",
          path: ["value", index, key],
          message: "Table column is not declared",
        });
    for (const column of columns) {
      const present = Object.prototype.hasOwnProperty.call(row, column.key);
      if (
        (!present && column.required) ||
        (present && !codecs[column.type].safeParse(row[column.key]).success)
      )
        context.addIssue({
          code: "custom",
          path: ["value", index, column.key],
          message: "Table cell must match its declared type and presence",
        });
    }
  }
};
