import { z } from "zod";
import {
  displayDetailFieldsSchema,
  displayFieldKeySchema,
  displayScalarCellSchema,
  displayTextSchema,
} from "./display-payload-parts";
import { pipelineStageToneSchema } from "../definition/record-type-pipelines";

/** One key fact in a record's header: its label and its display value. */
const recordHeaderFactSchema = z
  .object({ label: displayTextSchema, value: displayScalarCellSchema })
  .strict()
  .readonly();

/** One step of a record's stage strip: its option, its label, its colour role and where it sits. */
const recordStageStepSchema = z
  .object({
    value: displayTextSchema,
    label: displayTextSchema,
    tone: pipelineStageToneSchema,
    /** The record sits in this step now. */
    current: z.boolean(),
    /** The record may move to this step from the current one. */
    reachable: z.boolean(),
  })
  .strict()
  .readonly();

/** The stage strip of a record whose detail block names a pipeline field. */
const recordStageSchema = z
  .object({
    fieldLabel: displayTextSchema,
    steps: z.array(recordStageStepSchema).min(1).max(200).readonly(),
  })
  .strict()
  .readonly();

/** One card of a record page: its stable key, its heading and its labelled fields. */
const recordSectionSchema = z
  .object({
    key: displayTextSchema,
    title: displayTextSchema.exactOptional(),
    fields: displayDetailFieldsSchema,
  })
  .strict()
  .readonly();

/** One row of a related list: the record, its title and the declared columns it shows. */
const recordRelatedRowSchema = z
  .object({
    recordId: displayTextSchema,
    title: displayScalarCellSchema,
    fields: displayDetailFieldsSchema,
  })
  .strict()
  .readonly();

/** One related list card: what it lists and, when the block offers one, where a new record opens. */
const recordRelatedListSchema = z
  .object({
    key: displayTextSchema,
    title: displayTextSchema,
    rows: z.array(recordRelatedRowSchema).max(50).readonly(),
    /** A new related record opens this page with the parent already linked. */
    add: z
      .object({ pageKey: displayFieldKeySchema, parentFieldId: displayFieldKeySchema })
      .strict()
      .readonly()
      .exactOptional(),
  })
  .strict()
  .readonly();

/**
 * The ready values a record-detail block renders: the record's identity, its heading, its header
 * key facts, its declared stage strip, its sections in declared order and its related lists.
 */
export const recordDetailPayloadSchema = z
  .object({
    kind: z.literal("record_detail"),
    recordId: displayTextSchema,
    heading: displayScalarCellSchema.exactOptional(),
    headerFacts: z.array(recordHeaderFactSchema).max(4).readonly(),
    stage: recordStageSchema.exactOptional(),
    sections: z.array(recordSectionSchema).min(1).max(20).readonly(),
    relatedLists: z.array(recordRelatedListSchema).max(20).readonly(),
  })
  .strict()
  .readonly();
export type RecordDetailPayload = z.output<typeof recordDetailPayloadSchema>;
