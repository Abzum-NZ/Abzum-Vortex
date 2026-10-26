import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  type FormDraftFeedbackSupply,
  type FormFlowFeedback,
} from "@vortex/platform/schema";
import {
  createPayloadParser,
  type PlatformComponentPayloadParser,
  type PlatformComponentRegistration,
} from "../registry";
import {
  parseControlEventHandlers,
  readControlData,
  readControlSupply,
  type AttachmentInputPayload,
  type TableInputPayload,
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
  type ValidationPayload,
} from "./projected-data";

/**
 * The parser a control block's registration supplies: its own ready values under `data` and its own
 * declared semantic callbacks under `events`. Each block names one payload parser, so an accepted
 * payload shape is that block's alone and adding a control needs no renderer change.
 */
const controlPayloadParser = <Payload>(): PlatformComponentPayloadParser =>
  createPayloadParser({
    data: (value, location) => readControlData<Payload>(value, location),
    events: (value, location) => parseControlEventHandlers(value, location),
  });

/**
 * The form container's own parser. Besides its own ready values and callbacks it declares the one
 * draft-feedback result the page projection supplies, which is how located feedback reaches
 * the form without the renderer ever naming it.
 */
const FORM_PAYLOAD_PARSER: PlatformComponentPayloadParser = createPayloadParser({
  data: (value, location) => readControlData<FormPayload>(value, location),
  events: (value, location) => parseControlEventHandlers(value, location),
  draftFeedback: (value, location) =>
    readControlSupply<FormDraftFeedbackSupply>(value, "Draft feedback is invalid", location),
  flowFeedback: (value, location) =>
    readControlSupply<FormFlowFeedback>(value, "Flow feedback is invalid", location),
});

/** Exact registrations pairing each control block release with its React renderer. */
export const CONTROL_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TEXT_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<TextInputPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.LINK_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<LinkInputPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.RICH_TEXT_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<RichTextInputPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.NUMBER_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<NumberInputPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.BOOLEAN_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<BooleanInputPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.DATE_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<DateInputPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.CHOICE_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<ChoiceInputPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.ATTACHMENT_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<AttachmentInputPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<TableInputPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.FIELD_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<FieldInputPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.VALIDATION_MESSAGE_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<ValidationPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.BUTTON_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<ButtonPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TABS_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<TabsPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.DIALOG_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<DialogPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.DRAWER_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<DrawerPayload>(),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.FORM_CONTAINER_BLOCK_RELEASE,
      parsePayload: FORM_PAYLOAD_PARSER,
    }),
  ]);
