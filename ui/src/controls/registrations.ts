import {
  BOOLEAN_INPUT_BLOCK_RELEASE,
  BUTTON_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  CONTROL_BLOCK_RELEASES,
  DATE_INPUT_BLOCK_RELEASE,
  DIALOG_BLOCK_RELEASE,
  DRAWER_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  LINK_INPUT_BLOCK_RELEASE,
  NUMBER_INPUT_BLOCK_RELEASE,
  RICH_TEXT_INPUT_BLOCK_RELEASE,
  TABS_BLOCK_RELEASE,
  TABS_BLOCK_RELEASE_2_0_0,
  TEXT_INPUT_BLOCK_RELEASE,
  VALIDATION_MESSAGE_BLOCK_RELEASE,
} from "@vortex/contracts";
import {
  createPayloadParser,
  createPlatformComponentRegistry,
  type PlatformComponentPayloadParser,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "../registry";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import {
  parseBooleanInputPayload,
  parseButtonPayload,
  parseChoiceInputPayload,
  parseControlData,
  parseControlEventHandlers,
  parseDateInputPayload,
  parseDialogPayload,
  parseDrawerPayload,
  parseFormPayload,
  parseLinkInputPayload,
  parseNumberInputPayload,
  parseRichTextInputPayload,
  parseTabsPayload,
  parseTextInputPayload,
  parseTypedFieldValue,
  parseValidationPayload,
  type BooleanInputPayload,
  type ButtonPayload,
  type ChoiceInputPayload,
  type DateInputPayload,
  type DialogPayload,
  type DrawerPayload,
  type FormPayload,
  type LinkInputPayload,
  type NumberInputPayload,
  type RichTextInputPayload,
  type TabsPayload,
  type TextInputPayload,
  type TypedFieldValue,
  type ValidationPayload,
} from "./projected-data";
import type { FormDraftFeedbackSupply } from "./draft-feedback";
import { TextInput } from "./text-input";
import { LinkInput } from "./link-input";
import { RichTextInput } from "./rich-text-input";
import { NumberInput } from "./number-input";
import { BooleanInput } from "./boolean-input";
import { DateInput } from "./date-input";
import { ChoiceInput } from "./choice-input";
import { ValidationMessage } from "./validation-message";
import { Button } from "./button";
import { Tabs } from "./tabs";
import { Dialog } from "./dialog";
import { Drawer } from "./drawer";
import { FormContainer } from "./form-container";

/**
 * Release metadata is owned by the server-side platform block catalogue in @vortex/contracts;
 * these registrations only pair each registered release with its renderer, so a renderer
 * change cannot redefine or extend what authors may place.
 */
export {
  BOOLEAN_INPUT_BLOCK_RELEASE,
  BUTTON_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  CONTROL_BLOCK_RELEASES,
  DATE_INPUT_BLOCK_RELEASE,
  DIALOG_BLOCK_RELEASE,
  DRAWER_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  LINK_INPUT_BLOCK_RELEASE,
  NUMBER_INPUT_BLOCK_RELEASE,
  RICH_TEXT_INPUT_BLOCK_RELEASE,
  TABS_BLOCK_RELEASE,
  TABS_BLOCK_RELEASE_2_0_0,
  TEXT_INPUT_BLOCK_RELEASE,
  VALIDATION_MESSAGE_BLOCK_RELEASE,
};

/**
 * The parser a control block's registration supplies: its own ready values under `data` and its own
 * declared semantic callbacks under `events`. Each block names one payload parser, so an accepted
 * payload shape is that block's alone and adding a control needs no renderer change.
 */
const controlPayloadParser = <Payload>(
  parseValues: (value: unknown, location: DefinitionRenderErrorLocation) => Payload,
): PlatformComponentPayloadParser =>
  createPayloadParser({
    data: (value, location) => parseControlData(value, parseValues, location),
    events: (value, location) => parseControlEventHandlers(value, location),
  });

function fail(message: string, location: DefinitionRenderErrorLocation): never {
  throw new DefinitionRenderError("INVALID_COMPOSITION", message, location);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): Record<string, unknown> => (isRecord(value) ? value : fail(message, location));

const requireExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: DefinitionRenderErrorLocation,
): void => {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      fail(`Unexpected supplied draft-feedback field '${key}'`, location);
};

