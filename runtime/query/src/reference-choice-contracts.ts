import "server-only";

import { z } from "zod";
import {
  fieldIdSchema,
  organizationAccountIdSchema,
  publishedModuleQueryDescriptorV3Schema,
  recordIdSchema,
  recordTypeIdSchema,
  recordTypeReferenceSchema,
} from "@vortex/contracts";

const choiceSearchSchema = z.string().trim().min(1).max(100);
const choicePageSizeSchema = z.number().int().min(1).max(100).default(50);
const choiceContinuationTokenSchema = z.string().min(1).max(65_536);

/**
 * Choices for one record-reference input. The composing server resolves the
 * input's declared allowed record types and the published Module query that
 * lists its choices from the installed release; the organisation, Application
 * and viewer come only from the verified request. Rows are read through the
 * #572 protected Query, so only records the viewer may read are ever offered.
 */
export const recordReferenceChoiceCommandSchema = z
  .object({
    kind: z.literal("record_reference"),
    /** The reference input's declared allowed record types. */
    allowedRecordTypes: z.array(recordTypeReferenceSchema).min(1).max(20),
    /** The published Module query whose permitted rows are the choices. */
    source: publishedModuleQueryDescriptorV3Schema,
    /** A field the source query selects, shown as each choice's label. */
    labelFieldId: fieldIdSchema,
    /** Narrows each bounded page to choices whose label contains this text. */
    search: choiceSearchSchema.optional(),
    pageSize: choicePageSizeSchema,
    /** Opaque continuation issued by the previous page of the same source. */
    continuationToken: choiceContinuationTokenSchema.optional(),
  })
  .strict();
export type RecordReferenceChoiceCommand = z.infer<typeof recordReferenceChoiceCommandSchema>;

/**
 * Choices for one organisation-account reference input: active accounts in
 * the verified current organisation only. The command names no organisation.
 */
export const organizationAccountReferenceChoiceCommandSchema = z
  .object({
    kind: z.literal("organization_account_reference"),
    /** Narrows choices to accounts whose display name contains this text. */
    search: choiceSearchSchema.optional(),
    pageSize: choicePageSizeSchema,
    /** Opaque continuation issued by the previous page of the same search. */
    continuationToken: choiceContinuationTokenSchema.optional(),
  })
  .strict();
export type OrganizationAccountReferenceChoiceCommand = z.infer<
  typeof organizationAccountReferenceChoiceCommandSchema
>;

export const referenceChoiceCommandSchema = z.discriminatedUnion("kind", [
  recordReferenceChoiceCommandSchema,
  organizationAccountReferenceChoiceCommandSchema,
]);
export type ReferenceChoiceCommand = z.infer<typeof referenceChoiceCommandSchema>;

/** The typed value a choice submits, in the owning input type's exact format. */
export const referenceChoiceValueSchema = z.union([
  z.object({ recordTypeId: recordTypeIdSchema, recordId: recordIdSchema }).strict(),
  z.object({ organizationAccountId: organizationAccountIdSchema }).strict(),
]);
export type ReferenceChoiceValue = z.infer<typeof referenceChoiceValueSchema>;

/**
 * One permitted choice. `key` is the choice-input option key derived from the
 * referenced identity; `value` is what a selection of that key submits.
 */
export const referenceChoiceOptionSchema = z
  .object({
    key: z.string().regex(/^[ra]_[0-9a-f]{32}$/),
    label: z.string().min(1).max(200),
    value: referenceChoiceValueSchema,
  })
  .strict();
export type ReferenceChoiceOption = z.infer<typeof referenceChoiceOptionSchema>;

export const referenceChoiceRefusalReasonCodes = [
  "request_invalid",
  "source_invalid",
  "source_unavailable",
  "source_stale",
  "cursor_invalid",
  "cursor_stale",
] as const;
export type ReferenceChoiceRefusalReasonCode = (typeof referenceChoiceRefusalReasonCodes)[number];

/** Every refusal is this one neutral shape, decided before any choice is exposed. */
export const referenceChoiceRefusalSchema = z
  .object({
    outcome: z.literal("refused"),
    reasonCode: z.enum(referenceChoiceRefusalReasonCodes),
  })
  .strict();
export type ReferenceChoiceRefusal = z.infer<typeof referenceChoiceRefusalSchema>;

export const referenceChoicePageSchema = z
  .object({
    outcome: z.literal("completed"),
    kind: z.enum(["record_reference", "organization_account_reference"]),
    choices: z.array(referenceChoiceOptionSchema).max(100),
    /** Opaque; present only when a later page may hold further permitted choices. */
    nextContinuationToken: z.string().optional(),
  })
  .strict();
export type ReferenceChoicePage = z.infer<typeof referenceChoicePageSchema>;

export const referenceChoiceResultSchema = z.discriminatedUnion("outcome", [
  referenceChoicePageSchema,
  referenceChoiceRefusalSchema,
]);
export type ReferenceChoiceResult = z.infer<typeof referenceChoiceResultSchema>;
