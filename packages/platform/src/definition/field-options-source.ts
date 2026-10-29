import { z } from "zod";
import { builderKeySchema, fieldIdSchema, queryIdSchema } from "../catalogue/identifiers";
import { flowIdSchema } from "../catalogue/identifiers";

/** The fields of the same record type an options source reads, by input name. */
const optionsSourceInputsSchema = z
  .record(builderKeySchema, fieldIdSchema)
  .refine((inputs) => Object.keys(inputs).length <= 10, {
    message: "An options source reads at most 10 fields",
  });
const optionValueSchema = z.string().min(1).max(120);

/**
 * A choice field's own option list. When it is narrowed by a parent choice field of the same
 * record type, `optionParents` lists, for every option, the parent options it belongs to.
 */
export const fixedOptionsSourceSchema = z
  .object({
    kind: z.literal("fixed"),
    parentFieldId: fieldIdSchema.optional(),
    optionParents: z
      .record(optionValueSchema, z.array(optionValueSchema).min(1).max(200))
      .optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if ((source.parentFieldId === undefined) !== (source.optionParents === undefined))
      context.addIssue({
        code: "custom",
        path: ["optionParents"],
        message: "A narrowed option list names its parent field and each option's parent options",
      });
  });
/**
 * A link field's records: the target records the person may read, optionally narrowed to those
 * whose `filterFieldId` link points at the record chosen in this record type's `parentFieldId`
 * link, or a declared query over its declared inputs.
 */
export const queryOptionsSourceSchema = z
  .object({
    kind: z.literal("query"),
    queryId: queryIdSchema.optional(),
    inputs: optionsSourceInputsSchema.optional(),
    parentFieldId: fieldIdSchema.optional(),
    filterFieldId: fieldIdSchema.optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if ((source.parentFieldId === undefined) !== (source.filterFieldId === undefined))
      context.addIssue({
        code: "custom",
        path: ["filterFieldId"],
        message: "A narrowed record list names both its parent field and the target's filter field",
      });
    if ((source.queryId === undefined) !== (source.inputs === undefined))
      context.addIssue({
        code: "custom",
        path: ["inputs"],
        message: "A query options source names its query and the fields it reads",
      });
    if (source.queryId !== undefined && source.parentFieldId !== undefined)
      context.addIssue({
        code: "custom",
        path: ["parentFieldId"],
        message: "A query options source filters through its query, not a parent field",
      });
  });
/** Options worked out by an options flow over declared inputs: value, label and description. */
export const flowOptionsSourceSchema = z
  .object({ kind: z.literal("flow"), flowId: flowIdSchema, inputs: optionsSourceInputsSchema })
  .strict();
/**
 * Where a choice or link field's options come from (Studio flows design §2, decision D2): declared
 * on the field, so every writer (a page, an import, the API, an agent) is checked against it and a
 * page only presents it. A choice field has a fixed list or an options flow; a link field a record
 * query or an options flow.
 */
export const choiceOptionsSourceSchema = z.discriminatedUnion("kind", [
  fixedOptionsSourceSchema,
  flowOptionsSourceSchema,
]);
export const linkOptionsSourceSchema = z.discriminatedUnion("kind", [
  queryOptionsSourceSchema,
  flowOptionsSourceSchema,
]);
export type ChoiceOptionsSource = z.infer<typeof choiceOptionsSourceSchema>;
export type LinkOptionsSource = z.infer<typeof linkOptionsSourceSchema>;

/**
 * The field of the same record type that narrows a field's options, and for a link the target's
 * link field that must point at the parent's chosen record; undefined when nothing narrows them.
 */
export const optionsSourceNarrowing = (
  optionsSource: ChoiceOptionsSource | LinkOptionsSource,
): Readonly<{ parentFieldId: string; filterFieldId?: string }> | undefined =>
  optionsSource.kind === "fixed" && optionsSource.parentFieldId !== undefined
    ? { parentFieldId: optionsSource.parentFieldId }
    : optionsSource.kind === "query" &&
        optionsSource.parentFieldId !== undefined &&
        optionsSource.filterFieldId !== undefined
      ? { parentFieldId: optionsSource.parentFieldId, filterFieldId: optionsSource.filterFieldId }
      : undefined;

/** The parent options a narrowed choice option belongs to; undefined when nothing narrows it. */
export const optionParentValues = (
  optionsSource: ChoiceOptionsSource,
  optionValue: string,
): readonly string[] | undefined =>
  optionsSource.kind === "fixed" && Object.hasOwn(optionsSource.optionParents ?? {}, optionValue)
    ? optionsSource.optionParents![optionValue]
    : undefined;
