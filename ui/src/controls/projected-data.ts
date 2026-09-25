import {
  builderKeySchema,
  richTextDocumentV2Schema,
  type BlockPropertyValueV2Contract,
  type ComponentSemanticEventKind,
} from "@vortex/contracts";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";

/** Every event name any control accepts; each block further narrows this to its own declaration. */
export const CONTROL_EVENT_NAMES = Object.freeze([
  "action",
  "field_changed",
  "form_ready",
  "form_reset",
  "form_submit",
  "tab_changed",
] as const satisfies readonly ComponentSemanticEventKind[]);

/** Declared semantic event names this form and action family can emit. */
export type ControlSemanticEventName = (typeof CONTROL_EVENT_NAMES)[number];

/** Closed set of typed values that form field inputs collect and emit. */
export type TypedRichTextDocument = Extract<
  BlockPropertyValueV2Contract,
  { kind: "rich_text" }
>["value"];

/**
 * A link input's projected value: the stable `recordTypeId:recordId` reference of the linked
 * record, never the record's values. It grants no access to the referenced record.
 */
export type TypedRecordReference = Readonly<{
  recordTypeId: string;
  recordId: string;
}>;

export type TypedFieldValue =
  | string
  | number
  | boolean
  | null
  | TypedRecordReference
  | TypedRichTextDocument;

/**
 * One declared semantic event. Events are emitted only by a real user interaction, except
 * `form_ready`, which a form emits once when it mounts. The bound flow, not the component,
 * decides what an event does; no component saves, queries or calls an application service.
 */
export type ControlSemanticEvent =
  | Readonly<{ event: "action"; intent: "activate" | "dismiss" }>
  | Readonly<{ event: "field_changed"; fieldKey: string; value: TypedFieldValue }>
  | Readonly<{ event: "form_ready" }>
  | Readonly<{ event: "form_reset" }>
  | Readonly<{ event: "form_submit"; values: Readonly<Record<string, TypedFieldValue>> }>
  | Readonly<{ event: "tab_changed"; tabKey: string }>;

export type ControlEventHandler = (event: ControlSemanticEvent) => void;

/** Callbacks accepted by one control placement, keyed only by declared event name. */
export type ControlEventHandlers = Readonly<
  Partial<Record<ControlSemanticEventName, ControlEventHandler>>
>;

/** One choice option available in a choice input. */
export type ChoiceOption = Readonly<{ key: string; label: string }>;

/** The ready values a text input accepts. */
export type TextInputPayload = Readonly<{ kind: "text_input"; value?: string; error?: string }>;

/** The ready values a link input accepts: a stable record reference, never the record's values. */
export type LinkInputPayload = Readonly<{
  kind: "link_input";
  value?: TypedRecordReference | null;
  error?: string;
}>;

/** The ready values a structured rich-text input accepts. */
export type RichTextInputPayload = Readonly<{
  kind: "rich_text_input";
  value?: TypedRichTextDocument | null;
  error?: string;
}>;

/** The ready values a number input accepts. */
export type NumberInputPayload = Readonly<{
  kind: "number_input";
  value?: number | null;
  error?: string;
}>;

/** The ready values a boolean input accepts. */
export type BooleanInputPayload = Readonly<{
  kind: "boolean_input";
  value?: boolean;
  error?: string;
}>;

/** The ready values a date input accepts. */
export type DateInputPayload = Readonly<{
  kind: "date_input";
  value?: string | null;
  error?: string;
}>;

/** The ready values a choice input accepts. */
export type ChoiceInputPayload = Readonly<{
  kind: "choice_input";
  value?: string | null;
  options?: readonly ChoiceOption[];
  error?: string;
}>;

/** The ready values a validation message block accepts. */
export type ValidationPayload = Readonly<{ kind: "validation"; errors: readonly string[] }>;

/** The ready values a button block accepts; a button carries no value of its own. */
export type ButtonPayload = Readonly<{ kind: "button" }>;

/** The ready values a tabs block accepts. */
export type TabsPayload = Readonly<{ kind: "tabs"; activeTab?: string }>;

/** The ready values a dialog block accepts. */
export type DialogPayload = Readonly<{ kind: "dialog"; open: boolean }>;

