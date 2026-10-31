"use client";

import { useState, type ChangeEvent, type ReactElement } from "react";
import { typedFieldValueSchema } from "@vortex/platform/schema";
import { Field, FieldLabel } from "../components/field";
import { Textarea } from "../components/textarea";
import { setFieldChange } from "../flow-runtime/flow-cycle";
import {
  readControlSettings,
  resolveControlContext,
  type ControlRenderProps,
} from "./control-context";
import {
  describedBy,
  FieldLabelText,
  FieldMessages,
  inactiveNote,
  useFieldFeedback,
  useFieldIds,
  useSeededState,
  fieldFocusLost,
} from "./field-parts";
import { useFormFieldPublisher, useRequiredFormField } from "./form-context";
import type { RichTextInputPayload, TypedRichTextDocument } from "./projected-data";

export type RichTextInputProps = ControlRenderProps<RichTextInputPayload>;

type RichTextBlock = TypedRichTextDocument["blocks"][number];
type RichTextInline = Extract<RichTextBlock, { kind: "paragraph" }>["children"][number];

const inlineText = (inline: RichTextInline): string =>
  inline.kind === "text" ? inline.text : inline.children.map(inlineText).join("");

const blockText = (block: RichTextBlock): string => {
  if (block.kind === "paragraph" || block.kind === "heading")
    return block.children.map(inlineText).join("");
  return block.items.map((item) => item.map(inlineText).join("")).join("\n");
};

const documentText = (document: TypedRichTextDocument | null | undefined): string =>
  document === null || document === undefined ? "" : document.blocks.map(blockText).join("\n");

/** Edited plain text becomes one paragraph per non-blank line; blank text is no document. */
const toDocument = (text: string): TypedRichTextDocument | null => {
  const paragraphs = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return paragraphs.length === 0
    ? null
    : Object.freeze({
        blocks: paragraphs.map((line) => ({
          kind: "paragraph" as const,
          children: [{ kind: "text" as const, text: line }],
        })),
      });
};

/**
 * Structured rich text field. It renders the projected document's text and emits only its declared
 * `field_changed` event. Until the person edits the text it publishes the projected (or authored
 * default) document unchanged, so submitting never flattens existing headings, lists, emphasis or
 * links; an edit publishes a validated paragraph document. It never interprets markup as
 * executable content.
 */
export function RichTextInput(props: RichTextInputProps): ReactElement {
  const context = resolveControlContext<RichTextInputPayload>(props, [
    "field_changed",
    "field_focus_lost",
  ]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds(props.placementId);
  const fieldKey = settings.fieldKey();
  const publish = useFormFieldPublisher(fieldKey);
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const required = settings.boolean("required");
  const readOnly = settings.boolean("read_only");
  const draftFeedback = useFieldFeedback(fieldKey);
  const disabled =
    context.inactive || settings.boolean("disabled") || draftFeedback?.disabled === true;
  const projectedError = context.values?.error;
  const note = inactiveNote(context);

  const projected = context.values?.value;
  const authoredDefault = props.settings.default_value;
  const seeded: TypedRichTextDocument | null =
    projected !== undefined
      ? projected
      : authoredDefault?.kind === "rich_text"
        ? authoredDefault.value
        : null;
  const seededText = documentText(seeded);
  const seedKey = JSON.stringify(seeded);
  const [value, setValue] = useSeededState(seededText);
  const [written, setWritten] =
    useState<Readonly<{ seedKey: string; text: string; document: TypedRichTextDocument | null }>>();
  const typed =
    written?.seedKey === seedKey && written.text === value
      ? written.document
      : value === seededText
        ? seeded
        : toDocument(value);
  const validationError = useRequiredFormField(
    fieldKey,
    props.placementId,
    typed,
    { label, missing: required && !disabled && !readOnly && value.trim() === "" },
    {
      label,
      required,
      refusal:
        draftFeedback?.hidden === true
          ? "hidden"
          : disabled
            ? "disabled"
            : readOnly
              ? "read_only"
              : undefined,
      set: (next, cause) => {
        const parsed = typedFieldValueSchema.safeParse(next);
        if (!parsed.success) return "invalid_value";
        const candidate = parsed.data;
        if (
          candidate !== null &&
          (typeof candidate !== "object" || Array.isArray(candidate) || !("blocks" in candidate))
        )
          return "invalid_value";
        const document = candidate;
        const text = documentText(document);
        return {
          value: document,
          apply: () => {
            setWritten({ seedKey, text, document });
            setValue(text);
          },
          emit: () => context.events?.field_changed?.(setFieldChange(cause, fieldKey, document)),
        };
      },
    },
  );
  const error = projectedError ?? validationError;

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    if (disabled || readOnly) return;
    const next = event.target.value;
    setWritten(undefined);
    setValue(next);
    const document = next === seededText ? seeded : toDocument(next);
    publish(document);
    context.events?.field_changed?.({
      event: "field_changed",
      origin: "user",
      depth: 0,
      immediate: false,
      fieldKey,
      value: document,
    });
  };

  return (
    <Field
      onBlur={(event) => {
        if (!disabled && !readOnly)
          fieldFocusLost(event, context.events?.field_focus_lost, fieldKey, typed);
      }}
      data-vortex-control="rich-text-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
    >
      <FieldLabel htmlFor={ids.control}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      <Textarea
        id={ids.control}
        name={fieldKey}
        value={value}
        onChange={onChange}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        aria-invalid={error !== undefined}
        {...describedBy(ids, help, error, note, draftFeedback)}
      />
      <FieldMessages
        ids={ids}
        help={help}
        error={error}
        note={note}
        draftFeedback={draftFeedback}
      />
    </Field>
  );
}
