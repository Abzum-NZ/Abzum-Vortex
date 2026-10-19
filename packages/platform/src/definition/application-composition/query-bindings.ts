import type { ComponentSettingValue } from "./block-property-schema";
import {
  settingField,
  settingGroup,
  settingItems,
  settingText,
  type SettingsRecord,
} from "./records-table-features/shared";

/**
 * The data source of every query-bound block is `{ query, parameters }`: the placement's bound
 * query and one binding per query input, held in the block's `query_parameters` setting. A binding
 * names the input and the one source its value comes from. Every value is resolved on the server
 * for each request and reaches the Query engine as an input it validates again; a binding can only
 * choose a value the viewer's own access already allows to be read, never widen it.
 */
export const queryBindingSourceKinds = [
  "fixed",
  "page_parameter",
  "record_field",
  "current_person",
  "control",
  "relative_date",
  "this_row",
] as const;
export type QueryBindingSourceKind = (typeof queryBindingSourceKinds)[number];

/** The parts of the person viewing the page a binding may use. */
export const currentPersonParts = ["person"] as const;
export type CurrentPersonPart = (typeof currentPersonParts)[number];

/** The dates a relative date counts from, each in the organisation's time zone. */
export const relativeDateAnchors = [
  "today",
  "start_of_week",
  "start_of_month",
  "start_of_quarter",
  "start_of_year",
  "end_of_month",
] as const;
export type RelativeDateAnchor = (typeof relativeDateAnchors)[number];

export type QueryBindingSource =
  /** A value written for the input's type: exact decimal text, `true`/`false`, an ISO date. */
  | Readonly<{ kind: "fixed"; value: string }>
  /** A parameter the page declares (its subject `record_id`, or one a control publishes). */
  | Readonly<{ kind: "page_parameter"; name: string }>
  /** A field of the page's subject record, read under the viewer's current field policy. */
  | Readonly<{ kind: "record_field"; field: string }>
  /** The person viewing the page, taken from the session on the server. */
  | Readonly<{ kind: "current_person"; part: CurrentPersonPart }>
  /** A control on the same page; its value is the page parameter the control publishes. */
  | Readonly<{ kind: "control"; placement: string }>
  /** A date counted from an anchor on the server at request time. */
  | Readonly<{ kind: "relative_date"; anchor: RelativeDateAnchor; offsetDays: number }>
  /** Inside a row's related records only: the parent row's record, or one of its fields. */
  | Readonly<{ kind: "this_row"; field?: string }>;

export type QueryBinding = Readonly<{ input: string; source: QueryBindingSource }>;
export type QueryBindings = readonly QueryBinding[];

export type QueryBindingsRead =
  | Readonly<{ kind: "read"; bindings: QueryBindings }>
  /** An item that names no input, an unknown source or a source without its required part. */
  | Readonly<{ kind: "malformed"; index: number }>;

const choiceOf = <Choice extends string>(
  value: ComponentSettingValue | undefined,
  allowed: readonly Choice[],
): Choice | undefined =>
  value?.kind === "choice" && (allowed as readonly string[]).includes(value.value)
    ? (value.value as Choice)
    : undefined;

const sourceOf = (item: SettingsRecord): QueryBindingSource | undefined => {
  switch (choiceOf(item["source"], queryBindingSourceKinds)) {
    case "fixed": {
      const value = item["value"];
      return value?.kind === "text" ? { kind: "fixed", value: value.value } : undefined;
    }
    case "page_parameter": {
      const name = settingText(item["name"]);
      return name === undefined ? undefined : { kind: "page_parameter", name };
    }
    case "record_field": {
      const field = settingField(item["field"]);
      return field === undefined ? undefined : { kind: "record_field", field };
    }
    case "current_person": {
      const part = choiceOf(item["part"], currentPersonParts);
      return part === undefined ? undefined : { kind: "current_person", part };
    }
    case "control": {
      const placement = settingText(item["control_placement"]);
      return placement === undefined ? undefined : { kind: "control", placement };
    }
    case "relative_date": {
      const anchor = choiceOf(item["anchor"], relativeDateAnchors);
      const offset = item["offset_days"];
      return anchor === undefined || offset?.kind !== "number"
        ? undefined
        : { kind: "relative_date", anchor, offsetDays: offset.value };
    }
    case "this_row": {
      const field = settingField(item["field"]);
      return field === undefined ? { kind: "this_row" } : { kind: "this_row", field };
    }
    default:
      return undefined;
  }
};

/**
 * The one reader of a block's query bindings, for source and compiled settings alike. An absent
 * setting binds nothing; a malformed item is reported by its position, never skipped, so an input
 * is never silently left without the source its author gave it.
 */
export const readQueryBindings = (settings: SettingsRecord): QueryBindingsRead => {
  const items = settingItems(settings["query_parameters"]) ?? [];
  const bindings: QueryBinding[] = [];
  for (const [index, entry] of items.entries()) {
    const item = settingGroup(entry);
    const input = item === undefined ? undefined : settingText(item["input"]);
    const source = item === undefined ? undefined : sourceOf(item);
    if (input === undefined || source === undefined) return { kind: "malformed", index };
    bindings.push({ input, source });
  }
  return { kind: "read", bindings };
};

/** The address parameter a record page's subject is named by. */
export const PAGE_SUBJECT_PARAMETER = "record_id";

/** Address names the platform keeps for itself: the page subject and a guided form's step. */
const reservedPageParameters: ReadonlySet<string> = new Set([PAGE_SUBJECT_PARAMETER, "step"]);

/**
 * A page parameter name: a lower-case key, so it never collides with a block's own address state
 * (`<kind>.<placement>`), which always carries a dot.
 */
export const isPageParameterName = (name: string): boolean =>
  /^[a-z][a-z0-9_]{0,39}$/.test(name) && !reservedPageParameters.has(name);

/** The page parameter a control placement publishes: it reads and writes that address name. */
export const readPublishedParameter = (settings: SettingsRecord): string | undefined =>
  settingText(settings["publishes_parameter"]);

/** The authored message a block shows while a required input has no value, when it has one. */
export const readAwaitingMessage = (settings: SettingsRecord): string | undefined =>
  settingText(settings["awaiting_message"]);

/** The fixed text a block shows while a required input has no value and it has no own message. */
export const defaultAwaitingMessage = (
  inputLabel: string,
  blockTitle: string | undefined,
): string =>
  blockTitle === undefined || blockTitle.trim() === ""
    ? `Choose ${inputLabel} to see this.`
    : `Choose ${inputLabel} to see ${blockTitle.trim()}.`;

/** The input every binding of a block names, so a page knows which parameters a block depends on. */
export const queryBindingParameterNames = (
  bindings: QueryBindings,
  publishedBy: (placement: string) => string | undefined,
): readonly string[] => [
  ...new Set(
    bindings.flatMap((binding) => {
      if (binding.source.kind === "page_parameter") return [binding.source.name];
      if (binding.source.kind === "control") {
        const name = publishedBy(binding.source.placement);
        return name === undefined ? [] : [name];
      }
      return [];
    }),
  ),
];
