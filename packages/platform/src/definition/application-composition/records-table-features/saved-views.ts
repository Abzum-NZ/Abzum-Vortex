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
} from "./shared";

export type RecordsTableSavedViewsSettings = Readonly<{
  defaultViews: readonly AuthoredGridView[];
  /** People may add their own conditional-format rules to the views they save. */
  personalFormatting: boolean;
}>;

/** Authored views compile their field references through the ordinary setting compiler. */
export const recordsTableSavedViewsFeature: RecordsTableFeatureDefinition<RecordsTableSavedViewsSettings> =
  {
    key: "saved_views",
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
              density: requiredChoice(
                state["density"],
                recordsTableDensities,
                `${at}.state.density`,
              ),
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
    check: (state, facts) => {
      if (!state.enabled) return featureAvailable;
      if (!facts.signedIn)
        return featureNotPossible(
          "definition_records_table_saved_views",
          "Saved views need people to be signed in on this page",
        );
      const defaults = new Set<string>();
      const ids = new Set<string>();
      for (const view of state.defaultViews) {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(view.viewId) ||
          ids.has(view.viewId)
        )
          return featureNotPossible(
            "definition_records_table_saved_views",
            "Every default view needs a unique identity.",
          );
        ids.add(view.viewId);
        if (view.isDefault && defaults.has(view.role))
          return featureNotPossible(
            "definition_records_table_saved_views",
            "Only one default view per role",
          );
        if (view.isDefault) defaults.add(view.role);
        for (const field of [
          ...view.document.columns,
          ...view.document.sort,
          ...view.document.filters,
        ])
          if (!facts.fields.some((candidate) => candidate.field === field.fieldId))
            return featureNotPossible(
              "definition_records_table_saved_views",
              `${view.name} uses ${facts.unselectedFields?.find((candidate) => candidate.field === field.fieldId)?.label ?? field.fieldId}, which is not in the bound query`,
            );
      }
      return featureAvailable;
    },
  };
