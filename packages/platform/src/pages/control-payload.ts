import { z } from "zod";
import { labelSchema } from "../catalogue/common";
import { builderKeySchema, groupIdSchema, timestampSchema } from "../catalogue/identifiers";
import {
  exactDecimalTextSchema,
  moduleFieldValueSchemas,
  sourceModuleFieldValueSchemas,
} from "../records/module-field-values";
import { richTextDocumentSchema } from "../records/rich-text";
import { referenceChoiceSelectionEvidenceMapSchema } from "../workflows/form-continuation-contracts";
import {
  flowFieldCorrectionSchema,
  flowRefusalFeedbackCodeSchema,
  flowRuleRefusalSchema,
} from "../workflows/flow-refusal-feedback";
import { isIsoCalendarDate } from "./display-payload-calendar";
import { displayTextSchema, refineUniqueKeys } from "./display-payload-parts";

/*
 * The ready values of every form and action control block, the state one control placement is in,
 * and the typed values a form's inputs collect. The page runtime builds them with these schemas'
 * input types and the controls parse them with the same schemas, so the two cannot drift apart.
 */

const fieldErrorSchema = displayTextSchema.exactOptional();

/** One declared choice option value. */
const choiceValueSchema = z.string().min(1).max(120);

/** A several-choice value: distinct declared option values, at most 200. */
const severalChoicesSchema = z
  .array(choiceValueSchema)
  .max(200)
  .readonly()
  .superRefine((values, context) =>
    refineUniqueKeys(values, (value) => value, context, "A several-choice value repeats an option"),
  );

/** A linked record as a form holds it: only its stable record type and record identity. */
export const typedRecordReferenceSchema = z
  .object({ recordTypeId: displayTextSchema, recordId: displayTextSchema })
  .strict()
  .readonly();
export type TypedRecordReference = z.output<typeof typedRecordReferenceSchema>;

export type TypedTableValue = z.output<typeof moduleFieldValueSchemas.table>;

/**
 * One typed form field value exactly as a control input emits or collects it. A several-choice
 * value is a bounded list of declared option values, a linked record contributes only its stable
 * identity, and a document is structured rich text.
 */
export const typedFieldValueSchema = z.union(
  [
    z.null(),
    z.string(),
    z.boolean(),
    z.number(),
    sourceModuleFieldValueSchemas.table.max(1000),
    severalChoicesSchema,
    richTextDocumentSchema,
    typedRecordReferenceSchema,
  ],
  {
    error:
      "A typed field value must be text, a number, a boolean, table rows, several-choice option values, a record reference or a document",
  },
);
export type TypedFieldValue = z.output<typeof typedFieldValueSchema>;

/** One choice option available in a choice input. */
export const choiceOptionSchema = z
  .object({ key: choiceValueSchema, label: displayTextSchema })
  .strict()
  .readonly();
export type ChoiceOption = z.output<typeof choiceOptionSchema>;

/** Bounded choice options, each value once so every option has one identity. */
export const choiceOptionsSchema = z
  .array(choiceOptionSchema)
  .max(200)
  .readonly()
  .superRefine((options, context) =>
    refineUniqueKeys(options, (option) => option.key, context, "A choice option value repeats"),
  );

/** One page of pickable records a link input offers, in the order the server read them. */
export const recordChoicePageSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            recordTypeId: displayTextSchema,
            recordId: displayTextSchema,
            title: displayTextSchema,
            typeLabel: displayTextSchema,
          })
          .strict()
          .readonly(),
      )
      .max(4_000)
      .readonly(),
    nextContinuationToken: displayTextSchema.exactOptional(),
  })
  .strict()
  .readonly();
export type RecordChoicePage = z.output<typeof recordChoicePageSchema>;
export type RecordChoiceOption = RecordChoicePage["choices"][number];

/** The ready values a text input accepts. */
export const textInputPayloadSchema = z
  .object({
    kind: z.literal("text_input"),
    value: z.string().exactOptional(),
    error: fieldErrorSchema,
  })
  .strict()
  .readonly();
