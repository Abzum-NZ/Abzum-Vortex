import {
  flowRefusalFeedbackCodeSchema,
  labelSchema,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  type PlatformBlockRelease,
  isRecord,
} from "@vortex/platform/schema";
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
  parseDependentChoiceInputPayload,
  parseControlData,
  parseControlEventHandlers,
  parseDateInputPayload,
  parseDialogPayload,
  parseDrawerPayload,
  parseFieldInputPayload,
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
  type FieldInputPayload,
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
import type { FormFlowFeedback } from "./form-container";

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
  flowFeedback: (value, location): FormFlowFeedback => {
    const feedback = requireRecord(value, "Flow feedback must be an object", location);
    if (feedback.kind === "message") {
      requireExactKeys(feedback, ["kind", "tone", "text"], location);
      if (feedback.tone !== "success" && feedback.tone !== "problem")
        fail("Flow feedback tone must be success or problem", location);
      return Object.freeze({
        kind: "message",
        tone: feedback.tone,
        text: requireNonEmptyString(feedback.text, "Flow feedback requires a message", location),
      });
    }
    if (feedback.kind === "refusal") {
      requireExactKeys(feedback, ["kind", "code", "fieldLabel", "recovery"], location);
      if (
        feedback.recovery !== undefined &&
        feedback.recovery !== "partial" &&
        feedback.recovery !== "uncertain"
      )
        fail("Flow refusal recovery must be partial or uncertain", location);
      const code = flowRefusalFeedbackCodeSchema.safeParse(feedback.code);
      if (!code.success) fail("Flow refusal feedback code is unsupported", location);
      if (feedback.fieldLabel !== undefined && code.data !== "invalid_command")
        fail("Only invalid command feedback may identify a field", location);
      const fieldLabel =
        feedback.fieldLabel === undefined ? undefined : labelSchema.safeParse(feedback.fieldLabel);
      if (fieldLabel !== undefined && !fieldLabel.success)
        fail("Flow refusal feedback field label is invalid", location);
      return Object.freeze({
        kind: "refusal",
        code: code.data,
        ...(fieldLabel?.success ? { fieldLabel: fieldLabel.data } : {}),
        ...(feedback.recovery === undefined ? {} : { recovery: feedback.recovery }),
      });
    }
    fail("Flow feedback kind must be message or refusal", location);
  },
});

/** Exact registrations pairing each control block release with its React renderer. */
export const CONTROL_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TEXT_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<TextInputPayload>(parseTextInputPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.LINK_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<LinkInputPayload>(parseLinkInputPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.RICH_TEXT_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<RichTextInputPayload>(parseRichTextInputPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.NUMBER_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<NumberInputPayload>(parseNumberInputPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.BOOLEAN_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<BooleanInputPayload>(parseBooleanInputPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.DATE_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<DateInputPayload>(parseDateInputPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.CHOICE_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<ChoiceInputPayload>(parseChoiceInputPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.CHOICE_INPUT_BLOCK_RELEASE_1_1_0,
      parsePayload: controlPayloadParser<ChoiceInputPayload>(parseChoiceInputPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.CHOICE_INPUT_BLOCK_RELEASE_1_2_0,
      parsePayload: controlPayloadParser<ChoiceInputPayload>(parseDependentChoiceInputPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.FIELD_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<FieldInputPayload>(parseFieldInputPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.VALIDATION_MESSAGE_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<ValidationPayload>(parseValidationPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.BUTTON_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<ButtonPayload>(parseButtonPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TABS_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<TabsPayload>(parseTabsPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TABS_BLOCK_RELEASE_2_0_0,
      parsePayload: controlPayloadParser<TabsPayload>(parseTabsPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.DIALOG_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<DialogPayload>(parseDialogPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.DRAWER_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<DrawerPayload>(parseDrawerPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.FORM_CONTAINER_BLOCK_RELEASE,
      parsePayload: FORM_PAYLOAD_PARSER,
    }),
  ]);

/** Creates an immutable PlatformComponentRegistry populated with all control components. */
export function createControlComponentRegistry(
  platformReleases: readonly PlatformBlockRelease[],
): PlatformComponentRegistry {
  return createPlatformComponentRegistry(CONTROL_COMPONENT_REGISTRATIONS, platformReleases);
}
