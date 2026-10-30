import { Temporal } from "@js-temporal/polyfill";
import { CalendarEndpointError, calendarStartOfDay } from "./calendar-date";
import {
  parseQueryBindingText,
  queryInputValueType,
  queryBindingTypesFit,
  type QueryBindingValueType,
} from "../definition/application-composition/query-binding-values";
import {
  defaultAwaitingMessage,
  type QueryBinding,
  type QueryBindings,
  type RelativeDateAnchor,
} from "../definition/application-composition/query-bindings";
import type { JsonValue } from "../catalogue/common";
import type { InstalledRuntimeContext } from "../definition/installed-runtime-context";
import { recordIdSchema } from "../catalogue/identifiers";
import { recordLinkValueSchema } from "../records/module-field-values";

type DeclaredInput =
  InstalledRuntimeContext["releaseSet"]["modules"][number]["content"]["queries"][number]["inputs"][number];
type AddressParameters = Readonly<Record<string, string | readonly string[] | undefined>>;

/** The record a page or a row panel is about, as the server already read it for this request. */
export type QueryBindingRecordRead =
  | Readonly<{
      kind: "read";
      recordTypeId: string;
      recordId: string;
      values: Readonly<Record<string, JsonValue>>;
    }>
  /** The record was not readable to the viewer, or the page addresses none. */
  | Readonly<{ kind: "unreadable" }>;

/**
 * Everything a binding may read, all of it decided on the server for the current request: the
 * address, what the page declares, the record reads the page already makes, and the viewer.
 */
export type QueryBindingContext = Readonly<{
  /** The page address; only the names the page declares are ever read from it. */
  address: AddressParameters;
  /** The parameters this page declares, typed, in record type identities. */
  parameters: ReadonlyMap<string, QueryBindingValueType>;
  /** The parameter each control on the page publishes, by lower-cased placement identity. */
  controls: ReadonlyMap<string, string>;
  /** The page subject, read once per request; undefined on a page that is not a record page. */
  subject: (() => Promise<QueryBindingRecordRead>) | undefined;
  /** The parent row of a row's related records, which the server just authorised. */
  row?: QueryBindingRecordRead;
  /** The directory record of the viewer, derived only from the verified request and installation. */
  viewerPerson: Readonly<{ recordTypeId: string; recordId: string }> | undefined;
  /**
   * The group directory type and a reader of the viewer's active organisation groups, read inside
   * the verified request and only when a binding asks; undefined without the group directory.
   */
  viewerTeams:
    | Readonly<{
        recordTypeId: string;
        /** The group identities, or undefined when the read failed (already logged). */
        read: () => Promise<readonly string[] | undefined>;
      }>
    | undefined;
  /** The organisation the verified request runs in; the same server-derived scope as the page. */
  viewerOrganisation: string;
  /** The organisation's time zone, read only when a relative date needs it. */
  timeZone: () => Promise<string | undefined>;
  now: Date;
}>;

export type QueryBindingResolution =
  | Readonly<{ kind: "resolved"; inputValues: Readonly<Record<string, JsonValue>> }>
  /** A required input has no value yet: the block shows its message and reads nothing. */
  | Readonly<{ kind: "awaiting"; input: string; message: string }>
  /** A binding the server cannot honour, typed for the log; the block reads nothing. */
  | Readonly<{ kind: "refused"; part: string; reason: string }>;

type Resolved =
  | Readonly<{ kind: "value"; value: JsonValue }>
  | Readonly<{ kind: "missing"; cause?: string }>
  /** The viewer is in no team: the block reads nothing, optional input or not. */
  | Readonly<{ kind: "no_team" }>
  | Readonly<{ kind: "refused"; reason: string }>;

const firstValue = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === "string" ? value : value?.[0];

/** Validates invocation control values and overlays only their declared parameters on the address. */
export const bindInvocationControls = async (
  context: QueryBindingContext,
  candidates: Readonly<Record<string, string>>,
  validateOption: (placementId: string, value: string, parsed: JsonValue) => Promise<boolean>,
): Promise<QueryBindingContext | undefined> => {
  const supplied = new Map<string, string>();
  for (const [placement, value] of Object.entries(candidates)) {
    const key = placement.toLowerCase();
    // Other page controls can be dependency evidence; they never become query inputs here.
    if (!context.controls.has(key)) continue;
    if (supplied.has(key)) return undefined;
    supplied.set(key, value);
  }
  const address: Record<string, string | readonly string[] | undefined> = { ...context.address };
  const names = new Set<string>();
  for (const [placement, name] of context.controls) {
    if (names.has(name)) return undefined;
    names.add(name);
    delete address[name];
    const raw = supplied.get(placement);
    if (raw === undefined || raw === "") continue;
    const declared = context.parameters.get(name);
    const parsed = declared === undefined ? undefined : parseQueryBindingText(raw, declared);
    if (parsed === undefined || !(await validateOption(placement, raw, parsed))) return undefined;
    address[name] = raw;
  }
  return { ...context, address };
};