export type TextInputPayload = z.output<typeof textInputPayloadSchema>;

/**
 * The ready values a link input accepts: a stable record reference and the title the viewer may
 * read of it, never the record's other values. The title is present exactly with a linked record.
 */
export const linkInputPayloadSchema = z
  .object({
    kind: z.literal("link_input"),
    value: typedRecordReferenceSchema.nullable().exactOptional(),
    title: displayTextSchema.exactOptional(),
    error: fieldErrorSchema,
  })
  .strict()
  .readonly()
  .refine(
    (payload) =>
      (payload.value !== undefined && payload.value !== null) === (payload.title !== undefined),
    "A linked record carries its title, and only a linked record does",
  );
export type LinkInputPayload = z.output<typeof linkInputPayloadSchema>;

/** The ready values a structured rich-text input accepts. */
export const richTextInputPayloadSchema = z
  .object({
    kind: z.literal("rich_text_input"),
    value: richTextDocumentSchema.nullable().exactOptional(),
    error: fieldErrorSchema,
  })
  .strict()
  .readonly();
export type RichTextInputPayload = z.output<typeof richTextInputPayloadSchema>;

/** The ready values a number input accepts: exact decimal text, a finite number or null. */
export const numberInputPayloadSchema = z
  .object({
    kind: z.literal("number_input"),
    value: z.union([z.number(), exactDecimalTextSchema]).nullable().exactOptional(),
    error: fieldErrorSchema,
  })
  .strict()
  .readonly();
export type NumberInputPayload = z.output<typeof numberInputPayloadSchema>;

/** The ready values a boolean input accepts. */
export const booleanInputPayloadSchema = z
  .object({
    kind: z.literal("boolean_input"),
    value: z.boolean().exactOptional(),
    error: fieldErrorSchema,
  })
  .strict()
  .readonly();
export type BooleanInputPayload = z.output<typeof booleanInputPayloadSchema>;

/** The ready values a date input accepts: an ISO calendar date or null. */
export const dateInputPayloadSchema = z
  .object({
    kind: z.literal("date_input"),
    value: z
      .string()
      .refine(isIsoCalendarDate, "A date value must be an ISO calendar date")
      .nullable()
      .exactOptional(),
    error: fieldErrorSchema,
  })
  .strict()
  .readonly();
export type DateInputPayload = z.output<typeof dateInputPayloadSchema>;

/** An IANA time zone this runtime knows. */
const timeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "A date-time zone must be a valid IANA time zone");

/** The ready values a time-zone-aware date-time input accepts: an offset-bearing instant. */
export const dateTimeInputPayloadSchema = z
  .object({
    kind: z.literal("date_time_input"),
    value: timestampSchema.nullable().exactOptional(),
    personTimeZone: timeZoneSchema.exactOptional(),
    organizationTimeZone: timeZoneSchema.exactOptional(),
    error: fieldErrorSchema,
  })
  .strict()
  .readonly();
export type DateTimeInputPayload = z.output<typeof dateTimeInputPayloadSchema>;

/**
 * The ready values a choice input accepts. Option evidence maps exactly the projected options to
 * their Query page evidence, and a chosen value is one of the projected options.
 */
export const choiceInputPayloadSchema = z
  .object({
    kind: z.literal("choice_input"),
    value: choiceValueSchema.nullable().exactOptional(),
    options: choiceOptionsSchema.exactOptional(),
    optionEvidence: referenceChoiceSelectionEvidenceMapSchema.exactOptional(),
    nextContinuationToken: displayTextSchema.exactOptional(),
    error: fieldErrorSchema,
  })
  .strict()
  .readonly()
  .superRefine((payload, context) => {
    const options = payload.options;
    if (payload.optionEvidence !== undefined) {
      const evidenceKeys = Object.keys(payload.optionEvidence);
      if (
        options === undefined ||
        options.some((option) => !Object.hasOwn(payload.optionEvidence!, option.key)) ||
        evidenceKeys.some((key) => !options.some((option) => option.key === key))
      )
        context.addIssue({
          code: "custom",
          path: ["optionEvidence"],
          message: "Choice option evidence must match the projected options exactly",
        });
    }
    if (
      typeof payload.value === "string" &&
      options !== undefined &&
      !options.some((option) => option.key === payload.value)
    )
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "A choice value is not a projected option",
      });
  });
