"use client";

import type { ChangeEvent, ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { readControlSettings, resolveControlContext } from "./control-context";
import {
  describedBy,
  FieldLabelText,
  FieldMessages,
  inactiveNote,
  useFieldFeedback,
  useFieldIds,
  useSeededState,
} from "./field-parts";
import { useFormField } from "./form-context";
import type { TypedRichTextDocument } from "./projected-data";

export type RichTextInputProps = PlatformBlockRenderProps;

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
  const context = resolveControlContext(props, "rich_text_input", ["field_changed"]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const required = settings.boolean("required");
  const readOnly = settings.boolean("read_only");
  const draftFeedback = useFieldFeedback(fieldKey);
  const disabled =
    context.inactive || settings.boolean("disabled") || draftFeedback?.disabled === true;
  const error = context.values?.error;
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
  const [value, setValue] = useSeededState(seededText);
  useFormField(fieldKey, props.placementId, value === seededText ? seeded : toDocument(value));

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    if (disabled || readOnly) return;
    const next = event.target.value;
    setValue(next);
    context.events?.field_changed?.({
      event: "field_changed",
      fieldKey,
      value: next === seededText ? seeded : toDocument(next),
    });
  };

  return (
    <div
      data-vortex-control="rich-text-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
      className="vortex-field"
    >
      <label htmlFor={ids.control} className="vortex-field-label">
        <FieldLabelText label={label} required={required} />
      </label>
      <textarea
        id={ids.control}
        name={fieldKey}
        value={value}
        onChange={onChange}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        aria-invalid={error !== undefined}
        {...describedBy(ids, help, error, note, draftFeedback)}
        className="vortex-textarea"
      />
      <FieldMessages
        ids={ids}
        help={help}
        error={error}
        note={note}
        draftFeedback={draftFeedback}
      />
    </div>
  );
}
