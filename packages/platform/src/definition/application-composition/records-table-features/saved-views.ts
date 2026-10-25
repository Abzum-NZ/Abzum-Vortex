import type { AuthoredGridView, GridViewDocument } from "../../../pages/grid-view-state";
import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  optionalNumber,
  optionalText,
  recordsTableColumnPins,
  recordsTableDensities,
  recordsTableSortDirections,
  requiredBoolean,
  requiredChoice,
  requiredField,
  requiredGroup,
  requiredItems,
  requiredText,
  type RecordsTableFeatureDefinition,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
} from "./shared";

export type RecordsTableSavedViewsSettings = Readonly<{
  defaultViews: readonly AuthoredGridView[];
  /** People may add their own conditional-format rules to the views they save. */
  personalFormatting: boolean;
}>;

/** Authored views compile their field references through the ordinary setting compiler. */
/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "saved_views",
  label: "Saved views",
  help: "Let people save, reopen and share views of the table",
  required: false,
  defaultValue: {
    kind: "group",
    properties: {
      enabled: {
        kind: "boolean",
        value: false,
      },
      personal_formatting: {
        kind: "boolean",
        value: false,
      },
      default_views: {
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
      help: "Let people save views",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "boolean",
      key: "personal_formatting",
      label: "Personal formatting",
      help: "Let people add their own highlighting rules to the views they save; needs Formatting on",
      required: true,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "list",
      key: "default_views",
      label: "Default views",
      help: "Default views",
      required: false,
      minimumItems: 0,
      maximumItems: 20,
      item: {
        kind: "group",
        key: "item",
        label: "Default views",
        help: "Default views",
        required: true,
        properties: [
          {
            kind: "text",
            key: "view_id",
            label: "View identity",
            help: "View identity",
            required: true,
            minLength: 36,
            maxLength: 36,
          },
          {
            kind: "text",
            key: "name",
            label: "Name",
            help: "Name",
            required: true,
            minLength: 1,
            maxLength: 80,
          },
          {
            kind: "text",
            key: "role",
            label: "Role",
            help: "Role",
            required: true,
            minLength: 1,
            maxLength: 120,
          },
          {
            kind: "boolean",
            key: "is_default",
            label: "Use by default",
            help: "Use by default",
            required: true,
            defaultValue: {
              kind: "boolean",
              value: true,
            },
          },
          {
            kind: "group",
            key: "state",
            label: "Saved state",
            help: "Table configuration",
            required: true,
            properties: [
              {
                kind: "list",
                key: "columns",
                label: "Columns",
                help: "Columns",
                required: true,
                minimumItems: 1,
                maximumItems: 200,
                item: {
                  kind: "group",
                  key: "item",
                  label: "Columns",
                  help: "Columns",
                  required: true,
                  properties: [
                    {
                      kind: "field_reference",
                      key: "field",
                      label: "Field",
                      help: "Field",
                      required: true,
                    },
                    {
                      kind: "boolean",
                      key: "visible",
                      label: "Visible",
                      help: "Visible",
                      required: true,
                      defaultValue: {
                        kind: "boolean",
                        value: true,
                      },
                    },
                    {
                      kind: "choice",
                      key: "pin",
                      label: "Pin",
                      help: "Pin",
                      required: true,
                      options: [
                        {
                          key: "start",
                          label: "Start",
                        },
                        {
                          key: "end",
                          label: "End",
                        },
                        {
                          key: "unpinned",
                          label: "Unpinned",
                        },
                      ],
                      defaultValue: {
                        kind: "choice",
                        value: "unpinned",
                      },
                    },
                    {
                      kind: "number",
                      key: "width",
                      label: "Width",
                      help: "Column width in pixels",
                      required: false,
                      integer: true,
                      minimum: 64,
                      maximum: 640,
                    },
                  ],
                },
              },
              {
                kind: "choice",
                key: "density",
                label: "Density",
                help: "Density",
                required: true,
                options: [
                  {
                    key: "comfortable",
                    label: "Comfortable",
                  },
                  {
                    key: "compact",
                    label: "Compact",
                  },
                ],
                defaultValue: {
                  kind: "choice",
                  value: "comfortable",
                },
              },
              {
                kind: "list",
                key: "sort",
                label: "Sort",
                help: "Sort",
                required: true,
                minimumItems: 0,
                maximumItems: 20,
                defaultValue: {
                  kind: "list",
                  items: [],
                },
                item: {
                  kind: "group",
                  key: "item",
                  label: "Sort",
                  help: "Sort",
                  required: true,
                  properties: [
                    {
                      kind: "field_reference",
                      key: "field",
                      label: "Field",
                      help: "Field",
                      required: true,
                    },
                    {
                      kind: "choice",
                      key: "direction",
                      label: "Direction",
                      help: "Direction",
                      required: true,
                      options: [
                        {
                          key: "ascending",
                          label: "Ascending",
                        },
                        {
                          key: "descending",
                          label: "Descending",
                        },
                      ],
                      defaultValue: {
                        kind: "choice",
                        value: "ascending",
                      },
                    },
                  ],
                },
              },
              {
                kind: "list",
                key: "filters",
                label: "Filters",
                help: "Filters",
                required: true,
                minimumItems: 0,
                maximumItems: 50,
                defaultValue: {
                  kind: "list",
                  items: [],
                },
                item: {
                  kind: "group",
                  key: "item",
                  label: "Filters",
                  help: "Filters",
                  required: true,
                  properties: [
                    {
                      kind: "field_reference",
                      key: "field",
                      label: "Field",
                      help: "Field",
                      required: true,
                    },
                    {
                      kind: "text",
                      key: "filter",
                      label: "Filter value",
                      help: "Filter value",
                      required: true,
                      minLength: 1,
                      maxLength: 4000,
                    },
                  ],
                },
              },
              {
                kind: "text",
                key: "search",
                label: "Search",
                help: "Quick search",
                required: false,
                minLength: 1,
                maxLength: 200,
              },
            ],
          },
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
  code: "definition_records_table_saved_views",
  order: 38,
  message: "Saved views need a field the bound query can sort or filter by.",
  guidance: "Select a sortable or filterable field in the bound query, or turn Saved views off.",
};

export const recordsTableSavedViewsFeature: RecordsTableFeatureDefinition<
  RecordsTableSavedViewsSettings,
  "saved_views"
> = {
  key: "saved_views",
  property: "savedViews",
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "unsupported",
  label: "Saved views",
  description: "Save, reopen and share views of the table",
  read: (group) => {
    if (!featureEnabled(group)) return { enabled: false };
    const defaultViews = requiredItems(group["default_views"], "default_views").map(
      (item, index): AuthoredGridView => {
        const at = `default_views[${index}]`;
        const view = requiredGroup(item, at);
        const state = requiredGroup(view["state"], `${at}.state`);
        const columns = requiredItems(state["columns"], `${at}.state.columns`).map(
          (columnItem, columnIndex): GridViewDocument["columns"][number] => {
            const columnAt = `${at}.state.columns[${columnIndex}]`;
            const column = requiredGroup(columnItem, columnAt);
            const width = optionalNumber(column["width"], `${columnAt}.width`);
            return {
              fieldId: requiredField(column["field"], `${columnAt}.field`),
              visible: requiredBoolean(column["visible"], `${columnAt}.visible`),
              pin: requiredChoice(column["pin"], recordsTableColumnPins, `${columnAt}.pin`),
              ...(width === undefined ? {} : { width }),
            };
          },
        );
        const sort = requiredItems(state["sort"], `${at}.state.sort`).map(
          (entryItem, entryIndex): GridViewDocument["sort"][number] => {
            const entryAt = `${at}.state.sort[${entryIndex}]`;
            const entry = requiredGroup(entryItem, entryAt);
            return {
              fieldId: requiredField(entry["field"], `${entryAt}.field`),
              direction: requiredChoice(
                entry["direction"],
                recordsTableSortDirections,
                `${entryAt}.direction`,
              ),
            };
          },
        );
        const filters = requiredItems(state["filters"], `${at}.state.filters`).map(
          (entryItem, entryIndex): GridViewDocument["filters"][number] => {
            const entryAt = `${at}.state.filters[${entryIndex}]`;
            const entry = requiredGroup(entryItem, entryAt);
            return {
              fieldId: requiredField(entry["field"], `${entryAt}.field`),
              filter: requiredText(entry["filter"], `${entryAt}.filter`),
            };
          },
        );
        return {
          viewId: requiredText(view["view_id"], `${at}.view_id`),
          name: requiredText(view["name"], `${at}.name`),
          role: requiredText(view["role"], `${at}.role`),
          isDefault: requiredBoolean(view["is_default"], `${at}.is_default`),
          document: {
            columns,
            density: requiredChoice(state["density"], recordsTableDensities, `${at}.state.density`),
            sort,
            filters,
            search: optionalText(state["search"], `${at}.state.search`) ?? null,
            formatting: [],
          },
        };
      },
    );
    return {
      enabled: true,
      defaultViews,
      personalFormatting: requiredBoolean(group["personal_formatting"], "personal_formatting"),
    };
  },
  // Personal rules are evaluated by the table's own formatting, so they need it on.
  conflicts: (state, _facts, { features }) =>
    state.enabled && state.personalFormatting && !features.conditionalFormatting.enabled
      ? featureNotPossible(
          featureRefusal,
          "People can only add their own formatting when Formatting is on for this table. Turn Formatting on, or turn personal formatting off.",
        )
      : undefined,
  // A view keeps the whole grid, so it is offered wherever the table enables it.
  project: (state) => (state.enabled ? true : undefined),
  check: (state, facts) => {
    if (!state.enabled) return featureAvailable;
    if (!facts.signedIn)
      return featureNotPossible(
        featureRefusal,
        "Saved views need people to be signed in on this page",
      );
    const defaults = new Set<string>();
    const ids = new Set<string>();
    for (const view of state.defaultViews) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(view.viewId) ||
        ids.has(view.viewId)
      )
        return featureNotPossible(featureRefusal, "Every default view needs a unique identity.");
      ids.add(view.viewId);
      if (view.isDefault && defaults.has(view.role))
        return featureNotPossible(featureRefusal, "Only one default view per role");
      if (view.isDefault) defaults.add(view.role);
      for (const field of [
        ...view.document.columns,
        ...view.document.sort,
        ...view.document.filters,
      ])
        if (!facts.fields.some((candidate) => candidate.field === field.fieldId))
          return featureNotPossible(
            featureRefusal,
            `${view.name} uses ${facts.unselectedFields?.find((candidate) => candidate.field === field.fieldId)?.label ?? field.fieldId}, which is not in the bound query`,
          );
    }
    return featureAvailable;
  },
};
