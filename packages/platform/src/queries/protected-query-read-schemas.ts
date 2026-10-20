import { z } from "zod";
import {
  fieldIdSchema,
  jsonValueSchema,
  recordIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
} from "../schema";
import {
  protectedQueryBoardColumnSchema,
  protectedQueryFieldBoundsSchema,
  protectedQueryPageRowSchema,
  protectedQueryRefusalReasonCodes,
  protectedQueryRowCapabilitiesSchema,
  protectedQueryTreeRowSchema,
} from "./protected-query-contracts";
import { recordSystemValuesSchema } from "./record-system-values";

/** The shapes the protected query adapter accepts back from the record read functions. */
const refusedSchema = z
  .object({ outcome: z.literal("refused"), reasonCode: z.enum(protectedQueryRefusalReasonCodes) })
  .strict();
export const inputsReadSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("resolved"),
      moduleReleaseRevision: revisionSchema,
      moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
      inputs: z.unknown(),
    })
    .strict(),
  refusedSchema,
]);
export const pageAnchorSchema = z
  .object({
    sortKey: z.array(z.string().nullable()).max(20),
    sort: z
      .array(
        z
          .object({
            fieldId: fieldIdSchema,
            direction: z.enum(["ascending", "descending"]),
            pushed: z.boolean(),
          })
          .strict(),
      )
      .max(20),
    phase: z.enum(["null", "value"]),
    recordId: recordIdSchema,
  })
  .strict();
const pageRowsSchema = z
  .array(
    z
      .object({
        recordId: recordIdSchema,
        revision: revisionSchema,
        capabilities: protectedQueryRowCapabilitiesSchema,
        values: z.record(fieldIdSchema, jsonValueSchema),
        systemValues: recordSystemValuesSchema.optional(),
      })
      .strict(),
  )
  .max(200);
export const pageReadSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      moduleReleaseRevision: revisionSchema,
      moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
      rows: pageRowsSchema,
      next: pageAnchorSchema.nullable(),
      opposite: pageAnchorSchema.nullable(),
      fieldBounds: protectedQueryFieldBoundsSchema,
    })
    .strict(),
  refusedSchema,
]);
export const groupedMemberPageReadSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      moduleReleaseRevision: revisionSchema,
      moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
      groupByFieldIds: z.array(fieldIdSchema).min(1).max(10),
      groupValues: z.record(fieldIdSchema, jsonValueSchema),
      rows: z.array(protectedQueryPageRowSchema).max(200),
      next: pageAnchorSchema.nullable(),
      opposite: pageAnchorSchema.nullable(),
    })
    .strict(),
  refusedSchema,
]);

export const treeLevelPageReadSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      moduleReleaseRevision: revisionSchema,
      moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
      rows: z.array(protectedQueryTreeRowSchema).max(200),
      next: pageAnchorSchema.nullable(),
      opposite: pageAnchorSchema.nullable(),
      fieldBounds: protectedQueryFieldBoundsSchema,
    })
    .strict(),
  refusedSchema,
]);

/** Every displayed board column's first member page, read in one call. */
export const boardColumnPagesReadSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      moduleReleaseRevision: revisionSchema,
      moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
      columns: z
        .array(
          z
            .object({
              column: protectedQueryBoardColumnSchema,
              rows: pageRowsSchema,
              next: pageAnchorSchema.nullable(),
            })
            .strict(),
        )
        .min(1)
        .max(13),
      fieldBounds: protectedQueryFieldBoundsSchema,
    })
    .strict(),
  refusedSchema,
]);
