import type {
  BlockPropertyValueV2Contract,
  ComponentSemanticEventKind,
  PlatformBlockReleaseV2,
} from "@vortex/contracts";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";

/**
 * Declared semantic event names for form and action controls.
 * Every name is an exact variant of ComponentSemanticEventKind from application-flow-bindings.
 */
export const CONTROL_EVENT_NAMES = Object.freeze([
  "action",
  "field_changed",
  "form_ready",
  "form_reset",
  "form_submit",
  "tab_changed",
  "guided_step_changed",
] as const);

export type ControlSemanticEventName = (typeof CONTROL_EVENT_NAMES)[number];

/**
 * Closed set of typed values that can be collected or emitted by form field inputs.
 */
export type TypedFieldValue = string | number | boolean | null;

/**
 * Declared semantic events emitted by form and action controls.
 * Emitted only upon deliberate user interaction or lifecycle completion.
 */
export type ControlSemanticEvent =
  | Readonly<{ event: "action"; actionKey?: string }>
  | Readonly<{ event: "field_changed"; fieldKey: string; value: TypedFieldValue }>
  | Readonly<{ event: "form_ready"; formId?: string }>
  | Readonly<{ event: "form_reset"; formId?: string }>
  | Readonly<{
      event: "form_submit";
      formId?: string;
      values?: Readonly<Record<string, TypedFieldValue>>;
    }>
  | Readonly<{ event: "tab_changed"; tabKey: string }>
  | Readonly<{ event: "guided_step_changed"; stepId: string }>;

export type ControlEventHandler = (event: ControlSemanticEvent) => void;

/** Callbacks accepted by one control placement, keyed only by declared event name. */
export type ControlEventHandlers = Readonly<
  Partial<Record<ControlSemanticEventName, ControlEventHandler>>
>;

/** One choice option available in a choice input. */
export type ChoiceOption = Readonly<{ key: string; label: string }>;

/** Closed projected payload shapes for each control block. */
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
  | Readonly<{ kind: "button"; loading?: boolean; disabled?: boolean }>
  | Readonly<{ kind: "tabs"; activeTab?: string }>
  | Readonly<{ kind: "dialog"; open?: boolean }>
  | Readonly<{ kind: "drawer"; open?: boolean }>
  | Readonly<{
      kind: "form";
      values?: Readonly<Record<string, TypedFieldValue>>;
      errors?: Readonly<Record<string, string>>;
    }>;

export type ProjectedControlValueKind = ProjectedControlValues["kind"];

/**
 * Data-safe state passed for one control placement.
 */
export type ProjectedControlData =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "disabled"; reason?: string }>
  | Readonly<{ status: "ready"; values: ProjectedControlValues }>;

/** Permission-projected control data keyed by stable placement identity. */
export type ProjectedControlDataByPlacement = Readonly<Record<string, ProjectedControlData>>;

/** Semantic callbacks keyed by stable placement identity. */
export type ControlEventsByPlacement = Readonly<Record<string, ControlEventHandlers>>;

const fail = (message: string, location: DefinitionRenderErrorLocation): never => {
  throw new DefinitionRenderError("INVALID_COMPOSITION", message, location);
};

const requireRecord = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(message, location);
  return value as Record<string, unknown>;
};

const requireString = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  if (typeof value !== "string") fail(message, location);
  return value;
};

/**
 * Reads the authored accessible name only through the block's declared
 * `accessibleNamePropertyPath`; it never guesses a setting from its key.
 * Returns undefined when the block declares no name or the optional name is absent.
 */
export function getAccessibleName(
  settings: Readonly<Record<string, BlockPropertyValueV2Contract>>,
  metadata: PlatformBlockReleaseV2,
): string | undefined {
  const capabilities = metadata.capabilities;
  if (capabilities.accessibleName === "not_applicable") return undefined;
  let current: Readonly<Record<string, BlockPropertyValueV2Contract>> = settings;
  const path = capabilities.accessibleNamePropertyPath;
  for (const [index, key] of path.entries()) {
    const value = Object.hasOwn(current, key) ? current[key] : undefined;
    if (value === undefined) return undefined;
    if (index === path.length - 1)
      return value.kind === "text" && value.value.trim().length > 0 ? value.value.trim() : undefined;
    if (value.kind !== "group") return undefined;
    current = value.properties;
  }
  return undefined;
}

const parseChoiceOption = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): ChoiceOption => {
  const record = requireRecord(value, "Choice option must be an object", location);
  const key = requireString(record.key, "Choice option key must be a string", location);
  const label = requireString(record.label, "Choice option label must be a string", location);
  return Object.freeze({ key, label });
};

