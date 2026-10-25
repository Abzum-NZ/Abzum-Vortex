import { z } from "zod";
import { recordsTableFeatureDefinitions } from "../definition/application-composition/records-table-features";

export {
  recordsTableFilterFieldsSchema,
  type RecordsTableFilterField,
} from "../definition/application-composition/records-table-features/column-filters";
export type {
  RecordsTableInlineEditor,
  RecordsTableInlineEditField,
} from "../definition/application-composition/records-table-features/inline-edit";
export {
  conditionalFormatStylesSchema,
  type ConditionalFormattingProjection,
  type ConditionalColumnFormatProjection,
} from "../definition/application-composition/records-table-features/conditional-formatting";

type ProjectedDefinition = Extract<
  (typeof recordsTableFeatureDefinitions)[number],
  { projectionSchema: z.ZodType }
>;
type ProjectionShape = {
  [Definition in ProjectedDefinition as Definition["property"]]: z.ZodOptional<
    Definition["projectionSchema"]
  >;
};

// Each definition contributes exactly its own property and strict schema. The mapped type
// preserves the correspondence that Object.fromEntries cannot express on its own.
const projectionShape = Object.fromEntries(
  recordsTableFeatureDefinitions.flatMap((definition) =>
    "projectionSchema" in definition
      ? [[definition.property, definition.projectionSchema.optional()]]
      : [],
  ),
) as ProjectionShape;

/** The one viewer projection wire contract, assembled from the feature definitions. */
export const recordsTableFeatureProjectionSchema = z
  .object(projectionShape)
  .strict()
  .readonly()
  .refine((features) => Object.keys(features).length > 0, {
    message: "Projected table features name no feature",
  });
export type RecordsTableFeatureProjection = z.output<typeof recordsTableFeatureProjectionSchema>;
