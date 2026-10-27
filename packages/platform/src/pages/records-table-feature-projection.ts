import { z } from "zod";
import { recordsTableFeatureDefinitions } from "../definition/application-composition/records-table-features";
import { bulkActionsProjection } from "../definition/application-composition/records-table-features/projections/bulk-actions";
import { columnFiltersProjection } from "../definition/application-composition/records-table-features/projections/column-filters";
import { conditionalFormattingProjection } from "../definition/application-composition/records-table-features/projections/conditional-formatting";
import { exportProjection } from "../definition/application-composition/records-table-features/projections/export";
import { groupingProjection } from "../definition/application-composition/records-table-features/projections/grouping";
import { inlineEditProjection } from "../definition/application-composition/records-table-features/projections/inline-edit";
import { masterDetailProjection } from "../definition/application-composition/records-table-features/projections/master-detail";
import { pinningProjection } from "../definition/application-composition/records-table-features/projections/pinning";
import { pivotProjection } from "../definition/application-composition/records-table-features/projections/pivot";
import { rowActionsProjection } from "../definition/application-composition/records-table-features/projections/row-actions";
import { rowEditProjection } from "../definition/application-composition/records-table-features/projections/row-edit";
import { savedViewsProjection } from "../definition/application-composition/records-table-features/projections/saved-views";
import { searchProjection } from "../definition/application-composition/records-table-features/projections/search";
import { spreadsheetProjection } from "../definition/application-composition/records-table-features/projections/spreadsheet";
import { totalsProjection } from "../definition/application-composition/records-table-features/projections/totals";
import { treeProjection } from "../definition/application-composition/records-table-features/projections/tree";

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

/** Every feature's viewer projection, each named by its own definition's property. */
const projections = [
  bulkActionsProjection,
  columnFiltersProjection,
  conditionalFormattingProjection,
  exportProjection,
  groupingProjection,
  inlineEditProjection,
  masterDetailProjection,
  pinningProjection,
  pivotProjection,
  rowActionsProjection,
  rowEditProjection,
  savedViewsProjection,
  searchProjection,
  spreadsheetProjection,
  totalsProjection,
  treeProjection,
] as const;

// The definitions decide which features project: exactly those with a `project` step have a
// projection schema here, so a feature added without its schema fails when this module loads.
const projectingProperties = new Set<string>(
  recordsTableFeatureDefinitions.flatMap((definition) =>
    "project" in definition && definition.project !== undefined ? [definition.property] : [],
  ),
);
if (
  projections.length !== projectingProperties.size ||
  projections.some((projection) => !projectingProperties.has(projection.property))
)
  throw new Error("RECORDS_TABLE_FEATURE_PROJECTIONS_INCOMPLETE");

type Projection = (typeof projections)[number];
type ProjectionShape = {
  [Entry in Projection as Entry["property"]]: z.ZodOptional<Entry["schema"]>;
};

// The mapped type keeps each property's own schema, which Object.fromEntries cannot express.
const projectionShape = Object.fromEntries(
  projections.map((projection) => [projection.property, projection.schema.optional()]),
) as ProjectionShape;

/** The one viewer projection wire contract, assembled from the feature projections. */
export const recordsTableFeatureProjectionSchema = z
  .object(projectionShape)
  .strict()
  .readonly()
  .refine((features) => Object.keys(features).length > 0, {
    message: "Projected table features name no feature",
  });
export type RecordsTableFeatureProjection = z.output<typeof recordsTableFeatureProjectionSchema>;
