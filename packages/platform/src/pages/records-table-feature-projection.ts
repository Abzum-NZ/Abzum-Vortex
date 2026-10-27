import { z } from "zod";
import { bulkActionsProjectionSchema } from "../definition/application-composition/records-table-features/projections/bulk-actions";
import { columnFiltersProjectionSchema } from "../definition/application-composition/records-table-features/projections/column-filters";
import { conditionalFormattingProjectionSchema } from "../definition/application-composition/records-table-features/projections/conditional-formatting";
import { exportProjectionSchema } from "../definition/application-composition/records-table-features/projections/export";
import { groupingProjectionSchema } from "../definition/application-composition/records-table-features/projections/grouping";
import { inlineEditProjectionSchema } from "../definition/application-composition/records-table-features/projections/inline-edit";
import { masterDetailProjectionSchema } from "../definition/application-composition/records-table-features/projections/master-detail";
import { pinningProjectionSchema } from "../definition/application-composition/records-table-features/projections/pinning";
import { pivotProjectionSchema } from "../definition/application-composition/records-table-features/projections/pivot";
import { rowActionsProjectionSchema } from "../definition/application-composition/records-table-features/projections/row-actions";
import { rowEditProjectionSchema } from "../definition/application-composition/records-table-features/projections/row-edit";
import { savedViewsProjectionSchema } from "../definition/application-composition/records-table-features/projections/saved-views";
import { searchProjectionSchema } from "../definition/application-composition/records-table-features/projections/search";
import { spreadsheetProjectionSchema } from "../definition/application-composition/records-table-features/projections/spreadsheet";
import { totalsProjectionSchema } from "../definition/application-composition/records-table-features/projections/totals";
import { treeProjectionSchema } from "../definition/application-composition/records-table-features/projections/tree";

export {
  recordsTableFilterFieldsSchema,
  type RecordsTableFilterField,
} from "../definition/application-composition/records-table-features/projections/column-filters";
export type {
  RecordsTableInlineEditor,
  RecordsTableInlineEditField,
} from "../definition/application-composition/records-table-features/projections/inline-edit";
export {
  conditionalFormatStylesSchema,
  type ConditionalFormattingProjection,
  type ConditionalColumnFormatProjection,
} from "../definition/application-composition/records-table-features/projections/conditional-formatting";

/**
 * The one viewer projection wire contract: each projected feature's strict schema under the
 * feature's property. The schemas live apart from the feature definitions, so a browser that reads
 * a table's settings never builds them.
 */
export const recordsTableFeatureProjectionSchema = z
  .object({
    bulkActions: bulkActionsProjectionSchema.optional(),
    columnFilters: columnFiltersProjectionSchema.optional(),
    conditionalFormatting: conditionalFormattingProjectionSchema.optional(),
    export: exportProjectionSchema.optional(),
    grouping: groupingProjectionSchema.optional(),
    inlineEdit: inlineEditProjectionSchema.optional(),
    masterDetail: masterDetailProjectionSchema.optional(),
    pinning: pinningProjectionSchema.optional(),
    pivot: pivotProjectionSchema.optional(),
    rowActions: rowActionsProjectionSchema.optional(),
    rowEdit: rowEditProjectionSchema.optional(),
    savedViews: savedViewsProjectionSchema.optional(),
    search: searchProjectionSchema.optional(),
    spreadsheet: spreadsheetProjectionSchema.optional(),
    totals: totalsProjectionSchema.optional(),
    tree: treeProjectionSchema.optional(),
  })
  .strict()
  .readonly()
  .refine((features) => Object.keys(features).length > 0, {
    message: "Projected table features name no feature",
  });
export type RecordsTableFeatureProjection = z.output<typeof recordsTableFeatureProjectionSchema>;
