import {
  attachmentInputPayloadSchema,
  booleanInputPayloadSchema,
  buttonPayloadSchema,
  choiceInputPayloadSchema,
  choiceOptionsSchema,
  controlDataStateSchema,
  dateInputPayloadSchema,
  dialogPayloadSchema,
  drawerPayloadSchema,
  fieldInputPayloadSchema,
  formDraftFeedbackSupplySchema,
  formFlowFeedbackSchema,
  formPayloadSchema,
  isRecord,
  linkInputPayloadSchema,
  numberInputPayloadSchema,
  recordChoicePageSchema,
  richTextInputPayloadSchema,
  tableInputPayloadSchema,
  tabsPayloadSchema,
  textInputPayloadSchema,
  typedFieldValueSchema,
  validationPayloadSchema,
  type AttachmentInputPayload,
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
  type ReferenceChoiceSelectionEvidence,
  type RichTextInputPayload,
  type TableInputPayload,
  type TabsPayload,
  type TextInputPayload,
  type TypedFieldValue,
  type ValidationPayload,
} from "@vortex/platform/schema";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";

export {
  isIsoCalendarDate,
  type AttachmentInputPayload,
  type BooleanInputPayload,
  type ButtonPayload,
  type ChoiceInputPayload,
  type ChoiceOption,
  type DateInputPayload,
  type DateTimeInputPayload,
  type DialogPayload,
  type DrawerPayload,
  type FieldInputPayload,
  type FormPayload,
  type LinkInputPayload,
  type NumberInputPayload,
  type RecordChoiceOption,
  type RecordChoicePage,
  type RichTextInputPayload,
  type SeveralChoicesInputPayload,
  type TableInputPayload,
  type TabsPayload,
  type TextInputPayload,
  type TypedFieldValue,
  type TypedRecordReference,
  type TypedTableValue,
  type ValidationPayload,
} from "@vortex/platform/schema";

/** Every event name any control accepts; each block further narrows this to its own declaration. */
export const CONTROL_EVENT_NAMES = Object.freeze([
  "action",
  "field_changed",
  "form_ready",
  "form_reset",
  "form_submit",
  "tab_changed",
  "choices_requested",
  "records_requested",
] as const);

/** Declared semantic event names this form and action family can emit. */
export type ControlSemanticEventName = (typeof CONTROL_EVENT_NAMES)[number];

/** A structured rich-text document a rich-text input collects. */
export type TypedRichTextDocument = NonNullable<RichTextInputPayload["value"]>;

/**
 * One declared semantic event. Events are emitted only by a real user interaction, except
 * `form_ready`, which a form emits once when it mounts. The bound flow, not the component,
 * decides what an event does; no component saves, queries or calls an application service.
 */
export type ControlSemanticEvent =
  | Readonly<{
      event: "action";
      intent: "activate" | "dismiss";
      /** An action button inside a form reports the form's current typed field values. */
      values?: Readonly<Record<string, TypedFieldValue>>;
    }>
  | Readonly<{ event: "field_changed"; fieldKey: string; value: TypedFieldValue }>
  | Readonly<{
      event: "choices_requested";
      search?: string;
      continuationToken?: string;
      selectedKey?: string;
      selectedEvidence?: ReferenceChoiceSelectionEvidence;
    }>
  | Readonly<{
      event: "records_requested";
      search?: string;
      continuationToken?: string;
      /** For a dependent link field: the record chosen in the field it depends on, in the form's draft. */
      parentRecordId?: string;
    }>
  | Readonly<{ event: "form_ready" }>
  | Readonly<{ event: "form_reset" }>
  | Readonly<{
      event: "form_submit";
      values: Readonly<Record<string, TypedFieldValue>>;
      selectedOwnerGroupId?: string;
    }>
  | Readonly<{ event: "tab_changed"; tabKey: string }>;

/**
 * A control's callback. Only `records_requested` answers with data: the page runtime reads one page
 * of pickable records for the link input that asked and returns it, which the input parses
 * fail-closed with {@link parseRecordChoicePage}.
 */
export type ControlEventHandler = (event: ControlSemanticEvent) => void | Promise<unknown>;

/** Callbacks accepted by one control placement, keyed only by declared event name. */
export type ControlEventHandlers = Readonly<
  Partial<Record<ControlSemanticEventName, ControlEventHandler>>
>;