const requireNonEmptyString = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string =>
  typeof value === "string" && value.trim().length > 0
    ? value
    : fail(message, location);

const requireBoolean = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): boolean => (typeof value === "boolean" ? value : fail(message, location));

const parseTypedFieldValues = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): Readonly<Record<string, TypedFieldValue>> => {
  const record = requireRecord(value, "Draft-feedback values must be an object", location);
  // Own data properties only: a supplied "__proto__" key stays an ordinary field key.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(record).map(([fieldKey, fieldValue]) => [
        fieldKey,
        parseTypedFieldValue(fieldValue, { ...location, propertyPath: [fieldKey] }),
      ]),
    ),
  );
};

/**
 * The one supplied #591 draft-feedback result. It arrives as an ordinary runtime input validated
 * here, fail-closed, so the form receives exactly the located result its own projection computed
 * and never an invented, remapped or partially shared one.
 */
const parseDraftFeedbackSupply = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): FormDraftFeedbackSupply => {
  const supply = requireRecord(value, "Draft feedback must be an object", location);
  requireExactKeys(supply, ["currentFingerprint", "values", "feedback"], location);
  const feedback = requireRecord(
    supply.feedback,
    "Draft feedback must carry a located result",
    location,
  );
  requireExactKeys(
    feedback,
    ["fingerprint", "fields", "requirements", "warnings", "refusal"],
    location,
  );
  const fieldStates = feedback.fields;
  const requirements = feedback.requirements;
  const warnings = feedback.warnings;
  if (!Array.isArray(fieldStates)) fail("Draft-feedback field states must be an array", location);
  if (!Array.isArray(requirements)) fail("Draft-feedback requirements must be an array", location);
  if (!Array.isArray(warnings)) fail("Draft-feedback warnings must be an array", location);
  return Object.freeze({
    currentFingerprint: requireNonEmptyString(
      supply.currentFingerprint,
      "A draft fingerprint must be non-empty text",
      location,
    ),
    values: parseTypedFieldValues(supply.values, location),
    feedback: Object.freeze({
      fingerprint: requireNonEmptyString(
        feedback.fingerprint,
        "A draft-feedback fingerprint must be non-empty text",
        location,
      ),
      fields: Object.freeze(
        fieldStates.map((state) => {
          const entry = requireRecord(
            state,
            "A draft-feedback field state must be an object",
            location,
          );
          requireExactKeys(entry, ["fieldKey", "required", "disabled", "visible"], location);
          return Object.freeze({
            fieldKey: requireNonEmptyString(
              entry.fieldKey,
              "A draft-feedback field state requires a non-empty field key",
              location,
            ),
            required: requireBoolean(
              entry.required,
              "A draft-feedback field state must declare required",
              location,
            ),
            disabled: requireBoolean(
              entry.disabled,
              "A draft-feedback field state must declare disabled",
              location,
            ),
            visible: requireBoolean(
              entry.visible,
              "A draft-feedback field state must declare visible",
              location,
            ),
          });
        }),
      ),
      requirements: Object.freeze(
        requirements.map((requirement) => {
          const entry = requireRecord(
            requirement,
            "A draft-feedback requirement must be an object",
            location,
          );
          requireExactKeys(entry, ["fieldKey", "message"], location);
          return Object.freeze({
            fieldKey: requireNonEmptyString(
              entry.fieldKey,
              "A draft-feedback requirement requires a non-empty field key",
              location,
            ),
            message: requireNonEmptyString(
              entry.message,
              "A draft-feedback requirement requires a non-empty message",
              location,
            ),
          });
        }),
      ),
      warnings: Object.freeze(
        warnings.map((warning) =>
          requireNonEmptyString(
            warning,
            "A draft-feedback warning must be non-empty text",
            location,
          ),
        ),
      ),
      ...(feedback.refusal === undefined
        ? {}
        : {
            refusal: (() => {
              const refusal = requireRecord(
                feedback.refusal,
                "A draft-feedback refusal must be an object",
                location,
              );
              requireExactKeys(refusal, ["message", "fieldKey"], location);
              return Object.freeze({
                message: requireNonEmptyString(
                  refusal.message,
                  "A draft-feedback refusal requires a non-empty message",
                  location,
                ),
                ...(refusal.fieldKey === undefined
                  ? {}
                  : {
                      fieldKey: requireNonEmptyString(
                        refusal.fieldKey,
                        "A draft-feedback refusal field key must be non-empty text",
                        location,
                      ),
                    }),
              });
            })(),
          }),
    }),
  });
};

