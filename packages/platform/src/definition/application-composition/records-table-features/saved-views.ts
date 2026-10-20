import type { GridViewDocument } from "../../../pages/grid-view-state";
import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  settingField,
  settingGroup,
  settingItems,
  settingOptionalChoice,
  settingText,
  type RecordsTableFeatureDefinition,
} from "./shared";

export type AuthoredGridView = Readonly<{
  viewId: string;
  name: string;
  /** A role key, or "*" for everyone who can open the application page. */
  role: string;
  isDefault: boolean;
  document: GridViewDocument;
}>;
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
      if (featureEnabled(group) !== true) return { enabled: false };
      const personalFormatting = group["personal_formatting"];
      if (personalFormatting?.kind !== "boolean") return undefined;
      const defaultViews: AuthoredGridView[] = [];
      for (const item of settingItems(group["default_views"]) ?? []) {
        const view = settingGroup(item);
        const state = settingGroup(view?.["state"]);
        const viewId = settingText(view?.["view_id"]);
        const name = settingText(view?.["name"]);
        const role = settingText(view?.["role"]);
        const isDefault = view?.["is_default"];
        const density = settingOptionalChoice(state?.["density"], [
          "comfortable",
          "compact",
        ] as const);
        if (
          view === undefined ||
          state === undefined ||
          viewId === undefined ||
          name === undefined ||
          role === undefined ||
          isDefault?.kind !== "boolean" ||
          density === undefined
        )
          return undefined;
        const columns: GridViewDocument["columns"] = [];
        for (const item of settingItems(state["columns"]) ?? []) {
          const column = settingGroup(item);
          const fieldId = settingField(column?.["field"]);
          const visible = column?.["visible"];
          const pin = settingOptionalChoice(column?.["pin"], ["start", "end", "unpinned"] as const);
          const width = column?.["width"];
          if (fieldId === undefined || visible?.kind !== "boolean" || pin === undefined)
            return undefined;
          columns.push({
            fieldId,
            visible: visible.value,
            pin,
            ...(width?.kind === "number" ? { width: width.value } : {}),
          });
        }
        const sort: NonNullable<GridViewDocument["sort"]> = [];
        for (const item of settingItems(state["sort"]) ?? []) {
          const entry = settingGroup(item);
          const fieldId = settingField(entry?.["field"]);
          const direction = settingOptionalChoice(entry?.["direction"], [
            "ascending",
            "descending",
          ] as const);
          if (fieldId === undefined || direction === undefined) return undefined;
          sort.push({ fieldId, direction });
        }
        const filters: NonNullable<GridViewDocument["filters"]> = [];
        for (const item of settingItems(state["filters"]) ?? []) {
          const entry = settingGroup(item);
          const fieldId = settingField(entry?.["field"]);
          const filter = settingText(entry?.["filter"]);
          if (fieldId === undefined || filter === undefined) return undefined;
          filters.push({ fieldId, filter });
        }
        const search = settingText(state["search"]);
        defaultViews.push({
          viewId,
          name,
          role,
          isDefault: isDefault.value,
          document: {
            columns,
            density,
            ...(sort.length === 0 ? {} : { sort }),
            ...(filters.length === 0 ? {} : { filters }),
            ...(search === undefined ? {} : { search }),
          },
        });
      }
      return {
        enabled: true,
        defaultViews,
        personalFormatting: personalFormatting.value,
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
          ...(view.document.sort ?? []),
          ...(view.document.filters ?? []),
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