const parseProjectedControlValues = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): ProjectedControlValues => {
  const record = requireRecord(value, "Projected control values must be an object", location);
  const kind = record.kind;

  switch (kind) {
    case "text_input": {
      const error = record.error === undefined ? undefined : requireString(record.error, "Error must be a string", location);
      const val = record.value === undefined ? undefined : requireString(record.value, "Value must be a string", location);
      return Object.freeze({
        kind: "text_input" as const,
        ...(val === undefined ? {} : { value: val }),
        ...(error === undefined ? {} : { error }),
      });
    }
    case "number_input": {
      const error = record.error === undefined ? undefined : requireString(record.error, "Error must be a string", location);
      let val: number | null | undefined = undefined;
      if (record.value !== undefined) {
        if (record.value === null) val = null;
        else if (typeof record.value === "number" && Number.isFinite(record.value)) val = record.value;
        else fail("Number input value must be a finite number or null", location);
      }
      return Object.freeze({
        kind: "number_input" as const,
        ...(val === undefined ? {} : { value: val }),
        ...(error === undefined ? {} : { error }),
      });
    }
    case "boolean_input": {
      const error = record.error === undefined ? undefined : requireString(record.error, "Error must be a string", location);
      const val = record.value === undefined ? undefined : Boolean(record.value);
      return Object.freeze({
        kind: "boolean_input" as const,
        ...(val === undefined ? {} : { value: val }),
        ...(error === undefined ? {} : { error }),
      });
    }
    case "date_input": {
      const error = record.error === undefined ? undefined : requireString(record.error, "Error must be a string", location);
      const val = record.value === undefined ? undefined : record.value === null ? null : requireString(record.value, "Date value must be a string or null", location);
      return Object.freeze({
        kind: "date_input" as const,
        ...(val === undefined ? {} : { value: val }),
        ...(error === undefined ? {} : { error }),
      });
    }
    case "choice_input": {
      const error = record.error === undefined ? undefined : requireString(record.error, "Error must be a string", location);
      const val = record.value === undefined ? undefined : record.value === null ? null : requireString(record.value, "Choice value must be a string or null", location);
      let options: readonly ChoiceOption[] | undefined = undefined;
      if (record.options !== undefined) {
        if (!Array.isArray(record.options)) fail("Choice options must be an array", location);
        options = Object.freeze(record.options.map((opt) => parseChoiceOption(opt, location)));
      }
      return Object.freeze({
        kind: "choice_input" as const,
        ...(val === undefined ? {} : { value: val }),
        ...(options === undefined ? {} : { options }),
        ...(error === undefined ? {} : { error }),
      });
    }
    case "validation": {
      if (!Array.isArray(record.errors)) fail("Validation errors must be an array", location);
      const errors = Object.freeze(record.errors.map((err) => requireString(err, "Validation error must be a string", location)));
      return Object.freeze({ kind: "validation" as const, errors });
    }
    case "button": {
      const loading = record.loading === undefined ? undefined : Boolean(record.loading);
      const disabled = record.disabled === undefined ? undefined : Boolean(record.disabled);
      return Object.freeze({
        kind: "button" as const,
        ...(loading === undefined ? {} : { loading }),
        ...(disabled === undefined ? {} : { disabled }),
      });
    }
    case "tabs": {
      const activeTab = record.activeTab === undefined ? undefined : requireString(record.activeTab, "Active tab must be a string", location);
      return Object.freeze({
        kind: "tabs" as const,
        ...(activeTab === undefined ? {} : { activeTab }),
      });
    }
    case "dialog": {
      const open = record.open === undefined ? undefined : Boolean(record.open);
      return Object.freeze({
        kind: "dialog" as const,
        ...(open === undefined ? {} : { open }),
      });
    }
    case "drawer": {
      const open = record.open === undefined ? undefined : Boolean(record.open);
      return Object.freeze({
        kind: "drawer" as const,
        ...(open === undefined ? {} : { open }),
      });
    }
    case "form": {
      let values: Readonly<Record<string, TypedFieldValue>> | undefined = undefined;
      if (record.values !== undefined) {
        const valuesRec = requireRecord(record.values, "Form values must be an object", location);
        const parsedVals: Record<string, TypedFieldValue> = {};
        for (const [k, v] of Object.entries(valuesRec)) {
          if (v === null || typeof v === "string" || typeof v === "boolean") parsedVals[k] = v;
          else if (typeof v === "number" && Number.isFinite(v)) parsedVals[k] = v;
          else fail(`Form field value for '${k}' must be typed (string, number, boolean, null)`, location);
        }
        values = Object.freeze(parsedVals);
      }
      let errors: Readonly<Record<string, string>> | undefined = undefined;
      if (record.errors !== undefined) {
        const errorsRec = requireRecord(record.errors, "Form errors must be an object", location);
        const parsedErrs: Record<string, string> = {};
        for (const [k, v] of Object.entries(errorsRec)) {
          parsedErrs[k] = requireString(v, `Form error for '${k}' must be a string`, location);
        }
        errors = Object.freeze(parsedErrs);
      }
      return Object.freeze({
        kind: "form" as const,
        ...(values === undefined ? {} : { values }),
        ...(errors === undefined ? {} : { errors }),
      });
    }
    default:
      return fail(`Unknown projected control value kind '${String(kind)}'`, location);
  }
};

/**
 * Fail-closed parser for projected control data.
 */
export const parseProjectedControlData = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ProjectedControlData => {
  const record = requireRecord(value, "Projected control data must be an object", location);
  const status = record.status;
  if (status === "loading") return Object.freeze({ status: "loading" as const });
  if (status === "disabled") {
    const reason = record.reason === undefined ? undefined : requireString(record.reason, "Disabled reason must be a string", location);
    return Object.freeze({
      status: "disabled" as const,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  if (status === "ready") {
    return Object.freeze({
      status: "ready" as const,
      values: parseProjectedControlValues(record.values, location),
    });
  }
  return fail(`Unknown projected control status '${String(status)}'`, location);
};

const EMPTY_CONTROL_HANDLERS: ControlEventHandlers = Object.freeze({});

/**
 * Validates unknown callback bag into a typed ControlEventHandlers record, fail-closed.
 */
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