/**
 * The form container's own parser. Besides its own ready values and callbacks it declares the one
 * #591 draft-feedback result the page projection supplies, which is how located feedback reaches
 * the form without the renderer ever naming it.
 */
const FORM_PAYLOAD_PARSER: PlatformComponentPayloadParser = createPayloadParser({
  data: (value, location) => parseControlData<FormPayload>(value, parseFormPayload, location),
  events: (value, location) => parseControlEventHandlers(value, location),
  draftFeedback: (value, location) => parseDraftFeedbackSupply(value, location),
});

/** Exact registrations pairing each control block release with its React renderer. */
export const CONTROL_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({
      metadata: TEXT_INPUT_BLOCK_RELEASE,
      render: TextInput,
      parsePayload: controlPayloadParser<TextInputPayload>(parseTextInputPayload),
    }),
    Object.freeze({
      metadata: LINK_INPUT_BLOCK_RELEASE,
      render: LinkInput,
      parsePayload: controlPayloadParser<LinkInputPayload>(parseLinkInputPayload),
    }),
    Object.freeze({
      metadata: RICH_TEXT_INPUT_BLOCK_RELEASE,
      render: RichTextInput,
      parsePayload: controlPayloadParser<RichTextInputPayload>(parseRichTextInputPayload),
    }),
    Object.freeze({
      metadata: NUMBER_INPUT_BLOCK_RELEASE,
      render: NumberInput,
      parsePayload: controlPayloadParser<NumberInputPayload>(parseNumberInputPayload),
    }),
    Object.freeze({
      metadata: BOOLEAN_INPUT_BLOCK_RELEASE,
      render: BooleanInput,
      parsePayload: controlPayloadParser<BooleanInputPayload>(parseBooleanInputPayload),
    }),
    Object.freeze({
      metadata: DATE_INPUT_BLOCK_RELEASE,
      render: DateInput,
      parsePayload: controlPayloadParser<DateInputPayload>(parseDateInputPayload),
    }),
    Object.freeze({
      metadata: CHOICE_INPUT_BLOCK_RELEASE,
      render: ChoiceInput,
      parsePayload: controlPayloadParser<ChoiceInputPayload>(parseChoiceInputPayload),
    }),
    Object.freeze({
      metadata: VALIDATION_MESSAGE_BLOCK_RELEASE,
      render: ValidationMessage,
      parsePayload: controlPayloadParser<ValidationPayload>(parseValidationPayload),
    }),
    Object.freeze({
      metadata: BUTTON_BLOCK_RELEASE,
      render: Button,
      parsePayload: controlPayloadParser<ButtonPayload>(parseButtonPayload),
    }),
    Object.freeze({
      metadata: TABS_BLOCK_RELEASE,
      render: Tabs,
      parsePayload: controlPayloadParser<TabsPayload>(parseTabsPayload),
    }),
    Object.freeze({
      metadata: TABS_BLOCK_RELEASE_2_0_0,
      render: Tabs,
      parsePayload: controlPayloadParser<TabsPayload>(parseTabsPayload),
    }),
    Object.freeze({
      metadata: DIALOG_BLOCK_RELEASE,
      render: Dialog,
      parsePayload: controlPayloadParser<DialogPayload>(parseDialogPayload),
    }),
    Object.freeze({
      metadata: DRAWER_BLOCK_RELEASE,
      render: Drawer,
      parsePayload: controlPayloadParser<DrawerPayload>(parseDrawerPayload),
    }),
    Object.freeze({
      metadata: FORM_CONTAINER_BLOCK_RELEASE,
      render: FormContainer,
      parsePayload: FORM_PAYLOAD_PARSER,
    }),
  ]);

/** Creates an immutable PlatformComponentRegistry populated with all control components. */
export function createControlComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(CONTROL_COMPONENT_REGISTRATIONS);
}
