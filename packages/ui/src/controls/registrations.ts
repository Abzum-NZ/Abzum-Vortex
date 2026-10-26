import { PLATFORM_BLOCK_RELEASE_IDENTITIES } from "@vortex/platform/schema";
import {
  createPayloadParser,
  type PlatformComponentPayloadParser,
  type PlatformComponentRegistration,
} from "../registry";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import {
  parseBooleanInputPayload,
  parseButtonPayload,
  parseChoiceInputPayload,
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
  parseTableInputPayload,
  parseAttachmentInputPayload,
  type AttachmentInputPayload,
  type TableInputPayload,
  parseFormDraftFeedbackSupply,
  parseFormFlowFeedback,
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
  type ValidationPayload,
} from "./projected-data";

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

/**
 * The form container's own parser. Besides its own ready values and callbacks it declares the one
 * #591 draft-feedback result the page projection supplies, which is how located feedback reaches
 * the form without the renderer ever naming it.
 */
const FORM_PAYLOAD_PARSER: PlatformComponentPayloadParser = createPayloadParser({
  data: (value, location) => parseControlData<FormPayload>(value, parseFormPayload, location),
  events: (value, location) => parseControlEventHandlers(value, location),
  draftFeedback: (value, location) => parseFormDraftFeedbackSupply(value, location),
  flowFeedback: (value, location) => parseFormFlowFeedback(value, location),
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
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.ATTACHMENT_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<AttachmentInputPayload>(parseAttachmentInputPayload),
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_INPUT_BLOCK_RELEASE,
      parsePayload: controlPayloadParser<TableInputPayload>(parseTableInputPayload),
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