/** The ready values a drawer block accepts. */
export type DrawerPayload = Readonly<{ kind: "drawer"; open: boolean }>;

/** The ready values a form container accepts; a form's values come from its own fields. */
export type FormPayload = Readonly<{ kind: "form" }>;

export type TextInputData = ControlDataState<TextInputPayload>;
export type LinkInputData = ControlDataState<LinkInputPayload>;
export type RichTextInputData = ControlDataState<RichTextInputPayload>;
export type NumberInputData = ControlDataState<NumberInputPayload>;
export type BooleanInputData = ControlDataState<BooleanInputPayload>;
export type DateInputData = ControlDataState<DateInputPayload>;
export type ChoiceInputData = ControlDataState<ChoiceInputPayload>;
export type ValidationData = ControlDataState<ValidationPayload>;
export type ButtonData = ControlDataState<ButtonPayload>;
export type TabsData = ControlDataState<TabsPayload>;
export type DialogData = ControlDataState<DialogPayload>;
export type DrawerData = ControlDataState<DrawerPayload>;
export type FormData = ControlDataState<FormPayload>;

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
const ISO_CALENDAR_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

const fail = (message: string, location: DefinitionRenderErrorLocation): never => {
  throw new DefinitionRenderError("INVALID_COMPOSITION", message, location);
};

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
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`Unexpected projected control field '${key}'`, location);
  }
};

const requireString = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => (typeof value === "string" ? value : fail(message, location));

const requireNonEmptyString = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const text = requireString(value, message, location);
  return text.trim().length > 0 ? text : fail(message, location);
};

const requireBoolean = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): boolean => (typeof value === "boolean" ? value : fail(message, location));

const requireBuilderKey = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = builderKeySchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
};

const requireRecordReference = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): TypedRecordReference => {
  const record = requireRecord(value, "A record reference must be an object", location);
  requireExactKeys(record, ["recordTypeId", "recordId"], location);
  return Object.freeze({
    recordTypeId: requireNonEmptyString(
      record.recordTypeId,
      "A record reference type identifier must be non-empty text",
      location,
    ),
    recordId: requireNonEmptyString(
      record.recordId,
      "A record reference identifier must be non-empty text",
      location,
    ),
  });
};

const parseRichTextDocument = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): TypedRichTextDocument => {
  const parsed = richTextDocumentV2Schema.safeParse(value);
  return parsed.success
    ? (parsed.data as TypedRichTextDocument)
    : fail("Rich text content is not a valid structured document", location);
};

/** True for a real ISO calendar date such as 2026-02-28; 2026-02-30 is refused. */
export const isIsoCalendarDate = (value: string): boolean => {
  if (!ISO_CALENDAR_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const optionalError = (
  record: Record<string, unknown>,
  location: DefinitionRenderErrorLocation,
): Readonly<{ error?: string }> =>
  record.error === undefined
    ? {}
    : {
        error: requireNonEmptyString(
          record.error,
          "A projected field error must be non-empty text",
          location,
        ),
      };

/** Parses choice options, refusing duplicate keys so every option has one stable identity. */
export const parseChoiceOptions = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): readonly ChoiceOption[] => {
  if (!Array.isArray(value)) return fail("Choice options must be an array", location);
  const seen = new Set<string>();
  return Object.freeze(
    value.map((item) => {
      const record = requireRecord(item, "A choice option must be an object", location);
      requireExactKeys(record, ["key", "label"], location);
      const key = requireBuilderKey(record.key, "A choice option key is invalid", location);
      if (seen.has(key)) fail(`Duplicate choice option key '${key}'`, location);
      seen.add(key);
      const label = requireNonEmptyString(
        record.label,
        "A choice option label must be non-empty text",
        location,
      );
      return Object.freeze({ key, label });
    }),
  );
};

/**
 * One typed form field value exactly as a control input emits or collects it, validated
 * fail-closed. A linked record contributes only its stable `recordTypeId:recordId` identity, a
 * document is a structured rich-text document, and nothing else is a typed field value.
 */
export const parseTypedFieldValue = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): TypedFieldValue => {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : fail("A typed number must be finite", location);
  if (!isRecord(value)) return fail("A typed field value must be a field value", location);
  if (Object.hasOwn(value, "blocks")) return parseRichTextDocument(value, location);
  if (Object.hasOwn(value, "recordTypeId") && Object.hasOwn(value, "recordId"))
    return requireRecordReference(value, location);
  return fail(
    "A typed field value must be a text, number, boolean, record reference or document",
    location,
  );
};