/** The calendar date an anchor names, counted in the time zone at `now`. */
export const relativeAnchorDate = (
  now: Date,
  timeZone: string,
  anchor: RelativeDateAnchor,
): Temporal.PlainDate => {
  const today = Temporal.Instant.fromEpochMilliseconds(now.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
  switch (anchor) {
    case "today":
      return today;
    case "start_of_week":
      // Weeks start on Monday.
      return today.subtract({ days: today.dayOfWeek - 1 });
    case "start_of_month":
      return today.with({ day: 1 });
    case "start_of_quarter":
      return today.with({ month: today.month - ((today.month - 1) % 3), day: 1 });
    case "start_of_year":
      return today.with({ month: 1, day: 1 });
    case "end_of_month":
      return today.with({ day: today.daysInMonth });
  }
};

/** A stored field value as an input value: it must already be a value of the input's type. */
const fieldValue = (value: JsonValue | undefined, type: QueryBindingValueType): Resolved => {
  if (value === undefined) return { kind: "missing", cause: "record_field_withheld" };
  if (value === null || value === "") return { kind: "missing" };
  if (type.kind === "record") {
    const link = recordLinkValueSchema.safeParse(value);
    return link.success &&
      type.recordTypes.some(
        (accepted) => accepted.toLowerCase() === String(link.data.recordTypeId).toLowerCase(),
      )
      ? {
          kind: "value",
          value: {
            recordTypeId: String(link.data.recordTypeId),
            recordId: String(link.data.recordId),
          },
        }
      : { kind: "refused", reason: "record_field_type_mismatch" };
  }
  if (typeof value === "string") {
    const parsed = parseQueryBindingText(value, type);
    return parsed === undefined
      ? { kind: "refused", reason: "record_field_type_mismatch" }
      : { kind: "value", value: parsed };
  }
  if (type.kind === "whole_number" && typeof value === "number" && Number.isSafeInteger(value))
    return { kind: "value", value };
  if (type.kind === "yes_no" && typeof value === "boolean") return { kind: "value", value };
  if (type.kind === "money" || type.kind === "formatted_text") return { kind: "value", value };
  return { kind: "refused", reason: "record_field_type_mismatch" };
};

const resolveOne = async (
  binding: QueryBinding,
  type: QueryBindingValueType,
  context: QueryBindingContext,
): Promise<Resolved> => {
  const fromAddress = (name: string): Resolved => {
    const declared = context.parameters.get(name);
    if (declared === undefined) return { kind: "refused", reason: "parameter_not_declared" };
    const raw = firstValue(context.address[name]);
    if (raw === undefined || raw === "") return { kind: "missing" };
    // A record parameter is read as the record type it declares, any other value as the input's
    // type (publication matched the two); the Query engine then validates it against the input.
    const value = parseQueryBindingText(raw, declared.kind === "record" ? declared : type);
    return value === undefined
      ? { kind: "refused", reason: "parameter_value_invalid" }
      : { kind: "value", value };
  };
  const source = binding.source;
  switch (source.kind) {
    case "fixed_record": {
      const recordId = recordIdSchema.safeParse(source.recordId);
      return type.kind === "record" &&
        recordId.success &&
        type.recordTypes.some(
          (accepted) => accepted.toLowerCase() === source.recordType.toLowerCase(),
        )
        ? {
            kind: "value",
            value: { recordTypeId: source.recordType, recordId: String(recordId.data) },
          }
        : { kind: "refused", reason: "fixed_record_invalid" };
    }
    case "fixed": {
      // A record is chosen as a record, with its type, never written as text.
      if (type.kind === "record") return { kind: "refused", reason: "fixed_record_required" };
      const value = parseQueryBindingText(source.value, type);
      return value === undefined
        ? { kind: "refused", reason: "fixed_value_invalid" }
        : { kind: "value", value };
    }
    case "page_parameter":
      // A control's value is bound through the control, as publication requires.
      return [...context.controls.values()].includes(source.name)
        ? { kind: "refused", reason: "parameter_published_by_control" }
        : fromAddress(source.name);
    case "control": {
      const name = context.controls.get(source.placement.toLowerCase());
      return name === undefined
        ? { kind: "refused", reason: "control_not_on_page" }
        : fromAddress(name);
    }
    case "record_field": {
      if (context.subject === undefined) return { kind: "refused", reason: "not_a_record_page" };
      const subject = await context.subject();
      if (subject.kind !== "read") return { kind: "missing", cause: "record_unreadable" };
      const held = Object.entries(subject.values).find(
        ([fieldId]) => fieldId.toLowerCase() === source.field.toLowerCase(),
      );
      return fieldValue(held?.[1], type);
    }
    case "current_person":
      if (source.part === "organisation")
        return type.kind === "text"
          ? { kind: "value", value: context.viewerOrganisation }
          : { kind: "refused", reason: "current_organisation_type_mismatch" };
      if (source.part === "team") {
        if (context.viewerTeams === undefined)
          return { kind: "refused", reason: "viewer_teams_unavailable" };
        if (
          !queryBindingTypesFit(type, {
            kind: "record",
            recordTypes: [context.viewerTeams.recordTypeId],
          })
        )
          return { kind: "refused", reason: "current_team_type_mismatch" };
        const groupIds = await context.viewerTeams.read();
        if (groupIds === undefined) return { kind: "refused", reason: "viewer_teams_unavailable" };
        // No team: the block reads nothing and shows its awaiting message, even for an optional
        // input, because leaving the input out would widen the read beyond the viewer's team. An
        // input holds one value, so a viewer in several teams is refused, never guessed for.
        if (groupIds.length === 0) return { kind: "no_team" };
        if (groupIds.length > 1) return { kind: "refused", reason: "current_team_ambiguous" };
        return {
          kind: "value",
          value: { recordTypeId: context.viewerTeams.recordTypeId, recordId: groupIds[0]! },
        };
      }
      return context.viewerPerson === undefined
        ? { kind: "refused", reason: "viewer_person_unavailable" }
        : !queryBindingTypesFit(type, {
              kind: "record",
              recordTypes: [context.viewerPerson.recordTypeId],
            })
          ? { kind: "refused", reason: "current_person_type_mismatch" }
          : { kind: "value", value: context.viewerPerson };
    case "relative_date": {
      const timeZone = await context.timeZone();
      if (timeZone === undefined) return { kind: "refused", reason: "time_zone_unavailable" };
      const date = relativeAnchorDate(context.now, timeZone, source.anchor).add({
        days: source.offsetDays,
      });
      // Date-time bindings use the same organisation-day boundary as Calendar and filters.
      try {
        return {
          kind: "value",
          value:
            type.kind === "date_time"
              ? calendarStartOfDay(date.toString(), timeZone)
              : date.toString(),
        };
      } catch (error) {
        if (!(error instanceof CalendarEndpointError)) throw error;
        return { kind: "refused", reason: "calendar_range_unsupported" };
      }
    }
    case "this_row": {
      const row = context.row;
      if (row === undefined) return { kind: "refused", reason: "row_unavailable" };
      if (row.kind !== "read") return { kind: "missing", cause: "row_unreadable" };
      if (source.field === undefined)
        return fieldValue({ recordTypeId: row.recordTypeId, recordId: row.recordId }, type);
      const held = Object.entries(row.values).find(
        ([fieldId]) => fieldId.toLowerCase() === source.field!.toLowerCase(),
      );
      return fieldValue(held?.[1], type);
    }
  }
};

/**
 * The one binding resolver. Every block reader, the Records table command, the board read, a row
 * panel's read and the select-all descriptor take their query inputs from it. Each declared input
 * is filled only from its own binding, resolved on the server for this request: a value of the
 * wrong type or from an undeclared address name is refused, never guessed. An optional input with
 * no value is left out, so the Query engine binds it as empty; a required input with no value
 * yields the block's awaiting state and no query runs.
 */
export const resolveQueryBindings = async (
  bindings: QueryBindings,
  declaredInputs: readonly DeclaredInput[],
  context: QueryBindingContext,
  block: Readonly<{ title?: string; awaitingMessage?: string }>,
  log: (cause: string) => void = () => undefined,
): Promise<QueryBindingResolution> => {
  const inputValues: Record<string, JsonValue> = {};
  for (const binding of bindings)
    if (!declaredInputs.some((input) => input.key === binding.input))
      return { kind: "refused", part: `input:${binding.input}`, reason: "input_not_declared" };
  for (const input of declaredInputs) {
    const binding = bindings.find((candidate) => candidate.input === input.key);
    const type = queryInputValueType({
      type: input.type,
      ...(input.type === "record_reference"
        ? {
            recordTypes: input.recordTypes.flatMap((recordType) =>
              recordType.state === "resolved" ? [String(recordType.recordTypeId)] : [],
            ),
          }
        : {}),
    });
    if (binding === undefined) {
      if (input.required)
        return { kind: "refused", part: `input:${input.key}`, reason: "input_not_bound" };
      continue;
    }
    if (type === undefined)
      return { kind: "refused", part: `input:${input.key}`, reason: "input_type_unbindable" };
    const resolved = await resolveOne(binding, type, context);
    if (resolved.kind === "refused")
      return { kind: "refused", part: `input:${input.key}`, reason: resolved.reason };
    if (resolved.kind === "no_team")
      return {
        kind: "awaiting",
        input: input.key,
        message: block.awaitingMessage ?? defaultAwaitingMessage(input.label, block.title),
      };
    if (resolved.kind === "missing") {
      if (resolved.cause !== undefined) log(`input:${input.key} ${resolved.cause}`);
      if (!input.required) continue;
      return {
        kind: "awaiting",
        input: input.key,
        message: block.awaitingMessage ?? defaultAwaitingMessage(input.label, block.title),
      };
    }
    inputValues[input.key] = resolved.value;
  }
  return { kind: "resolved", inputValues };
};