export type ChoiceInputPayload = z.output<typeof choiceInputPayloadSchema>;

/** The ready values a multi-choice input accepts. */
export const severalChoicesInputPayloadSchema = z
  .object({
    kind: z.literal("several_choices_input"),
    value: severalChoicesSchema.nullable().exactOptional(),
    error: fieldErrorSchema,
  })
  .strict()
  .readonly();
export type SeveralChoicesInputPayload = z.output<typeof severalChoicesInputPayloadSchema>;

/** The ready values a table input accepts: its typed rows, at most a thousand. */
export const tableInputPayloadSchema = z
  .object({
    kind: z.literal("table_input"),
    value: moduleFieldValueSchemas.table.max(1000).nullable().exactOptional(),
    error: fieldErrorSchema,
  })
  .strict()
  .readonly();
export type TableInputPayload = z.output<typeof tableInputPayloadSchema>;

/** The ready values an attachment input accepts: the attached files and the upload address. */
export const attachmentInputPayloadSchema = z
  .object({
    kind: z.literal("attachment_input"),
    value: z.array(z.string()).readonly(),
    files: z
      .array(z.object({ fileId: displayTextSchema, name: displayTextSchema }).strict().readonly())
      .readonly(),
    uploadUrl: z
      .string()
      .refine(
        (address) => address.startsWith("/api/files/upload?"),
        "Attachment values are invalid",
      ),
    error: fieldErrorSchema,
  })
  .strict()
  .readonly();
export type AttachmentInputPayload = z.output<typeof attachmentInputPayloadSchema>;

/**
 * The ready values an automatic field input accepts: exactly the payload of the control its
 * referenced module field selected, so a projected value is validated as that control's own shape.
 */
export const fieldInputPayloadSchema = z.discriminatedUnion("kind", [
  attachmentInputPayloadSchema,
  tableInputPayloadSchema,
  textInputPayloadSchema,
  linkInputPayloadSchema,
  richTextInputPayloadSchema,
  numberInputPayloadSchema,
  booleanInputPayloadSchema,
  dateInputPayloadSchema,
  dateTimeInputPayloadSchema,
  choiceInputPayloadSchema,
  severalChoicesInputPayloadSchema,
]);
export type FieldInputPayload = z.output<typeof fieldInputPayloadSchema>;

/** The ready values a validation message block accepts. */
export const validationPayloadSchema = z
  .object({ kind: z.literal("validation"), errors: z.array(displayTextSchema).readonly() })
  .strict()
  .readonly();
export type ValidationPayload = z.output<typeof validationPayloadSchema>;

/** The ready values a button block accepts; a button carries no value of its own. */
export const buttonPayloadSchema = z
  .object({ kind: z.literal("button") })
  .strict()
  .readonly();
export type ButtonPayload = z.output<typeof buttonPayloadSchema>;

/** The ready values a tabs block accepts. */
export const tabsPayloadSchema = z
  .object({ kind: z.literal("tabs"), activeTab: builderKeySchema.exactOptional() })
  .strict()
  .readonly();
export type TabsPayload = z.output<typeof tabsPayloadSchema>;

/** The ready values a dialog block accepts. */
export const dialogPayloadSchema = z
  .object({ kind: z.literal("dialog"), open: z.boolean() })
  .strict()
  .readonly();
export type DialogPayload = z.output<typeof dialogPayloadSchema>;

/** The ready values a drawer block accepts. */
export const drawerPayloadSchema = z
  .object({ kind: z.literal("drawer"), open: z.boolean() })
  .strict()
  .readonly();
export type DrawerPayload = z.output<typeof drawerPayloadSchema>;