/** The ready values a text input accepts. */
export const parseTextInputPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): TextInputPayload => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  if (record.kind !== "text_input")
    return fail(`Expected 'text_input' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(record, ["kind", "value", "error"], location);
  return Object.freeze({
    kind: "text_input",
    ...(record.value === undefined
      ? {}
      : { value: requireString(record.value, "A text value must be text", location) }),
    ...optionalError(record, location),
  });
};

/** The ready values a link input accepts. */
export const parseLinkInputPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): LinkInputPayload => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  if (record.kind !== "link_input")
    return fail(`Expected 'link_input' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(record, ["kind", "value", "error"], location);
  return Object.freeze({
    kind: "link_input",
    ...(record.value === undefined
      ? {}
      : record.value === null
        ? { value: null }
        : { value: requireRecordReference(record.value, location) }),
    ...optionalError(record, location),
  });
};

/** The ready values a structured rich-text input accepts. */
export const parseRichTextInputPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): RichTextInputPayload => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  if (record.kind !== "rich_text_input")
    return fail(
      `Expected 'rich_text_input' projected values, got '${String(record.kind)}'`,
      location,
    );
  requireExactKeys(record, ["kind", "value", "error"], location);
  return Object.freeze({
    kind: "rich_text_input",
    ...(record.value === undefined
      ? {}
      : record.value === null
        ? { value: null }
        : { value: parseRichTextDocument(record.value, location) }),
    ...optionalError(record, location),
  });
};

/** The ready values a number input accepts. */
export const parseNumberInputPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): NumberInputPayload => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  if (record.kind !== "number_input")
    return fail(
      `Expected 'number_input' projected values, got '${String(record.kind)}'`,
      location,
    );
  requireExactKeys(record, ["kind", "value", "error"], location);
  if (
    record.value !== undefined &&
    record.value !== null &&
    !(typeof record.value === "number" && Number.isFinite(record.value))
  )
    fail("A number value must be a finite number or null", location);
  return Object.freeze({
    kind: "number_input",
    ...(record.value === undefined ? {} : { value: record.value as number | null }),
    ...optionalError(record, location),
  });
};

/** The ready values a boolean input accepts. */
export const parseBooleanInputPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): BooleanInputPayload => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  if (record.kind !== "boolean_input")
    return fail(
      `Expected 'boolean_input' projected values, got '${String(record.kind)}'`,
      location,
    );
  requireExactKeys(record, ["kind", "value", "error"], location);
  return Object.freeze({
    kind: "boolean_input",
    ...(record.value === undefined
      ? {}
      : {
          value: requireBoolean(
            record.value,
            "A boolean value must be true or false",
            location,
          ),
        }),
    ...optionalError(record, location),
  });
};

