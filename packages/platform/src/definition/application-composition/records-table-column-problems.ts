import { definitionValidationErrorCatalogue } from "../../catalogue/validation-errors";
import type { ComponentSettingValue } from "./block-property-schema";
import { settingField, settingGroup } from "./records-table-features/shared";

/** A column refusal: its catalogue code and that entry's business sentence. */
type RecordsTableColumnProblem = Readonly<{
  code: "definition_records_table_visible_columns" | "definition_records_table_auto_size";
  reason: string;
}>;

/**
 * The column settings every grid must satisfy, judged the same way in Studio and publication
 * before a complete table contract can be read.
 */
export const recordsTableColumnProblems = (
  value: ComponentSettingValue | undefined,
): readonly RecordsTableColumnProblem[] => {
  if (value?.kind !== "list") return [];
  const columns = value.items.map((item) => settingGroup(item));
  const problems: RecordsTableColumnProblem[] = [];
  if (!columns.some((column) => column?.["visible"]?.kind === "boolean" && column["visible"].value))
    problems.push({
      code: "definition_records_table_visible_columns",
      reason: definitionValidationErrorCatalogue.definition_records_table_visible_columns.message,
    });
  // Auto-size measures a column's values on screen, so it needs the field the column shows.
  if (
    columns.some(
      (column) =>
        column?.["auto_size"]?.kind === "boolean" &&
        column["auto_size"].value &&
        settingField(column["field"]) === undefined,
    )
  )
    problems.push({
      code: "definition_records_table_auto_size",
      reason: definitionValidationErrorCatalogue.definition_records_table_auto_size.message,
    });
  return problems;
};