/** The ready values a form container accepts; a form's values come from its own fields. */
export const formPayloadSchema = z
  .object({
    kind: z.literal("form"),
    ownerGroups: z
      .array(
        z
          .object({ groupId: groupIdSchema, label: z.string().min(1) })
          .strict()
          .readonly(),
      )
      .readonly()
      .superRefine((groups, context) =>
        refineUniqueKeys(groups, (group) => group.groupId, context, "An owner Group is repeated"),
      )
      .exactOptional(),
  })
  .strict()
  .readonly();
export type FormPayload = z.output<typeof formPayloadSchema>;

/**
 * Explicit, data-safe state for one control placement. `loading` means the control's data or a
 * submission it started is pending, so it cannot be activated again; `disabled` carries an optional
 * safe reason; only `ready` carries values, which the block's own payload schema then reads.
 */
export const controlDataStateSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("loading") })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("disabled"), reason: displayTextSchema.exactOptional() })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("ready"), values: z.unknown() })
    .strict()
    .readonly(),
]);

/**
 * Located requirement messages, form-level warnings and an optional refusal for one exact draft.
 * Every entry is already located on the form's own declared field key by the supplying projection.
 */
export const formDraftFeedbackSchema = z
  .object({
    /** Exact draft fingerprint this feedback was computed from. */
    fingerprint: displayTextSchema,
    fields: z
      .array(
        z
          .object({
            fieldKey: displayTextSchema,
            required: z.boolean(),
            disabled: z.boolean(),
            visible: z.boolean(),
          })
          .strict()
          .readonly(),
      )
      .readonly(),
    requirements: z
      .array(
        z.object({ fieldKey: displayTextSchema, message: displayTextSchema }).strict().readonly(),
      )
      .readonly(),
    warnings: z.array(displayTextSchema).readonly(),
    refusal: z
      .object({ message: displayTextSchema, fieldKey: displayTextSchema.exactOptional() })
      .strict()
      .readonly()
      .exactOptional(),
  })
  .strict()
  .readonly();
export type FormDraftFeedback = z.output<typeof formDraftFeedbackSchema>;
export type FormDraftFeedbackFieldState = FormDraftFeedback["fields"][number];

/**
 * One supplied draft-feedback result. `currentFingerprint` is the fingerprint of the draft the form
 * shows now; `values` are the typed draft values the projection used, keyed by the form's field key.
 */
export const formDraftFeedbackSupplySchema = z
  .object({
    currentFingerprint: displayTextSchema,
    values: z.record(z.string(), typedFieldValueSchema).readonly(),
    feedback: formDraftFeedbackSchema,
  })
  .strict()
  .readonly();
export type FormDraftFeedbackSupply = z.output<typeof formDraftFeedbackSupplySchema>;

/**
 * What a form shows after its flow ran: a message, or a refusal with its business code. Only an
 * invalid command may name a field, carry field corrections or carry the refusing rules' messages.
 */
export const formFlowFeedbackSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      tone: z.enum(["success", "problem"]),
      text: displayTextSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("refusal"),
      code: flowRefusalFeedbackCodeSchema,
      fieldLabel: labelSchema.exactOptional(),
      corrections: flowFieldCorrectionSchema.array().min(1).readonly().exactOptional(),
      /** The individually bounded authored messages of the rules that refused the change. */
      ruleMessages: flowRuleRefusalSchema.shape.message
        .array()
        .min(1)
        .max(100)
        .readonly()
        .exactOptional(),
      recovery: z.enum(["partial", "uncertain"]).exactOptional(),
    })
    .strict()
    .readonly()
    .refine(
      (feedback) =>
        feedback.code === "invalid_command" ||
        (feedback.fieldLabel === undefined &&
          feedback.corrections === undefined &&
          feedback.ruleMessages === undefined),
      "Only invalid command feedback may name a field, carry corrections or carry rule messages",
    ),
]);
export type FormFlowFeedback = z.output<typeof formFlowFeedbackSchema>;
