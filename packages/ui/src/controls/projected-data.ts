import {
  isRecord,
  pipelineStageTones,
  type PipelineStageTone,
  type RecordChoicePage,
  type RichTextInputPayload,
  type TypedFieldValue,
} from "@vortex/platform/schema";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import type { FlowEventCycle } from "../flow-runtime/flow-cycle";

export {
  isIsoCalendarDate,
  type AttachmentInputPayload,
  type BooleanInputPayload,
  type ButtonPayload,
  type ChoiceInputPayload,
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
const CONTROL_EVENT_NAMES = Object.freeze([
  "action",
  "field_changed",
  "field_focus_lost",
  "form_cancel",
  "form_ready",
  "form_reset",
  "form_submit",
  "tab_changed",
  "options_requested",
] as const);

/** Declared semantic event names this form and action family can emit. */
export type ControlSemanticEventName = (typeof CONTROL_EVENT_NAMES)[number];

/** A structured rich-text document a rich-text input collects. */
export type TypedRichTextDocument = NonNullable<RichTextInputPayload["value"]>;

/**
 * One declared semantic event. Fields also emit a marked change when a flow sets their value;
 * `form_ready` is emitted once when a form mounts. The bound flow, not the component,
 * decides what an event does; no component saves, queries or calls an application service.
 */
export type ControlSemanticEvent =
  | Readonly<{
      event: "action";
      intent: "activate" | "dismiss";
      /** An action button inside a form reports the form's current typed field values. */
      readValues?: () => Readonly<Record<string, TypedFieldValue>>;
    }>
  | Readonly<{
      event: "field_changed";
      fieldKey: string;
      value: TypedFieldValue;
      /** Display details already shown to this viewer for an in-memory draft. */
      draftDisplay?: Readonly<{
        title?: string;
        files?: readonly Readonly<{ fileId: string; name: string }>[];
      }>;
      origin: "user" | "flow";
      depth: number;
      /** Present for a flow-set change, so its next binding can enforce the cycle bound. */
      cycle?: FlowEventCycle;
      /** Choices, checkboxes and link selections settle as soon as they change. */
      immediate: boolean;
    }>
  | Readonly<{ event: "field_focus_lost"; fieldKey: string; value: TypedFieldValue }>
  | Readonly<{
      event: "options_requested";
      search?: string;
      continuationToken?: string;
      /** For a dependent link field: the record chosen in the field it depends on, in the form's draft. */
      parentRecordId?: string;
    }>
  | Readonly<{ event: "form_cancel"; gestureId: string }>
  | Readonly<{ event: "form_ready"; gestureId: string }>
  | Readonly<{ event: "form_reset"; gestureId: string }>
  | Readonly<{
      event: "form_submit";
      gestureId: string;
      readValues: () => Readonly<Record<string, TypedFieldValue>>;
      selectedOwnerGroupId?: string;
    }>
  | Readonly<{ event: "tab_changed"; tabKey: string }>;

/**
 * A control's callback. Only `options_requested` answers with data: the page runtime reads one page
 * of pickable records for the link input that asked and returns it, which the input reads
 * with {@link readRecordChoicePage}.
 */
export type ControlEventHandler = (event: ControlSemanticEvent) => void | Promise<unknown>;

/** Callbacks accepted by one control placement, keyed only by declared event name. */
export type ControlEventHandlers = Readonly<
  Partial<Record<ControlSemanticEventName, ControlEventHandler>>
>;

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

/**
 * One choice the browser offers: the stored value, its label and the colour role the definition gave
 * it. The placement's own setting list and a page's answer to an options request share this shape;
 * the role is absent when the definition declares none.
 */
export type ChoiceOption = Readonly<{ key: string; label: string; tone?: PipelineStageTone }>;

const maximumChoiceOptions = 200;
const choiceOptionTones: ReadonlySet<string> = new Set(pipelineStageTones);

/**
 * Bounded choice options, each key once so every option has one identity, with the option's colour
 * role when one is declared. A tone outside the theme's roles, or a repeated key, is a defect.
 */
export const parseChoiceOptions = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): readonly ChoiceOption[] => {
  if (!Array.isArray(value) || value.length > maximumChoiceOptions)
    return fail("Choice options are invalid", location);
  const keys = new Set<string>();
  return value.map((candidate, index): ChoiceOption => {
    const propertyPath = [`options[${index}]`];
    if (
      !isRecord(candidate) ||
      typeof candidate.key !== "string" ||
      candidate.key.length === 0 ||
      typeof candidate.label !== "string" ||
      (candidate.tone !== undefined &&
        (typeof candidate.tone !== "string" || !choiceOptionTones.has(candidate.tone)))
    )
      return fail("Choice options are invalid", { ...location, propertyPath });
    if (keys.has(candidate.key))
      return fail("Choice options are invalid: a choice option value repeats", {
        ...location,
        propertyPath,
      });
    keys.add(candidate.key);
    return {
      key: candidate.key,
      label: candidate.label,
      ...(candidate.tone === undefined ? {} : { tone: candidate.tone as PipelineStageTone }),
    };
  });
};

