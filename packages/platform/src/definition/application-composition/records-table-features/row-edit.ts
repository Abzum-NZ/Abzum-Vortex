import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  optionalChoice,
  optionalText,
  projectedEditableFields,
  recordsTableDependencyMissing,
  recordsTableFieldNotEditableReason,
  requiredFieldList,
  type RecordsTableFeatureDefinition,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
} from "./shared";

export type RecordsTableRowEditSettings = Readonly<{
  eventId?: string;
  fields: readonly string[];
  trigger?: "button";
}>;

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "row_edit",
  label: "Row editing",
  help: "Edit the visible allowed fields of a row and save all changes together",
  required: false,
  defaultValue: {
    kind: "group",
    properties: {
      enabled: {
        kind: "boolean",
        value: false,
      },
      fields: {
        kind: "list",
        items: [],
      },
    },
  },
  properties: [
    {
      kind: "boolean",
      key: "enabled",
      label: "On",
      help: "Let people edit one row at a time",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "text",
      key: "event_id",
      label: "Event identity",
      help: "The action that saves a row; set by the workflow for a saved row",
      required: false,
      minLength: 1,
      maxLength: 60,
    },
    {
      kind: "list",
      key: "fields",
      label: "Editable fields",
      help: "Fields a person may change in place; each must be a column of the table",
      required: false,
      minimumItems: 0,
      maximumItems: 50,
      item: {
        kind: "field_reference",
        key: "field",
        label: "Field",
        help: "Field of the bound query edited in place",
        required: true,
        fieldTypes: [
          "text",
          "long_text",
          "whole_number",
          "decimal_number",
          "yes_no",
          "choice",
          "date",
          "date_time",
          "email_address",
          "phone_number",
          "web_address",
          "link",
        ],
      },
      defaultValue: {
        kind: "list",
        items: [],
      },
    },
    {
      kind: "choice",
      key: "trigger",
      label: "Start editing",
      help: "The row button opens all editable fields",
      required: false,
      options: [
        {
          key: "button",
          label: "Edit button",
        },
      ],
    },
  ],
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_row_edit",
  order: 39,
  message: "Row editing needs at least one stored field that people may change.",
  guidance:
    "Choose editable columns and name the action that saves the row, or turn Row editing off.",
};

export const recordsTableRowEditFeature: RecordsTableFeatureDefinition<
  RecordsTableRowEditSettings,
  "row_edit"
> = {
  key: "row_edit",
  property: "rowEdit",
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "unsupported",
  events: { row_edit: {} },
  label: "Row editing",
  description: "Change a row's fields and save them together",
  read: (group) => {
    if (!featureEnabled(group)) return { enabled: false };
    const eventId = optionalText(group["event_id"], "event_id");
    const trigger = optionalChoice(group["trigger"], ["button"], "trigger");
    return {
      enabled: true,
      ...(eventId === undefined ? {} : { eventId }),
      fields: requiredFieldList(group["fields"], "fields"),
      ...(trigger === undefined ? {} : { trigger }),
    };
  },
  project: (state, context) => {
    const fields = projectedEditableFields(state, context);
    return !state.enabled ||
      state.eventId === undefined ||
      state.trigger !== "button" ||
      fields.length === 0
      ? undefined
      : { eventId: state.eventId, trigger: state.trigger, fields };
  },
  check: (state, facts) => {
    if (facts.grouped || !facts.fields.some((field) => field.editable))
      return featureNotPossible(
        featureRefusal,
        `Row editing needs at least one stored field of ${facts.recordTypeLabel || "the record type"} that people may change`,
      );
    if (!state.enabled) return featureAvailable;
    if (state.eventId === undefined)
      return featureNotPossible(featureRefusal, "Name the action that saves the row");
    if (state.trigger !== "button")
      return featureNotPossible(featureRefusal, "Choose the button that starts editing a row");
    if (state.fields.length === 0)
      return featureNotPossible(featureRefusal, "Choose the fields people may change together");
    if (new Set(state.fields.map((field) => field.toLowerCase())).size !== state.fields.length)
      return featureNotPossible(featureRefusal, "Choose each editable field once");
    for (const chosen of state.fields) {
      const field = factsOf(facts, chosen);
      if (field === undefined)
        return featureNotPossible(
          featureRefusal,
          "Choose editable fields of the table's own query",
        );
      const reason = recordsTableFieldNotEditableReason(field);
      if (reason !== undefined) return featureNotPossible(featureRefusal, reason);
    }
    const missing = recordsTableDependencyMissing(facts, state.fields);
    if (missing !== undefined) return featureNotPossible(featureRefusal, missing);
    return featureAvailable;
  },
};

/** The control event declared by this feature. */
export const recordsTableRowEditEvent = Object.keys(
  recordsTableRowEditFeature.events!,
)[0] as typeof recordsTableRowEditFeature.key;
