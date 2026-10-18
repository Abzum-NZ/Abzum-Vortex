"use client";

import type { ComponentType, ReactElement } from "react";
import { fieldInputControlKeys, type FieldInputControlKey } from "@vortex/platform/schema";
import { DefinitionRenderError } from "../definition-error";
import type { ControlRenderProps } from "./control-context";
import type { FieldInputPayload } from "./projected-data";
import { AttachmentInput } from "./attachment-input";
import { TableInput } from "./table-input";
import { TextInput } from "./text-input";
import { LinkInput } from "./link-input";
import { RichTextInput } from "./rich-text-input";
import { NumberInput } from "./number-input";
import { BooleanInput } from "./boolean-input";
import { DateInput } from "./date-input";
import { DateTimeInput } from "./date-time-input";
import { ChoiceInput } from "./choice-input";
import { SeveralChoicesInput } from "./several-choices-input";

export type FieldInputProps = ControlRenderProps<FieldInputPayload>;

type FieldInputComponent = ComponentType<ControlRenderProps<FieldInputPayload>>;

/**
 * The one renderer for every automatic field input. The compiler derived its `control` from the
 * referenced module field type and validated the derived settings against that control's own
 * release, so this adapter delegates to the exact registered input control with the release
 * metadata in the server-projected release map. A placement without a derived control, or carrying
 * projected values of a different control's shape, is refused rather than rendered with an
 * invented one.
 */
const COMPONENTS: Readonly<Record<FieldInputControlKey, FieldInputComponent>> = Object.freeze({
  text: TextInput as unknown as FieldInputComponent,
  attachment: AttachmentInput as unknown as FieldInputComponent,
  table: TableInput as unknown as FieldInputComponent,
  rich_text: RichTextInput as unknown as FieldInputComponent,
  number: NumberInput as unknown as FieldInputComponent,
  boolean: BooleanInput as unknown as FieldInputComponent,
  date: DateInput as unknown as FieldInputComponent,
  date_time: DateTimeInput as unknown as FieldInputComponent,
  choice: ChoiceInput as unknown as FieldInputComponent,
  several_choices: SeveralChoicesInput as unknown as FieldInputComponent,
  link: LinkInput as unknown as FieldInputComponent,
});

/** The exact projected-value kind each derived control accepts, so a mismatch fails closed. */
const EXPECTED_PAYLOAD_KIND: Readonly<Record<FieldInputControlKey, FieldInputPayload["kind"]>> =
  Object.freeze({
    text: "text_input",
    table: "table_input",
    attachment: "attachment_input",
    rich_text: "rich_text_input",
    number: "number_input",
    boolean: "boolean_input",
    date: "date_input",
    date_time: "date_time_input",
    choice: "choice_input",
    several_choices: "several_choices_input",
    link: "link_input",
  });

export function FieldInput(props: FieldInputProps): ReactElement {
  const { settings, metadata, placementId, data } = props;
  const location = {
    placementId,
    blockId: metadata.blockId,
    releaseVersion: metadata.releaseVersion,
  };
  const control = settings["control"];
  if (
    control?.kind !== "choice" ||
    !(fieldInputControlKeys as readonly string[]).includes(control.value)
  )
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "An automatic field input requires its derived control",
      location,
    );
  const key = control.value as FieldInputControlKey;
  if (data?.status === "ready" && data.values.kind !== EXPECTED_PAYLOAD_KIND[key])
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `An automatic field input with control '${key}' cannot carry '${data.values.kind}' projected values`,
      location,
    );
  const Component = COMPONENTS[key];
  const release = props.fieldInputControlReleases[key];
  if (release === undefined)
    throw new DefinitionRenderError(
      "UNKNOWN_RELEASE",
      `Automatic field input control '${key}' is not present in the supplied catalogue`,
      location,
    );
  return <Component {...props} metadata={release} />;
}
