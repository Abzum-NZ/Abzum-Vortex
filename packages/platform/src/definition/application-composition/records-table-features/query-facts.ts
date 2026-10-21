import {
  recordsTableEditableFieldTypes,
  type RecordsTableFieldFacts,
  type RecordsTableQueryFacts,
} from "./shared";

/** Facts before capability decisions, with identities in the caller's source or compiled spelling. */
export type RecordsTableQueryFactsSource = Omit<
  RecordsTableQueryFacts,
  "fields" | "unselectedFields"
> &
  Readonly<{
    selectedFields: readonly string[];
    fields: readonly (Omit<RecordsTableFieldFacts, "editable"> &
      Readonly<{ linkTargetResolved: boolean }>)[];
  }>;

/** The one facts builder for Studio and publication; adapters only supply declared values. */
export const recordsTableQueryFacts = <
  Source extends Pick<
    RecordsTableQueryFactsSource,
    "selectedFields" | "fields" | "grouped" | "groupBy"
  >,
>(
  source: Source,
): Omit<Source, "fields" | "selectedFields"> &
  Pick<RecordsTableQueryFacts, "fields" | "unselectedFields"> => {
  const { selectedFields, fields, ...facts } = source;
  const selected = new Set(selectedFields.map((field) => field.toLowerCase()));
  const groupedBy = new Set(source.groupBy.map((field) => field.toLowerCase()));
  const offered = (field: string) =>
    selected.has(field.toLowerCase()) && (!source.grouped || groupedBy.has(field.toLowerCase()));
  return {
    ...facts,
    fields: fields
      .filter((field) => offered(field.field))
      .map(({ linkTargetResolved, ...field }) => ({
        ...field,
        editable:
          !source.grouped &&
          recordsTableEditableFieldTypes.includes(field.type) &&
          (field.type !== "link" || linkTargetResolved),
      })),
    unselectedFields: fields
      .filter((field) => !offered(field.field))
      .map(({ field, label }) => ({ field, label })),
  };
};