/** The ready values a date input accepts. */
export const parseDateInputPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): DateInputPayload => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  if (record.kind !== "date_input")
    return fail(`Expected 'date_input' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(record, ["kind", "value", "error"], location);
  if (
    record.value !== undefined &&
    record.value !== null &&
    !(typeof record.value === "string" && isIsoCalendarDate(record.value))
  )
    fail("A date value must be an ISO calendar date or null", location);
  return Object.freeze({
    kind: "date_input",
    ...(record.value === undefined ? {} : { value: record.value as string | null }),
    ...optionalError(record, location),
  });
};

/** The ready values a choice input accepts. */
export const parseChoiceInputPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ChoiceInputPayload => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  if (record.kind !== "choice_input")
    return fail(
      `Expected 'choice_input' projected values, got '${String(record.kind)}'`,
      location,
    );
  requireExactKeys(record, ["kind", "value", "options", "error"], location);
  const options =
    record.options === undefined ? undefined : parseChoiceOptions(record.options, location);
  if (record.value !== undefined && record.value !== null) {
    const key = requireBuilderKey(record.value, "A choice value must be an option key", location);
    if (options !== undefined && !options.some((option) => option.key === key))
      fail(`Choice value '${key}' is not a projected option`, location);
  }
  return Object.freeze({
    kind: "choice_input",
    ...(record.value === undefined ? {} : { value: record.value as string | null }),
    ...(options === undefined ? {} : { options }),
    ...optionalError(record, location),
  });
};

/** The ready values a validation message block accepts. */
export const parseValidationPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ValidationPayload => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  if (record.kind !== "validation")
    return fail(`Expected 'validation' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(record, ["kind", "errors"], location);
  if (!Array.isArray(record.errors))
    return fail("Validation errors must be an array", location);
  return Object.freeze({
    kind: "validation",
    errors: Object.freeze(
      record.errors.map((error) =>
        requireNonEmptyString(error, "A validation error must be non-empty text", location),
      ),
    ),
  });
};

/** The ready values a button block accepts. */
export const parseButtonPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ButtonPayload => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  if (record.kind !== "button")
    return fail(`Expected 'button' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(record, ["kind"], location);
  return Object.freeze({ kind: "button" });
};

/** The ready values a tabs block accepts. */
export const parseTabsPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): TabsPayload => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  if (record.kind !== "tabs")
    return fail(`Expected 'tabs' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(record, ["kind", "activeTab"], location);
  return Object.freeze({
    kind: "tabs",
    ...(record.activeTab === undefined
      ? {}
      : {
          activeTab: requireBuilderKey(
            record.activeTab,
            "An active tab must be a tab key",
            location,
          ),
        }),
  });
};

/** The ready values a dialog block accepts. */
export const parseDialogPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): DialogPayload => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  if (record.kind !== "dialog")
    return fail(`Expected 'dialog' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(record, ["kind", "open"], location);
  return Object.freeze({
    kind: "dialog",
    open: requireBoolean(record.open, "Open state must be true or false", location),
  });
};

/** The ready values a drawer block accepts. */
export const parseDrawerPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): DrawerPayload => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  if (record.kind !== "drawer")
    return fail(`Expected 'drawer' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(record, ["kind", "open"], location);
  return Object.freeze({
    kind: "drawer",
    open: requireBoolean(record.open, "Open state must be true or false", location),
  });
};

/** The ready values a form container accepts. */
export const parseFormPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): FormPayload => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  if (record.kind !== "form")
    return fail(`Expected 'form' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(record, ["kind"], location);
  return Object.freeze({ kind: "form" });
};

/**
 * Validates one control's unknown projected state and returns its frozen fail-closed shape. Only
 * the `ready` state reaches that block's own payload parser, so every accepted shape stays the
 * registration's own concern. Throws a located definition error for unknown or malformed input.
 */
export const parseControlData = <Values>(
  value: unknown,
  parseValues: (value: unknown, location: DefinitionRenderErrorLocation) => Values,
  location: DefinitionRenderErrorLocation = {},
): ControlDataState<Values> => {
  const record = requireRecord(value, "Projected control data must be an object", location);
  switch (record.status) {
    case "loading":
      requireExactKeys(record, ["status"], location);
      return LOADING_STATE;
    case "disabled":
      requireExactKeys(record, ["status", "reason"], location);
      return Object.freeze({
        status: "disabled",
        ...(record.reason === undefined
          ? {}
          : {
              reason: requireNonEmptyString(
                record.reason,
                "A disabled reason must be non-empty text",
                location,
              ),
            }),
      });
    case "ready":
      requireExactKeys(record, ["status", "values"], location);
      return Object.freeze({
        status: "ready",
        values: parseValues(record.values, location),
      });
    default:
      return fail(`Unknown projected control status '${String(record.status)}'`, location);
  }
};

/** Validates unknown semantic callbacks for one placement keyed by a known event name. */
export const parseControlEventHandlers = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ControlEventHandlers => {
  if (value === undefined) return EMPTY_CONTROL_HANDLERS;
  const record = requireRecord(value, "Control semantic callbacks must be an object", location);
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