export type TextInputData = ControlDataState<TextInputPayload>;
export type LinkInputData = ControlDataState<LinkInputPayload>;
export type RichTextInputData = ControlDataState<RichTextInputPayload>;
export type NumberInputData = ControlDataState<NumberInputPayload>;
export type BooleanInputData = ControlDataState<BooleanInputPayload>;
export type DateInputData = ControlDataState<DateInputPayload>;
export type ChoiceInputData = ControlDataState<ChoiceInputPayload>;
export type FieldInputData = ControlDataState<FieldInputPayload>;
export type ValidationData = ControlDataState<ValidationPayload>;
export type ButtonData = ControlDataState<ButtonPayload>;
export type TabsData = ControlDataState<TabsPayload>;
export type DialogData = ControlDataState<DialogPayload>;
export type DrawerData = ControlDataState<DrawerPayload>;
export type FormContainerData = ControlDataState<FormPayload>;

/**
 * Explicit, data-safe state for one control placement, parameterised by that block's own ready
 * values. `loading` means the control's data or a submission it started is pending, so it cannot be
 * activated again; `disabled` carries an optional safe reason; only `ready` carries values. Each
 * block names its own state type, so no closed union of every accepted payload exists centrally.
 */
export type ControlDataState<Values> =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "disabled"; reason?: string }>
  | Readonly<{ status: "ready"; values: Values }>;

// The data-free state carries no values, so one frozen instance serves every block's state type.
const LOADING_STATE: ControlDataState<never> = Object.freeze({ status: "loading" });
const EMPTY_CONTROL_HANDLERS: ControlEventHandlers = Object.freeze({});

const fail = (message: string, location: DefinitionRenderErrorLocation): never => {
  throw new DefinitionRenderError("INVALID_COMPOSITION", message, location);
};

/** A Zod issue path as a property path: an index joins the property before it (`options[3]`). */
const propertyPathOf = (path: readonly PropertyKey[]): string[] =>
  path.reduce<string[]>((parts, segment) => {
    const last = parts.at(-1);
    return typeof segment === "number" && last !== undefined
      ? [...parts.slice(0, -1), `${last}[${segment}]`]
      : [...parts, String(segment)];
  }, []);

type ControlPayloadSchema<Output> = {
  safeParse(value: unknown):
    | { success: true; data: Output }
    | {
        success: false;
        error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
      };
};

/** One control payload parser: its platform schema, refused with a located error. */
const controlParser =
  <Output>(schema: ControlPayloadSchema<Output>, message: string) =>
  (value: unknown, location: DefinitionRenderErrorLocation = {}): Output => {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    const issuePath = propertyPathOf(issue?.path ?? []);
    return fail(
      `${message}: ${issue?.message ?? "invalid"}`,
      issuePath.length === 0 ? location : { ...location, propertyPath: issuePath },
    );
  };

/** Bounded choice options, refusing duplicate values so every option has one identity. */
export const parseChoiceOptions = controlParser(choiceOptionsSchema, "Choice options are invalid");

/**
 * One typed form field value exactly as a control input emits or collects it, validated
 * fail-closed. A several-choice value is a bounded array of declared option values, a linked
 * record contributes only its stable `recordTypeId:recordId` identity, and a document is structured
 * rich text.
 */
export const parseTypedFieldValue = controlParser<TypedFieldValue>(
  typedFieldValueSchema,
  "A typed field value is invalid",
);

/** One page of pickable records as the page runtime returned it, validated fail-closed. */
export const parseRecordChoicePage = controlParser(
  recordChoicePageSchema,
  "A record choice page is invalid",
);

/** The ready values a text input accepts. */
export const parseTextInputPayload = controlParser<TextInputPayload>(
  textInputPayloadSchema,
  "Text input values are invalid",
);

/** The ready values a link input accepts. */
export const parseLinkInputPayload = controlParser<LinkInputPayload>(
  linkInputPayloadSchema,
  "Link input values are invalid",
);

/** The ready values a structured rich-text input accepts. */
export const parseRichTextInputPayload = controlParser<RichTextInputPayload>(
  richTextInputPayloadSchema,
  "Rich text input values are invalid",
);

/** The ready values a number input accepts. */
export const parseNumberInputPayload = controlParser<NumberInputPayload>(
  numberInputPayloadSchema,
  "Number input values are invalid",
);

