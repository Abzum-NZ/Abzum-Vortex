"use client";

import type { ComponentType, ReactElement } from "react";
import {
  BOOLEAN_INPUT_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  DATE_INPUT_BLOCK_RELEASE,
  LINK_INPUT_BLOCK_RELEASE,
  NUMBER_INPUT_BLOCK_RELEASE,
  RICH_TEXT_INPUT_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
  fieldInputControlKeys,
  type FieldInputControlKey,
  type PlatformBlockReleaseV2,
} from "@vortex/contracts";
import { DefinitionRenderError } from "../definition-error";
import type { ControlRenderProps } from "./control-context";
import type { FieldInputPayload } from "./projected-data";
import { TextInput } from "./text-input";
import { LinkInput } from "./link-input";
import { RichTextInput } from "./rich-text-input";
import { NumberInput } from "./number-input";
import { BooleanInput } from "./boolean-input";
import { DateInput } from "./date-input";
import { ChoiceInput } from "./choice-input";

export type FieldInputProps = ControlRenderProps<FieldInputPayload>;

type FieldInputTarget = Readonly<{
  metadata: PlatformBlockReleaseV2;
  component: ComponentType<ControlRenderProps<FieldInputPayload>>;
}>;

const asTarget = (metadata: PlatformBlockReleaseV2, component: unknown): FieldInputTarget => ({
  metadata,
  component: component as ComponentType<ControlRenderProps<FieldInputPayload>>,
});

/**
 * The one renderer for every automatic field input. The compiler derived its `control` from the
 * referenced module field type, so this adapter delegates to the exact registered input control and
 * its own release metadata; the placement's settings already carry that control's derived values.
 * A placement without a derived control, or carrying values of a different control's shape, is
 * refused rather than rendered with an invented one.
 */
const TARGETS: Readonly<Record<FieldInputControlKey, FieldInputTarget>> = Object.freeze({
  text: asTarget(TEXT_INPUT_BLOCK_RELEASE, TextInput),
  rich_text: asTarget(RICH_TEXT_INPUT_BLOCK_RELEASE, RichTextInput),
  number: asTarget(NUMBER_INPUT_BLOCK_RELEASE, NumberInput),
  boolean: asTarget(BOOLEAN_INPUT_BLOCK_RELEASE, BooleanInput),
  date: asTarget(DATE_INPUT_BLOCK_RELEASE, DateInput),
  choice: asTarget(CHOICE_INPUT_BLOCK_RELEASE, ChoiceInput),
  link: asTarget(LINK_INPUT_BLOCK_RELEASE, LinkInput),
});

/** The exact projected-value kind each derived control accepts, so a mismatch fails closed. */
const EXPECTED_PAYLOAD_KIND: Readonly<Record<FieldInputControlKey, FieldInputPayload["kind"]>> =
  Object.freeze({
    text: "text_input",
    rich_text: "rich_text_input",
    number: "number_input",
    boolean: "boolean_input",
    date: "date_input",
    choice: "choice_input",
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
  const target = TARGETS[key];
  const Component = target.component;
  return <Component {...props} metadata={target.metadata} />;
}
