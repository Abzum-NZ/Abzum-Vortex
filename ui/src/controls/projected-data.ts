import { builderKeySchema, type ComponentSemanticEventKind } from "@vortex/contracts";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";

/** Declared semantic event names this form and action family can emit. */
export type ControlSemanticEventName = Extract<
  ComponentSemanticEventKind,
  "action" | "field_changed" | "form_ready" | "form_reset" | "form_submit" | "tab_changed"
>;

/** Every event name any control accepts; each block further narrows this to its own declaration. */
export const CONTROL_EVENT_NAMES: readonly ControlSemanticEventName[] = Object.freeze([
  "action",
  "field_changed",
  "form_ready",
  "form_reset",
  "form_submit",
  "tab_changed",
]);

/** Closed set of typed values that form field inputs collect and emit. */
export type TypedFieldValue = string | number | boolean | null;

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

/** Closed projected payload shapes, one per control block. */
export type ProjectedControlValues =
  | Readonly<{ kind: "text_input"; value?: string; error?: string }>
  | Readonly<{ kind: "number_input"; value?: number | null; error?: string }>
  | Readonly<{ kind: "boolean_input"; value?: boolean; error?: string }>
  | Readonly<{ kind: "date_input"; value?: string | null; error?: string }>
  | Readonly<{
      kind: "choice_input";
      value?: string | null;
      options?: readonly ChoiceOption[];
      error?: string;
    }>
  | Readonly<{ kind: "validation"; errors: readonly string[] }>
  | Readonly<{ kind: "button" }>
  | Readonly<{ kind: "tabs"; activeTab?: string }>
  | Readonly<{ kind: "dialog"; open: boolean }>
  | Readonly<{ kind: "drawer"; open: boolean }>
  | Readonly<{ kind: "form" }>;

export type ProjectedControlValueKind = ProjectedControlValues["kind"];

/**
 * Explicit, data-safe state passed for one control placement. `loading` means the control's
 * data or a submission it started is pending, so it cannot be activated again; `disabled`
 * carries an optional safe reason; only `ready` carries values.
 */
export type ProjectedControlData =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "disabled"; reason?: string }>
  | Readonly<{ status: "ready"; values: ProjectedControlValues }>;

/** Permission-projected control data keyed by stable placement identity. */
export type ProjectedControlDataByPlacement = Readonly<Record<string, ProjectedControlData>>;

/** Semantic callbacks keyed by stable placement identity. */
export type ControlEventsByPlacement = Readonly<Record<string, ControlEventHandlers>>;

const LOADING_STATE: ProjectedControlData = Object.freeze({ status: "loading" });
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

const parseProjectedControlValues = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): ProjectedControlValues => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  switch (record.kind) {
    case "text_input":
      requireExactKeys(record, ["kind", "value", "error"], location);
      return Object.freeze({
        kind: "text_input",
        ...(record.value === undefined
          ? {}
          : { value: requireString(record.value, "A text value must be text", location) }),
        ...optionalError(record, location),
      });
    case "number_input": {
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
    }
    case "boolean_input":
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
    case "date_input": {
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
    }
    case "choice_input": {
      requireExactKeys(record, ["kind", "value", "options", "error"], location);
      const options =
        record.options === undefined ? undefined : parseChoiceOptions(record.options, location);
      if (record.value !== undefined && record.value !== null) {
        const key = requireBuilderKey(
          record.value,
          "A choice value must be an option key",
          location,
        );
        if (options !== undefined && !options.some((option) => option.key === key))
          fail(`Choice value '${key}' is not a projected option`, location);
      }
      return Object.freeze({
        kind: "choice_input",
        ...(record.value === undefined ? {} : { value: record.value as string | null }),
        ...(options === undefined ? {} : { options }),
        ...optionalError(record, location),
      });
    }
    case "validation": {
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
    }
    case "button":
      requireExactKeys(record, ["kind"], location);
      return Object.freeze({ kind: "button" });
    case "tabs":
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
    case "dialog":
      requireExactKeys(record, ["kind", "open"], location);
      return Object.freeze({
        kind: "dialog",
        open: requireBoolean(record.open, "Open state must be true or false", location),
      });
    case "drawer":
      requireExactKeys(record, ["kind", "open"], location);
      return Object.freeze({
        kind: "drawer",
        open: requireBoolean(record.open, "Open state must be true or false", location),
      });
    case "form":
      requireExactKeys(record, ["kind"], location);
      return Object.freeze({ kind: "form" });
    default:
      return fail(`Unknown projected control value kind '${String(record.kind)}'`, location);
  }
};

/**
 * Validates unknown projected control data for one placement and returns its frozen
 * fail-closed shape. Throws a located definition error for unknown or malformed input.
 */
export const parseProjectedControlData = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ProjectedControlData => {
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
        values: parseProjectedControlValues(record.values, location),
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

const parseKeyedRecords = <Value>(
  value: unknown,
  location: DefinitionRenderErrorLocation,
  parse: (entry: unknown, entryLocation: DefinitionRenderErrorLocation) => Value,
  message: string,
): Readonly<Record<string, Value>> => {
  if (value === undefined) return Object.freeze({});
  const record = requireRecord(value, message, location);
  // Own data properties only: a supplied "__proto__" key stays an ordinary (unknown) key.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(record).map(([placementId, entry]) => {
        if (placementId.trim().length === 0)
          fail("A control surface key must be a non-empty placement identity", location);
        return [placementId, parse(entry, { ...location, placementId })] as const;
      }),
    ),
  );
};

/** Validates unknown control data keyed by stable placement identity. */
export const parseProjectedControlDataByPlacement = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ProjectedControlDataByPlacement =>
  parseKeyedRecords(
    value,
    location,
    (entry, entryLocation) => parseProjectedControlData(entry, entryLocation),
    "Projected control data must be keyed by placement identity",
  );

/** Validates unknown semantic callbacks keyed by stable placement identity. */
export const parseControlEventsByPlacement = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ControlEventsByPlacement =>
  parseKeyedRecords(
    value,
    location,
    (entry, entryLocation) => parseControlEventHandlers(entry, entryLocation),
    "Control semantic callbacks must be keyed by placement identity",
  );

/**
 * Rejects projection or callback entries that do not name a placement in the resolved tree.
 * Absent entries are allowed; a supplied entry must resolve to an exact stable identity.
 */
export const assertControlProjectionKeysArePlacements = (
  placementIds: ReadonlySet<string>,
  controlData: unknown,
  controlEvents: unknown,
  location: DefinitionRenderErrorLocation = {},
): void => {
  const dataKeys =
    controlData === undefined
      ? []
      : Object.keys(
          requireRecord(
            controlData,
            "Projected control data must be keyed by placement identity",
            location,
          ),
        );
  const eventKeys =
    controlEvents === undefined
      ? []
      : Object.keys(
          requireRecord(
            controlEvents,
            "Control semantic callbacks must be keyed by placement identity",
            location,
          ),
        );
  for (const placementId of dataKeys) {
    if (!placementIds.has(placementId))
      fail(`Projected control data names unknown placement '${placementId}'`, {
        ...location,
        placementId,
      });
  }
  for (const placementId of eventKeys) {
    if (!placementIds.has(placementId))
      fail(`Control events name unknown placement '${placementId}'`, {
        ...location,
        placementId,
      });
  }
};