/** The ready values a boolean input accepts. */
export const parseBooleanInputPayload = controlParser<BooleanInputPayload>(
  booleanInputPayloadSchema,
  "Yes/no input values are invalid",
);

/** The ready values a date input accepts. */
export const parseDateInputPayload = controlParser<DateInputPayload>(
  dateInputPayloadSchema,
  "Date input values are invalid",
);

/** The ready values a choice input accepts. */
export const parseChoiceInputPayload = controlParser<ChoiceInputPayload>(
  choiceInputPayloadSchema,
  "Choice input values are invalid",
);

/** The ready values a table input accepts. */
export const parseTableInputPayload = controlParser<TableInputPayload>(
  tableInputPayloadSchema,
  "Table input values are invalid",
);

/** The ready values an attachment input accepts. */
export const parseAttachmentInputPayload = controlParser<AttachmentInputPayload>(
  attachmentInputPayloadSchema,
  "Attachment values are invalid",
);

/**
 * The ready values an automatic field input accepts. It carries exactly the payload of the control
 * its referenced module field selected, so this one schema validates every control kind the input
 * may become and the renderer never invents a shape.
 */
export const parseFieldInputPayload = controlParser<FieldInputPayload>(
  fieldInputPayloadSchema,
  "Field input values are invalid",
);

/** The ready values a validation message block accepts. */
export const parseValidationPayload = controlParser<ValidationPayload>(
  validationPayloadSchema,
  "Validation values are invalid",
);

/** The ready values a button block accepts. */
export const parseButtonPayload = controlParser<ButtonPayload>(
  buttonPayloadSchema,
  "Button values are invalid",
);

/** The ready values a tabs block accepts. */
export const parseTabsPayload = controlParser<TabsPayload>(
  tabsPayloadSchema,
  "Tabs values are invalid",
);

/** The ready values a dialog block accepts. */
export const parseDialogPayload = controlParser<DialogPayload>(
  dialogPayloadSchema,
  "Dialog values are invalid",
);

/** The ready values a drawer block accepts. */
export const parseDrawerPayload = controlParser<DrawerPayload>(
  drawerPayloadSchema,
  "Drawer values are invalid",
);

/** The ready values a form container accepts. */
export const parseFormPayload = controlParser<FormPayload>(
  formPayloadSchema,
  "Form values are invalid",
);

/** The one supplied draft-feedback result a form applies to its exact draft. */
export const parseFormDraftFeedbackSupply = controlParser(
  formDraftFeedbackSupplySchema,
  "Draft feedback is invalid",
);

/** What a form shows after its flow ran: a message or a business refusal. */
export const parseFormFlowFeedback = controlParser(
  formFlowFeedbackSchema,
  "Flow feedback is invalid",
);

const parseControlState = controlParser(
  controlDataStateSchema,
  "Projected control data is invalid",
);

/**
 * Validates one control's unknown projected state and returns its fail-closed shape. Only the
 * `ready` state reaches that block's own payload parser, so every accepted shape stays the
 * registration's own concern. Throws a located definition error for unknown or malformed input.
 */
export const parseControlData = <Values>(
  value: unknown,
  parseValues: (value: unknown, location: DefinitionRenderErrorLocation) => Values,
  location: DefinitionRenderErrorLocation = {},
): ControlDataState<Values> => {
  const state = parseControlState(value, location);
  switch (state.status) {
    case "loading":
      return LOADING_STATE;
    case "disabled":
      return state;
    case "ready":
      return Object.freeze({ status: "ready", values: parseValues(state.values, location) });
  }
};

/** Validates unknown semantic callbacks for one placement keyed by a known event name. */
export const parseControlEventHandlers = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ControlEventHandlers => {
  if (value === undefined) return EMPTY_CONTROL_HANDLERS;
  const record = isRecord(value)
    ? value
    : fail("Control semantic callbacks must be an object", location);
  const handlers: Partial<Record<ControlSemanticEventName, ControlEventHandler>> = {};
  for (const [name, handler] of Object.entries(record)) {
    if (!CONTROL_EVENT_NAMES.includes(name as ControlSemanticEventName))
      fail(`Unknown control semantic event '${name}'`, location);
    if (typeof handler !== "function")
      fail(`Control semantic event '${name}' must be a callback`, location);
    handlers[name as ControlSemanticEventName] = handler as ControlEventHandler;
  }
  return Object.freeze(handlers);
};
