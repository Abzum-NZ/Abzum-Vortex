import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  optionalText,
  projectedEditableFields,
  recordsTableDependencyMissing,
  recordsTableFieldNotEditableReason,
  requiredFieldList,
  type RecordsTableFeatureDefinition,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
} from "./shared";

/**
 * Inline editing: people change chosen fields in place; one flow binding (`eventId`) commits each
 * change. `eventId` is absent until the builder binds the action that saves a change, which the
 * check refuses.
 */
export type RecordsTableInlineEditSettings = Readonly<{
  eventId?: string;
  fields: readonly string[];
}>;

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "inline_edit",
  label: "Inline editing",
  help: "Change chosen values in place; a commit is held as a binding to a flow",
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
      help: "Let people change values in place",
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
      help: "The action that saves a change; it is set when the workflow for an edited value is added",
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
  ],
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_inline_edit",
  order: 39,
  message: "Inline editing needs at least one stored field that people may change.",
  guidance:
    "Choose stored fields shown as columns (calculated and system fields cannot be edited here) and add the workflow that saves a change, or turn Inline editing off.",
};

export const recordsTableInlineEditFeature: RecordsTableFeatureDefinition<
  RecordsTableInlineEditSettings,
  "inline_edit"
> &
  Readonly<{ property: "inlineEdit" }> = {
  key: "inline_edit",
  property: "inlineEdit",
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "unsupported",
  events: { inline_edit: {} },
  label: "Inline editing",
  description: "Change chosen values in place",
  read: (group) => {
    if (!featureEnabled(group)) return { enabled: false };
    const eventId = optionalText(group["event_id"], "event_id");
    return {
      enabled: true,
      ...(eventId === undefined ? {} : { eventId }),
      fields: requiredFieldList(group["fields"], "fields"),
    };
  },
  project: (state, context) => {
    const fields = projectedEditableFields(state, context);
    return !state.enabled || state.eventId === undefined || fields.length === 0
      ? undefined
      : { eventId: state.eventId, fields };
  },
  // Every chosen field must be a stored value people may change, and a change needs the action
  // that saves it; a grouped query has no records to change.
  conflicts: (_state, _facts, { presentation }) =>
    presentation === "cards"
      ? featureNotPossible(
          featureRefusal,
          "Inline editing needs the Table preset. Open a record to edit it from a List.",
        )
      : undefined,
  check: (state, facts) => {
    const needed = featureNotPossible(
      featureRefusal,
      `Inline editing needs at least one stored field of ${facts.recordTypeLabel || "the record type"} that people may change`,
    );
    if (facts.grouped || !facts.fields.some((field) => field.editable)) return needed;
    if (!state.enabled) return featureAvailable;
    const reasons: string[] = [];
    if (state.eventId === undefined) reasons.push("Add the flow that saves a change.");
    if (state.fields.length === 0) reasons.push("Choose the fields people may change in place.");
    for (const chosen of state.fields) {
      const field = factsOf(facts, chosen);
      if (field === undefined) {
        reasons.push("Choose editable fields of the table's own query.");
        continue;
      }
      const reason = recordsTableFieldNotEditableReason(field);
      if (reason !== undefined) reasons.push(reason);
    }
    const missing = recordsTableDependencyMissing(facts, state.fields);
    if (missing !== undefined) reasons.push(missing);
    return reasons.length === 0 ? featureAvailable : featureNotPossible(featureRefusal, reasons);
  },
};

/** The control event declared by this feature. */
export const recordsTableInlineEditEvent = Object.keys(
  recordsTableInlineEditFeature.events!,
)[0] as typeof recordsTableInlineEditFeature.key;