/**
 * One page of pickable records as the server answered a records request: an object with its
 * choices. The page is the server's typed reply and is not parsed again here.
 */
export const readRecordChoicePage = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): RecordChoicePage =>
  isRecord(value) && Array.isArray(value.choices)
    ? (value as RecordChoicePage)
    : fail("A record choice page is invalid", location);

/**
 * One page of the options a choice field offers as the page answered its options request: the
 * options (each a key and a label) and, when more exist, the position the next page starts at.
 */
export const readChoiceOptionsPage = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): Readonly<{ options: readonly ChoiceOption[]; nextContinuationToken?: string }> => {
  if (!isRecord(value)) return fail("A choice options page is invalid", location);
  const options = parseChoiceOptions(value.options, location);
  return typeof value.nextContinuationToken === "string"
    ? { options, nextContinuationToken: value.nextContinuationToken }
    : { options };
};

/**
 * One runtime input a control receives besides its data (a form's draft feedback or flow
 * feedback): absent, or the object the server's projection supplied for it.
 */
export const readControlSupply = <Supply>(
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation = {},
): Supply | undefined =>
  value === undefined ? undefined : isRecord(value) ? (value as Supply) : fail(message, location);

/** The keys each control state carries besides its status: exactly these, nothing else. */
const CONTROL_STATE_KEYS: Readonly<
  Record<string, Readonly<{ required: readonly string[]; optional: readonly string[] }>>
> = Object.freeze({
  loading: { required: [], optional: [] },
  disabled: { required: [], optional: ["reason"] },
  ready: { required: ["values"], optional: [] },
});

/**
 * One control's projected state. The renderer checks the closed envelope: a known status with
 * exactly its own keys (a disabled reason is non-blank text), and values only in the ready state.
 * The values are the payload the server checked against the control's contract where it built it;
 * the renderer does not parse them again, in the server render or in the browser.
 */
export const readControlData = <Values>(
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ControlDataState<Values> => {
  const state = isRecord(value) ? value : fail("Projected control data is invalid", location);
  const status = state.status;
  const keys =
    typeof status === "string" && Object.hasOwn(CONTROL_STATE_KEYS, status)
      ? CONTROL_STATE_KEYS[status]
      : undefined;
  if (keys === undefined) return fail("Projected control data has an unknown status", location);
  const allowed = new Set(["status", ...keys.required, ...keys.optional]);
  if (
    Object.keys(state).some((key) => !allowed.has(key)) ||
    keys.required.some((key) => !Object.hasOwn(state, key)) ||
    (state.reason !== undefined &&
      (typeof state.reason !== "string" || state.reason.trim().length === 0))
  )
    return fail("Projected control data is invalid", location);
  return status === "loading" ? LOADING_STATE : (state as ControlDataState<Values>);
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
